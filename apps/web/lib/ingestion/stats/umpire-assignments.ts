/**
 * Umpire assignment ingestion.
 *
 * Source summary:
 *   Game assignment: MLB Stats API /game/{gamePk}/feed/live
 *     .liveData.boxscore.officials[] where officialType = 'Home Plate'
 *     Populated T-90min before first pitch (sometimes T-60min).
 *   Umpire performance stats (ump_k_rate, ump_bb_rate, ump_strike_zone_size):
 *     UmpScorecards.com public JSON API:
 *       https://umpscorecards.com/api/umpires/{umpireName}/
 *     Returns career and current-season averages. Hit once per unique ump name.
 *     Fallback: if UmpScorecards is unreachable, stats remain null and
 *     features.py imputes league-average (UMP_K_RATE_CAREER_DEFAULT = 0.218).
 *
 * Rate-limit envelope:
 *   MLB live feed: 1 call per game × ~15 games/day = 15 req/day.
 *   UmpScorecards: 1 per unique ump name per day; ~20 unique umps/day active.
 *   Monthly: 15×30=450 MLB + 20×30=600 UmpScorecards = ~1,050 req total.
 *   No documented limits on either; UmpScorecards is a hobbyist API — stay <100/day.
 *
 * Cache policy:
 *   Umpire assignments: TTL = 1800s (30min). Set during T-2h window.
 *   Umpire career stats: TTL = 604800s (7 days). Career stats are stable.
 *   Invalidated by lineup-sync cron (runs every 15min during game-day window).
 *
 * Failure modes:
 *   Live feed 404/empty: officials array not yet populated; skip, retry next cron.
 *   UmpScorecards 5xx/unavailable: ump stats remain null; features.py imputes.
 *   Live feed schema drift: guard catches, logs, skips game.
 *
 * Freshness SLA: assignment must be confirmed before pick-pipeline runs (16:00 UTC).
 *   15-min polling cron during game-day window covers this comfortably.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { MLB_STATS_API_BASE, RETRY } from '@/lib/ingestion/config';

export interface UmpireAssignmentsSyncResult {
  gamesUpdated: number;
  umpireStatsResolved: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// MLB live feed response shape (officials array)
// ---------------------------------------------------------------------------

interface MlbOfficial {
  official: { fullName: string };
  officialType: string;   // 'Home Plate', '1st Base', '2nd Base', '3rd Base'
}

interface MlbLiveFeedResponse {
  liveData?: {
    boxscore?: {
      officials?: MlbOfficial[];
    };
  };
}

// ---------------------------------------------------------------------------
// UmpScorecards API response
// ---------------------------------------------------------------------------

interface UmpScorecardsUmpire {
  umpire_name?: string;
  career_k_pct?: number;    // fraction e.g. 0.218
  career_bb_pct?: number;
  zone_size?: number;        // relative e.g. 1.02
}

// ---------------------------------------------------------------------------
// Fetch HP umpire name from MLB live feed
// ---------------------------------------------------------------------------

async function fetchHpUmpireName(gamePk: number): Promise<string | null> {
  const url = `${MLB_STATS_API_BASE}/game/${gamePk}/feed/live`;
  let lastErr: Error = new Error('unknown');

  for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(RETRY.BASE_BACKOFF_MS * 2 ** (attempt - 1), RETRY.MAX_BACKOFF_MS);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'DiamondEdge/1.0 (data ingestion)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 30_000)); continue; }
      if (resp.status === 404) return null;
      if (resp.status >= 500) { lastErr = new Error(`MLB ${resp.status}`); continue; }
      if (!resp.ok) throw new Error(`MLB live feed error: ${resp.status}`);

      const body = await resp.json() as MlbLiveFeedResponse;
      const officials = body.liveData?.boxscore?.officials ?? [];
      const hp = officials.find(o => o.officialType === 'Home Plate');
      return hp?.official?.fullName ?? null;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  console.warn(JSON.stringify({ level: 'warn', event: 'umpire_live_feed_failed', gamePk, err: lastErr.message }));
  return null;
}

// ---------------------------------------------------------------------------
// Fetch umpire career stats from UmpScorecards
// ---------------------------------------------------------------------------

async function fetchUmpireStats(
  umpireName: string,
): Promise<{ k_rate: number | null; bb_rate: number | null; zone_size: number | null }> {
  const encoded = encodeURIComponent(umpireName);
  const url = `https://umpscorecards.com/api/umpires/${encoded}/`;

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'DiamondEdge/1.0 (data ingestion)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.warn(JSON.stringify({
        level: 'warn', event: 'umpscorecards_http_error',
        umpireName, status: resp.status,
      }));
      return { k_rate: null, bb_rate: null, zone_size: null };
    }

    const body = await resp.json() as UmpScorecardsUmpire;
    return {
      k_rate:    body.career_k_pct ?? null,
      bb_rate:   body.career_bb_pct ?? null,
      zone_size: body.zone_size ?? null,
    };
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn', event: 'umpscorecards_fetch_failed',
      umpireName, err: err instanceof Error ? err.message : String(err),
    }));
    return { k_rate: null, bb_rate: null, zone_size: null };
  }
}

// ---------------------------------------------------------------------------
// Main export: sync umpire assignments for today's games
// ---------------------------------------------------------------------------

export async function syncUmpireAssignments(
  gameDate: string,
): Promise<UmpireAssignmentsSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // Fetch today's scheduled/live games
  const { data: games, error: gamesErr } = await supabase
    .from('games')
    .select('id, mlb_game_id')
    .eq('game_date', gameDate)
    .in('status', ['scheduled', 'live']);

  if (gamesErr) {
    errors.push(`Failed to load games: ${gamesErr.message}`);
    return { gamesUpdated: 0, umpireStatsResolved: 0, errors };
  }

  if (!games?.length) {
    return { gamesUpdated: 0, umpireStatsResolved: 0, errors };
  }

  // Cache umpire stats per name within this run to avoid duplicate UmpScorecards calls
  const umpireStatsCache = new Map<string, {
    k_rate: number | null; bb_rate: number | null; zone_size: number | null;
  }>();

  let gamesUpdated = 0;
  let umpireStatsResolved = 0;

  for (const game of games) {
    const umpName = await fetchHpUmpireName(game.mlb_game_id);

    if (!umpName) {
      console.info(JSON.stringify({
        level: 'info', event: 'umpire_not_assigned_yet',
        game_id: game.id.slice(0, 8), mlb_game_id: game.mlb_game_id,
      }));
      continue;
    }

    // Fetch umpire career stats (cached per run)
    let umpStats = umpireStatsCache.get(umpName);
    if (!umpStats) {
      umpStats = await fetchUmpireStats(umpName);
      umpireStatsCache.set(umpName, umpStats);
      if (umpStats.k_rate !== null) umpireStatsResolved++;
    }

    const row = {
      game_id: game.id,
      home_plate_umpire_name: umpName,
      ump_k_rate:           umpStats.k_rate,
      ump_bb_rate:          umpStats.bb_rate,
      ump_strike_zone_size: umpStats.zone_size,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('umpire_assignments')
      .upsert(row, { onConflict: 'game_id' });

    if (upsertErr) {
      const msg = `Umpire upsert failed for game ${game.id.slice(0, 8)}: ${upsertErr.message}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'umpire_upsert_error', msg }));
    } else {
      gamesUpdated++;
      console.info(JSON.stringify({
        level: 'info', event: 'umpire_assignment_saved',
        game_id: game.id.slice(0, 8), ump: umpName,
        k_rate: umpStats.k_rate, zone_size: umpStats.zone_size,
      }));
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.info(JSON.stringify({
    level: 'info', event: 'umpire_assignments_sync_complete',
    gameDate, gamesUpdated, umpireStatsResolved, errorCount: errors.length,
  }));

  return { gamesUpdated, umpireStatsResolved, errors };
}
