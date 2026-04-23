import { NextRequest, NextResponse } from 'next/server';
import { runOddsPoll } from '@/lib/ingestion/odds/poll';
import { cacheInvalidate, CacheKeys } from '@/lib/redis/cache';
import { createServiceRoleClient } from '@/lib/supabase/server';

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

  const startMs = Date.now();
  console.info(
    JSON.stringify({ level: 'info', event: 'cron_odds_refresh_start', time: new Date().toISOString() })
  );

  // Run the poll cycle
  const result = await runOddsPoll();

  // Invalidate Redis odds cache for all games updated this run
  // We invalidate all today's games by pattern since we don't track which game IDs changed
  if (result.rowsInserted > 0) {
    const today = new Date().toISOString().slice(0, 10);
    // Invalidate the today's picks cache (odds feed into pick display)
    for (const tier of ['anon', 'free', 'pro', 'elite']) {
      await cacheInvalidate(CacheKeys.picksToday(today, tier));
    }

    // Invalidate per-game odds cache
    // We need the game IDs — fetch today's games to get UUIDs for cache invalidation
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
  }

  const durationMs = Date.now() - startMs;

  const logPayload = {
    level: result.errors.length > 0 ? 'warn' : 'info',
    event: 'cron_odds_refresh_complete',
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
