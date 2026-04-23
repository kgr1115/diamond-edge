import { NextRequest, NextResponse } from 'next/server';
import { syncSchedule } from '@/lib/ingestion/mlb-stats/schedule';
import { runOddsPoll } from '@/lib/ingestion/odds/poll';
import { cacheInvalidate, CacheKeys } from '@/lib/redis/cache';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Vercel Cron handler: GET /api/cron/schedule-sync
 * Scheduled: 10am ET daily (14:00 UTC).
 *
 * For Vercel Hobby's 2-cron limit, this endpoint does double duty: first syncs
 * today + tomorrow's MLB schedule from MLB Stats API, then pulls fresh odds
 * from The Odds API for the games just synced. The subsequent pick-pipeline
 * cron (12pm ET) reads from both tables.
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

  const durationMs = Date.now() - startMs;
  const hadErrors = scheduleResult.errors.length > 0 || oddsResult.errors.length > 0;

  const logPayload = {
    level: hadErrors ? 'warn' : 'info',
    event: 'cron_schedule_sync_complete',
    durationMs,
    schedule: scheduleResult,
    odds: oddsResult,
  };
  console.info(JSON.stringify(logPayload));

  return NextResponse.json({
    ok: !hadErrors,
    schedule: scheduleResult,
    odds: oddsResult,
    durationMs,
  });
}
