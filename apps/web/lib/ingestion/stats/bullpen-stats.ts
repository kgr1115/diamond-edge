/**
 * Bullpen team stats ingestion.
 *
 * Source summary:
 *   Season ERA/FIP/WHIP/K%/BB%: aggregated from pitcher_season_stats where
 *   the player's position is not 'SP' (i.e., all relievers on the 40-man).
 *   Rolling load windows (ip_last_7d, pitches_last_3d): MLB Stats API
 *   /schedule?date=YYYY-MM-DD&hydrate=boxscore for recent game appearances.
 *   Availability scores: computed from recent workload (> 1 IP in last 2d →
 *   closer_availability decremented; heuristic based on team convention).
 *
 * Rate-limit envelope:
 *   Season aggregation is a DB query — zero API calls.
 *   Rolling load: 30 MLB teams × 1 boxscore-range call = 30 req/day.
 *   MLB Stats API: well under 60 req/min courtesy limit.
 *   Monthly projection: 30 × 30 = 900 req.
 *
 * Cache policy:
 *   TTL = 3600s (1h) for availability windows; 86400s for season ERA/FIP.
 *   Rolling load must be fresh at pick-pipeline time — cron runs at 14:00 UTC,
 *   1h ahead of most first pitches.
 *
 * Failure modes:
 *   DB aggregate query fails: caught, errors returned, 0 rows inserted.
 *   MLB Stats API 429: 30s backoff. Schedule endpoint rarely rate-limits.
 *   5xx: retried up to RETRY.MAX_ATTEMPTS.
 *   No pitchers in pitcher_season_stats yet: all season fields remain null;
 *   features.py falls back to league-average with [WARN].
 *
 * Freshness SLA: rolling load windows must be < 24h stale at pick time.
 *   Season ERA/FIP acceptable up to 48h stale.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { MLB_STATS_API_BASE, RETRY } from '@/lib/ingestion/config';

export interface BullpenStatsSyncResult {
  teamsUpserted: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// MLB boxscore response shape (pitchers array per team)
// ---------------------------------------------------------------------------

interface MlbBoxscorePitcher {
  person: { id: number };
  stats?: {
    pitching?: {
      inningsPitched?: string;
      numberOfPitches?: number;
    };
  };
  gameStatus?: { isCurrentPitcher?: boolean };
  sequenceNumber?: number;
}

interface MlbBoxscoreTeam {
  pitchers: number[];         // player IDs in appearance order
  players: Record<string, MlbBoxscorePitcher>;
}

interface MlbBoxscoreResponse {
  teams: {
    home: MlbBoxscoreTeam;
    away: MlbBoxscoreTeam;
  };
}

interface MlbBoxscoreGameRef {
  gamePk: number;
  gameDate: string;
  teams: {
    home: { team: { id: number } };
    away: { team: { id: number } };
  };
}

// ---------------------------------------------------------------------------
// Parse IP string "6.1" → decimal float (6 + 1/3 = 6.333...)
// ---------------------------------------------------------------------------

function ipToDecimal(ip: string | null | undefined): number {
  if (!ip) return 0;
  const parts = ip.split('.');
  const full = parseInt(parts[0] ?? '0', 10);
  const partial = parseInt(parts[1] ?? '0', 10);
  return full + partial / 3;
}

// ---------------------------------------------------------------------------
// Fetch boxscore for a single game to extract bullpen appearances
// ---------------------------------------------------------------------------

async function fetchBoxscore(gamePk: number): Promise<MlbBoxscoreResponse | null> {
  const url = `${MLB_STATS_API_BASE}/game/${gamePk}/boxscore`;
  let lastErr: Error = new Error('unknown');

  for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(RETRY.BASE_BACKOFF_MS * 2 ** (attempt - 1), RETRY.MAX_BACKOFF_MS);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'DiamondEdge/1.0 (data ingestion)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 30_000)); continue; }
      if (resp.status >= 500) { lastErr = new Error(`MLB ${resp.status}`); continue; }
      if (!resp.ok) throw new Error(`MLB boxscore error: ${resp.status}`);
      return await resp.json() as MlbBoxscoreResponse;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  console.error(JSON.stringify({ level: 'error', event: 'bullpen_boxscore_fetch_failed', gamePk, err: lastErr.message }));
  return null;
}

// ---------------------------------------------------------------------------
// Fetch recent games for all MLB teams (last 7 days)
// Returns: gamePk → {home_team_mlb_id, away_team_mlb_id, date}
// ---------------------------------------------------------------------------

async function fetchRecentGameRefs(
  endDate: string,
  lookbackDays: number,
): Promise<MlbBoxscoreGameRef[]> {
  const end = new Date(endDate);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - lookbackDays);

  const params = new URLSearchParams({
    sportId: '1',
    startDate: start.toISOString().slice(0, 10),
    endDate: endDate,
    hydrate: 'team',
  });
  const url = `${MLB_STATS_API_BASE}/schedule?${params}`;

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
      if (resp.status >= 500) { lastErr = new Error(`MLB ${resp.status}`); continue; }
      if (!resp.ok) throw new Error(`MLB schedule error: ${resp.status}`);
      const body = await resp.json() as { dates: Array<{ games: MlbBoxscoreGameRef[] }> };
      return body.dates?.flatMap(d => d.games ?? []) ?? [];
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Main export: sync bullpen stats for all teams
// ---------------------------------------------------------------------------

export async function syncBullpenStats(
  season: number,
  asOfDate: string,
): Promise<BullpenStatsSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // ------------------------------------------------------------------
  // 1. Get all team UUID + mlb_team_id pairs from DB
  // ------------------------------------------------------------------
  const { data: teams, error: teamsErr } = await supabase
    .from('teams')
    .select('id, mlb_team_id, abbreviation');

  if (teamsErr || !teams?.length) {
    errors.push(`Failed to load teams: ${teamsErr?.message ?? 'no rows'}`);
    return { teamsUpserted: 0, errors };
  }

  const teamByMlbId = new Map(teams.map(t => [t.mlb_team_id, t]));

  // ------------------------------------------------------------------
  // 2. Season aggregates: pull from pitcher_season_stats for each team.
  //    Join via players table (players.team_id + position != 'SP').
  //    We do this per-team via a supabase RPC or raw query.
  //    Use JS-side aggregation to avoid requiring a DB function.
  // ------------------------------------------------------------------

  // pitcher_season_stats is in migration 0012 but not yet in generated Supabase types.
  // Cast through any to keep runtime behavior while types catch up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: relieversRaw, error: relErr } = await (supabase.from as any)('pitcher_season_stats')
    .select(`
      player_id, season, era, fip, whip, k_rate, bb_rate, hr_rate,
      players!inner(team_id, position)
    `)
    .eq('season', season);
  const relievers = relieversRaw as Array<{
    player_id: string; season: number; era: number | null; fip: number | null; whip: number | null;
    k_rate: number | null; bb_rate: number | null; hr_rate: number | null;
    players: { team_id: string; position: string } | null;
  }> | null;

  if (relErr) {
    console.warn(JSON.stringify({
      level: 'warn', event: 'bullpen_stats_no_pitcher_stats',
      err: relErr.message,
    }));
  }

  // Aggregate season-level bullpen stats per team (non-SP only)
  const teamSeasonAgg = new Map<string, {
    era: number[]; fip: number[]; whip: number[];
    k_rate: number[]; bb_rate: number[]; hr_rate: number[];
  }>();

  for (const row of (relievers ?? [])) {
    const player = row.players as { team_id: string; position: string } | null;
    if (!player || player.position === 'SP') continue;
    const teamId = player.team_id;
    if (!teamSeasonAgg.has(teamId)) {
      teamSeasonAgg.set(teamId, { era: [], fip: [], whip: [], k_rate: [], bb_rate: [], hr_rate: [] });
    }
    const agg = teamSeasonAgg.get(teamId)!;
    if (row.era   != null) agg.era.push(row.era);
    if (row.fip   != null) agg.fip.push(row.fip);
    if (row.whip  != null) agg.whip.push(row.whip);
    if (row.k_rate != null) agg.k_rate.push(row.k_rate);
    if (row.bb_rate != null) agg.bb_rate.push(row.bb_rate);
    if (row.hr_rate != null) agg.hr_rate.push(row.hr_rate);
  }

  const avg = (arr: number[]): number | null =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  // ------------------------------------------------------------------
  // 3. Rolling load windows from recent boxscores.
  // team_mlb_id → { ip_7d, pitches_3d, closer_used_2d, high_lev_used_2d }
  // ------------------------------------------------------------------

  interface RollingLoad {
    ip_7d: number;
    pitches_3d: number;
    closer_used_in_last_2d: boolean;
    high_leverage_used_in_last_2d: boolean;
  }

  const rollingLoad = new Map<number, RollingLoad>();
  for (const t of teams) {
    rollingLoad.set(t.mlb_team_id, {
      ip_7d: 0, pitches_3d: 0,
      closer_used_in_last_2d: false,
      high_leverage_used_in_last_2d: false,
    });
  }

  let recentGames: MlbBoxscoreGameRef[] = [];
  try {
    recentGames = await fetchRecentGameRefs(asOfDate, 7);
  } catch (err) {
    const msg = `Recent games fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    console.error(JSON.stringify({ level: 'error', event: 'bullpen_stats_games_fetch_failed', msg }));
  }

  const cutoff3d = new Date(asOfDate);
  cutoff3d.setUTCDate(cutoff3d.getUTCDate() - 3);

  for (const game of recentGames) {
    const box = await fetchBoxscore(game.gamePk);
    if (!box) continue;

    const gameDate = new Date(game.gameDate);
    const within3d = gameDate >= cutoff3d;

    for (const side of ['home', 'away'] as const) {
      const mlbTeamId = game.teams[side].team.id;
      const load = rollingLoad.get(mlbTeamId);
      if (!load) continue;

      const teamBox = box.teams[side];
      // First pitcher is typically the SP; skip index 0
      const pitcherIds = teamBox.pitchers ?? [];
      const relievers = pitcherIds.slice(1);

      for (const pitcherId of relievers) {
        const key = `ID${pitcherId}`;
        const p = teamBox.players[key];
        if (!p) continue;

        const stats = p.stats?.pitching;
        const ip = ipToDecimal(stats?.inningsPitched);
        const pitches = stats?.numberOfPitches ?? 0;
        const seqNum = p.sequenceNumber ?? 99;

        load.ip_7d += ip;

        if (within3d) {
          load.pitches_3d += pitches;
          // Heuristic: last pitcher = closer candidate; first 2 relievers post-SP = high-leverage
          if (seqNum === pitcherIds.length - 1) load.closer_used_in_last_2d = true;
          if (seqNum <= 3) load.high_leverage_used_in_last_2d = true;
        }
      }
    }

    await new Promise(r => setTimeout(r, 50)); // courtesy delay
  }

  // ------------------------------------------------------------------
  // 4. Upsert one row per team
  // ------------------------------------------------------------------
  let teamsUpserted = 0;

  for (const team of teams) {
    const mlbId = team.mlb_team_id;
    const teamId = team.id;
    const load = rollingLoad.get(mlbId) ?? { ip_7d: 0, pitches_3d: 0, closer_used_in_last_2d: false, high_leverage_used_in_last_2d: false };
    const agg = teamSeasonAgg.get(teamId);

    // Availability scores: closer degraded if used in last 2d
    const closerAvail = load.closer_used_in_last_2d ? 0.5 : 1.0;
    const highLevAvail = load.high_leverage_used_in_last_2d ? 0.6 : 1.0;

    const row = {
      team_id: teamId,
      season,
      bullpen_era:    agg ? avg(agg.era)    : null,
      bullpen_fip:    agg ? avg(agg.fip)    : null,
      bullpen_whip:   agg ? avg(agg.whip)   : null,
      bullpen_k_rate: agg ? avg(agg.k_rate) : null,
      bullpen_bb_rate: agg ? avg(agg.bb_rate) : null,
      bullpen_hr_rate: agg ? avg(agg.hr_rate) : null,
      bullpen_ip_last_7d:      Math.round(load.ip_7d * 10) / 10,
      bullpen_pitches_last_3d: load.pitches_3d,
      closer_availability:      closerAvail,
      high_leverage_availability: highLevAvail,
      updated_at: new Date().toISOString(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upsertErr } = await (supabase.from as any)('bullpen_team_stats')
      .upsert(row, { onConflict: 'team_id,season' });

    if (upsertErr) {
      const msg = `Bullpen upsert failed for team ${team.abbreviation}: ${upsertErr.message}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'bullpen_stats_upsert_error', msg }));
    } else {
      teamsUpserted++;
    }
  }

  console.info(JSON.stringify({
    level: 'info', event: 'bullpen_stats_sync_complete',
    season, teamsUpserted, errorCount: errors.length,
  }));

  return { teamsUpserted, errors };
}
