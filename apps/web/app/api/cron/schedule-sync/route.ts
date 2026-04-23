import { NextRequest, NextResponse } from 'next/server';
import { syncSchedule } from '@/lib/ingestion/mlb-stats/schedule';
import { cacheInvalidate, CacheKeys } from '@/lib/redis/cache';

export const runtime = 'nodejs';
export const maxDuration = 10;

/**
 * Vercel Cron handler: GET /api/cron/schedule-sync
 * Scheduled: 6am ET + 1pm ET daily.
 *
 * Syncs today + tomorrow's schedule so picks pipeline and odds matching
 * always have fresh game rows in the DB.
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

  const result = await syncSchedule(dates);

  // Invalidate schedule cache for synced dates
  if (result.gamesUpserted > 0) {
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

  const durationMs = Date.now() - startMs;

  const logPayload = {
    level: result.errors.length > 0 ? 'warn' : 'info',
    event: 'cron_schedule_sync_complete',
    durationMs,
    ...result,
  };
  console.info(JSON.stringify(logPayload));

  return NextResponse.json({
    ok: result.errors.length === 0,
    ...result,
    durationMs,
  });
}
