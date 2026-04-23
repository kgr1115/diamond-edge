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

  const scheduleResult = await syncSchedule(dates);

  // Invalidate schedule cache for synced dates
  if (scheduleResult.gamesUpserted > 0) {
    const cacheKeys = dates.map(d => CacheKeys.scheduleDate(d));
    await cacheInvalidate(...cacheKeys);
    console.info(
      JSON.stringify({
        level: 'info',
        event: 'cron_schedule_cache_invalidated',
        dates,
      })
    );
  }

  // Step 2: pull fresh odds for any games just synced.
  console.info(JSON.stringify({ level: 'info', event: 'cron_odds_refresh_start' }));
  const oddsResult = await runOddsPoll();

  if (oddsResult.rowsInserted > 0) {
    const today = new Date().toISOString().slice(0, 10);
    for (const tier of ['anon', 'free', 'pro', 'elite']) {
      await cacheInvalidate(CacheKeys.picksToday(today, tier));
    }
    const supabase = createServiceRoleClient();
    const { data: games } = await supabase
      .from('games')
      .select('id')
      .eq('game_date', today)
      .in('status', ['scheduled', 'live']);
    if (games?.length) {
      const oddsKeys = games.map(g => CacheKeys.oddsGame(g.id));
      await cacheInvalidate(...oddsKeys);
    }
  }

  // Step 3: pull RSS news sources for today's slate.
  // Bluesky is handled by the Supabase Edge Function (higher-frequency, pg_cron scheduled).
  console.info(JSON.stringify({ level: 'info', event: 'cron_news_poll_start' }));
  const newsResponse = await runNewsPoll();
  const newsResult = await newsResponse.json();

  const durationMs = Date.now() - startMs;
  const hadErrors =
    scheduleResult.errors.length > 0 ||
    oddsResult.errors.length > 0 ||
    (newsResult.errors?.length ?? 0) > 0;

  const logPayload = {
    level: hadErrors ? 'warn' : 'info',
    event: 'cron_schedule_sync_complete',
    durationMs,
    schedule: scheduleResult,
    odds: oddsResult,
    news: newsResult,
  };
  console.info(JSON.stringify(logPayload));

  return NextResponse.json({
    ok: !hadErrors,
    schedule: scheduleResult,
    odds: oddsResult,
    news: newsResult,
    durationMs,
  });
}
