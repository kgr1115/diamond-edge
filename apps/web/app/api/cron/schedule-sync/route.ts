import { NextRequest, NextResponse } from 'next/server';
import { syncSchedule } from '@/lib/ingestion/mlb-stats/schedule';
import { runOddsPoll } from '@/lib/ingestion/odds/poll';
import { cacheInvalidate, CacheKeys } from '@/lib/redis/cache';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { runNewsPoll } from '@/lib/ingestion/news/poll';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Vercel Cron handler: GET /api/cron/schedule-sync
 * Scheduled: 10am ET daily (14:00 UTC).
 *
 * For Vercel Hobby's 2-cron limit, this endpoint does triple duty:
 * 1. Syncs today + tomorrow's MLB schedule from MLB Stats API.
 * 2. Pulls fresh odds from The Odds API for the games just synced.
 * 3. Pulls RSS news sources (MLB.com, ESPN, RotoBaller) for today's slate.
 *
 * The subsequent pick-pipeline cron (12pm ET) reads from all three tables.
 *
 * Bluesky polling (5-min cadence) is handled separately by a Supabase Edge
 * Function triggered via pg_cron — see ADR-002 §Recommended cron strategy.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/schedule-sync' })
    );
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  const startMs = Date.now();
  console.info(
    JSON.stringify({ level: 'info', event: 'cron_schedule_sync_start', time: new Date().toISOString() })
  );

  // Build today + tomorrow dates in UTC
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  const tomorrowDate = new Date(now);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrowUTC = tomorrowDate.toISOString().slice(0, 10);

  const dates = [todayUTC, tomorrowUTC];

  // ---------------------------------------------------------------------------
  // Stage 1: MLB schedule sync
  // ---------------------------------------------------------------------------
  let scheduleResult: { ok: boolean; gamesUpserted?: number; errors: string[] };
  const scheduleStageStart = Date.now();
  try {
    const result = await syncSchedule(dates);
    scheduleResult = { ok: result.errors.length === 0, ...result };
    console.info(JSON.stringify({
      level: 'info',
      event: 'cron_schedule_sync_stage',
      ok: scheduleResult.ok,
      gamesUpserted: result.gamesUpserted,
      ms: Date.now() - scheduleStageStart,
    }));

    if (result.gamesUpserted > 0) {
      const cacheKeys = dates.map(d => CacheKeys.scheduleDate(d));
      await cacheInvalidate(...cacheKeys).catch((err) => {
        console.warn(JSON.stringify({ level: 'warn', event: 'cron_schedule_cache_invalidate_failed', error: String(err) }));
      });
      console.info(JSON.stringify({ level: 'info', event: 'cron_schedule_cache_invalidated', dates }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'cron_schedule_sync_stage', ok: false, error: msg, ms: Date.now() - scheduleStageStart }));
    scheduleResult = { ok: false, errors: [msg] };
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Odds API poll
  // ---------------------------------------------------------------------------
  let oddsResult: { ok: boolean; rowsInserted?: number; errors: string[] };
  const oddsStageStart = Date.now();
  try {
    console.info(JSON.stringify({ level: 'info', event: 'cron_odds_refresh_start' }));
    const result = await runOddsPoll();
    oddsResult = { ok: result.errors.length === 0, ...result };
    console.info(JSON.stringify({
      level: 'info',
      event: 'cron_odds_refresh_stage',
      ok: oddsResult.ok,
      rowsInserted: result.rowsInserted,
      ms: Date.now() - oddsStageStart,
    }));

    if (result.rowsInserted > 0) {
      const today = new Date().toISOString().slice(0, 10);
      for (const tier of ['anon', 'free', 'pro', 'elite']) {
        await cacheInvalidate(CacheKeys.picksToday(today, tier)).catch(() => {});
      }
      const supabase = createServiceRoleClient();
      const { data: games } = await supabase
        .from('games')
        .select('id')
        .eq('game_date', today)
        .in('status', ['scheduled', 'live']);
      if (games?.length) {
        const oddsKeys = games.map(g => CacheKeys.oddsGame(g.id));
        await cacheInvalidate(...oddsKeys).catch(() => {});
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'cron_odds_refresh_stage', ok: false, error: msg, ms: Date.now() - oddsStageStart }));
    oddsResult = { ok: false, errors: [msg] };
  }

  // ---------------------------------------------------------------------------
  // Stage 3: RSS news poll
  // Bluesky is handled by the Supabase Edge Function (higher-frequency, pg_cron scheduled).
  // ---------------------------------------------------------------------------
  let newsResult: { ok: boolean; errors: string[]; [key: string]: unknown };
  const newsStageStart = Date.now();
  try {
    console.info(JSON.stringify({ level: 'info', event: 'cron_news_poll_start' }));
    const newsResponse = await runNewsPoll();
    // runNewsPoll returns a NextResponse — extract the JSON body without re-fetching
    const newsBody = await newsResponse.json();
    newsResult = {
      ok: (newsBody.errors?.length ?? 0) === 0 && !newsBody.sources?.some((s: { errors: string[] }) => s.errors.length > 0),
      ...newsBody,
    };
    console.info(JSON.stringify({
      level: 'info',
      event: 'cron_news_poll_stage',
      ok: newsResult.ok,
      totalInserted: newsBody.totalInserted,
      ms: Date.now() - newsStageStart,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'cron_news_poll_stage', ok: false, error: msg, ms: Date.now() - newsStageStart }));
    newsResult = { ok: false, errors: [msg] };
  }

  const durationMs = Date.now() - startMs;
  const hadErrors = !scheduleResult.ok || !oddsResult.ok || !newsResult.ok;

  console.info(JSON.stringify({
    level: hadErrors ? 'warn' : 'info',
    event: 'cron_schedule_sync_complete',
    durationMs,
    schedule: { ok: scheduleResult.ok, errors: scheduleResult.errors },
    odds: { ok: oddsResult.ok, errors: oddsResult.errors },
    news: { ok: newsResult.ok, errors: newsResult.errors },
  }));

  // 207 Multi-Status when any stage had errors; 200 when all succeeded
  return NextResponse.json(
    {
      schedule: { ok: scheduleResult.ok, errors: scheduleResult.errors },
      odds: { ok: oddsResult.ok, errors: oddsResult.errors },
      news: { ok: newsResult.ok, errors: newsResult.errors },
      durationMs,
    },
    { status: hadErrors ? 207 : 200 },
  );
}
