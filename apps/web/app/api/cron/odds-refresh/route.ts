import { NextRequest, NextResponse } from 'next/server';
import { runOddsPoll } from '@/lib/ingestion/odds/poll';
import { cacheInvalidate, CacheKeys } from '@/lib/redis/cache';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const maxDuration = 10;

/**
 * Vercel Cron handler: POST /api/cron/odds-refresh
 * Scheduled: every 30 min between 8am-11pm ET + midnight-3am ET (covers all games).
 *
 * Security: CRON_SECRET header required — set in Vercel env vars.
 * Vercel Cron automatically adds Authorization: Bearer <CRON_SECRET>.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/odds-refresh' })
    );
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  const runHandle = await startCronRun('odds-refresh');
  const startMs = Date.now();
  console.info(
    JSON.stringify({ level: 'info', event: 'cron_odds_refresh_start', time: new Date().toISOString() })
  );

  // ---------------------------------------------------------------------------
  // Stage 1: Odds poll
  // ---------------------------------------------------------------------------
  let pollResult: { ok: boolean; rowsInserted: number; errors: string[]; [key: string]: unknown };
  const pollStageStart = Date.now();
  try {
    const result = await runOddsPoll();
    pollResult = { ok: result.errors.length === 0, ...result };
    console.info(JSON.stringify({
      level: 'info',
      event: 'cron_odds_poll_stage',
      ok: pollResult.ok,
      rowsInserted: result.rowsInserted,
      ms: Date.now() - pollStageStart,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'cron_odds_poll_stage', ok: false, error: msg, ms: Date.now() - pollStageStart }));
    const durationMs = Date.now() - startMs;
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json(
      { odds: { ok: false, errors: [msg] }, durationMs },
      { status: 207 },
    );
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Redis cache invalidation (non-fatal)
  // ---------------------------------------------------------------------------
  if (pollResult.rowsInserted > 0) {
    const today = new Date().toISOString().slice(0, 10);
    try {
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
        console.info(
          JSON.stringify({ level: 'info', event: 'cron_odds_cache_invalidated', count: oddsKeys.length })
        );
      }
    } catch (err) {
      // Cache invalidation failures are non-fatal — stale cache expires on TTL.
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'cron_odds_cache_invalidate_failed',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const durationMs = Date.now() - startMs;

  console.info(JSON.stringify({
    level: pollResult.ok ? 'info' : 'warn',
    event: 'cron_odds_refresh_complete',
    durationMs,
    ...pollResult,
  }));

  await finishCronRun(runHandle, {
    status: pollResult.ok ? 'success' : 'failure',
    errorMsg: pollResult.ok ? null : pollResult.errors.join(' | '),
  });

  return NextResponse.json(
    {
      odds: { ok: pollResult.ok, errors: pollResult.errors },
      durationMs,
    },
    { status: pollResult.ok ? 200 : 207 },
  );
}
