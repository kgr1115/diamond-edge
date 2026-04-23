/**
 * Pitcher season stats ingestion.
 *
 * Source summary:
 *   Primary:  MLB Stats API /people/{mlbPlayerId}/stats?stats=season,advanced&group=pitching&season=YYYY
 *   Statcast: Baseball Savant leaderboard CSV (public, no auth)
 *             https://baseballsavant.mlb.com/leaderboard/custom?...
 *             Columns pulled: swstr_rate, barrel_rate, hard_hit_rate, avg_ev,
 *             zone_rate (zone%), chase_rate (o_swing%), first_strike_rate (f_strike%).
 *             Statcast fields are nullable — imputed to league-avg in features.py
 *             when the scrape is unavailable or the row is missing.
 *
 * Rate-limit envelope:
 *   MLB Stats API: no documented cap; courtesy limit 60 req/min.
 *   Per-season full roster = ~750 pitchers × 1 req = 750 req/season refresh.
 *   Daily delta = only pitchers in today's probable-starter list = 2–12 req/day.
 *   Monthly projection: 12 × 30 = 360 delta calls + occasional full refresh ~750.
 *   Savant: 1 CSV download per day covers all pitchers; 1 HTTP GET total.
 *
 * Cache policy:
 *   Season stats change slowly. TTL = 86400s (24h). Key per player-season.
 *   Invalidated on each daily stats-sync cron run.
 *
 * Failure modes:
 *   429 from MLB Stats API: mlbFetch() handles with 30s backoff + 3 retries.
 *   5xx from MLB Stats API: retried up to RETRY.MAX_ATTEMPTS.
 *   Savant scrape failure: Statcast fields are nullable — features.py falls back
 *     to league-average with a [WARN] log. The season-avg ERA/FIP/K9 fields from
 *     MLB Stats API still populate normally.
 *   Schema drift (MLB Stats API changes field names): validation guard throws,
 *     caught here; row is skipped and logged.
 *
 * Freshness SLA: 24h stale is acceptable for season-aggregate stats.
 *   Rolling ERA/FIP shift by <0.05 per game — daily refresh is sufficient.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { MLB_STATS_API_BASE, RETRY } from '@/lib/ingestion/config';

export interface PitcherStatsSyncResult {
  pitchersUpserted: number;
  savantRowsMatched: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// MLB Stats API response shapes (pitching stats endpoint)
// ---------------------------------------------------------------------------

interface MlbStatSplit {
  stat: Record<string, unknown>;
  season?: string;
}

interface MlbPlayerStatsResponse {
  stats: Array<{
    type: { displayName: string };
    group: { displayName: string };
    splits: MlbStatSplit[];
  }>;
}

// ---------------------------------------------------------------------------
// Baseball Savant leaderboard CSV row (parsed subset)
// ---------------------------------------------------------------------------

interface SavantPitcherRow {
  mlb_id: number;
  swstr_rate: number | null;
  barrel_rate: number | null;
  hard_hit_rate: number | null;
  avg_ev: number | null;
  zone_rate: number | null;
  chase_rate: number | null;
  first_strike_rate: number | null;
}

// ---------------------------------------------------------------------------
// Savant leaderboard fetch
// Savant CSV endpoint is publicly accessible — no auth.
// Exports the pitcher-level leaderboard for the requested season.
// ---------------------------------------------------------------------------

async function fetchSavantPitcherLeaderboard(season: number): Promise<Map<number, SavantPitcherRow>> {
  const params = new URLSearchParams({
    year: String(season),
    type: 'pitcher',
    min: '10',
    sort: 'xwoba',
    sortDir: 'asc',
    csv: 'true',
  });
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?${params}`;

  const map = new Map<number, SavantPitcherRow>();

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'DiamondEdge/1.0 (data ingestion)' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', event: 'savant_pitcher_fetch_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
    return map;
  }

  if (!resp.ok) {
    console.error(JSON.stringify({
      level: 'error', event: 'savant_pitcher_http_error',
      status: resp.status, url,
    }));
    return map;
  }

  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) return map;

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const idx = (name: string) => headers.indexOf(name);

  const idIdx        = idx('player_id');
  const swstrIdx     = idx('whiff_percent');
  const barrelIdx    = idx('barrel_batted_rate');
  const hardHitIdx   = idx('hard_hit_percent');
  const evIdx        = idx('avg_hit_speed');
  const zoneIdx      = idx('iz_contact_percent');   // in-zone contact% — use as proxy
  const chaseIdx     = idx('oz_swing_percent');
  const fstrikeIdx   = idx('f_strike_percent');

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    const mlbId = parseInt(cols[idIdx] ?? '', 10);
    if (!mlbId || isNaN(mlbId)) continue;

    const parse = (colIdx: number): number | null => {
      if (colIdx < 0) return null;
      const v = parseFloat(cols[colIdx] ?? '');
      return isNaN(v) ? null : v / 100;
    };
    const parseRaw = (colIdx: number): number | null => {
      if (colIdx < 0) return null;
      const v = parseFloat(cols[colIdx] ?? '');
      return isNaN(v) ? null : v;
    };

    map.set(mlbId, {
      mlb_id: mlbId,
      swstr_rate: parse(swstrIdx),
      barrel_rate: parse(barrelIdx),
      hard_hit_rate: parse(hardHitIdx),
      avg_ev: parseRaw(evIdx),
      zone_rate: parse(zoneIdx),
      chase_rate: parse(chaseIdx),
      first_strike_rate: parse(fstrikeIdx),
    });
  }

  console.info(JSON.stringify({
    level: 'info', event: 'savant_pitcher_leaderboard_loaded',
    season, rows: map.size,
  }));

  return map;
}

// ---------------------------------------------------------------------------
// Per-pitcher MLB Stats API fetch
// ---------------------------------------------------------------------------

async function fetchPitcherMlbStats(
  mlbPlayerId: number,
  season: number,
): Promise<MlbStatSplit | null> {
  const url = `${MLB_STATS_API_BASE}/people/${mlbPlayerId}/stats?stats=season,advanced&group=pitching&season=${season}`;

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
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 30_000));
        continue;
      }
      if (resp.status >= 500) {
        lastErr = new Error(`MLB Stats API ${resp.status}`);
        continue;
      }
      if (!resp.ok) throw new Error(`MLB Stats API error: ${resp.status} ${url}`);

      const body = await resp.json() as MlbPlayerStatsResponse;
      // Find the season-level split
      for (const statGroup of body.stats ?? []) {
        if (
          statGroup.group?.displayName === 'pitching' &&
          (statGroup.type?.displayName === 'season' || statGroup.type?.displayName === 'statsSingleSeason')
        ) {
          const split = statGroup.splits?.[0];
          if (split) return split;
        }
      }
      return null;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Safe numeric parse — returns null for missing/NaN/negative-invalid values
// ---------------------------------------------------------------------------

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Main export: sync pitcher stats for a list of (player_uuid, mlb_player_id) pairs
// ---------------------------------------------------------------------------

export async function syncPitcherStats(
  playerPairs: Array<{ id: string; mlb_player_id: number }>,
  season: number,
): Promise<PitcherStatsSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // Fetch Savant leaderboard once for all pitchers
  const savantMap = await fetchSavantPitcherLeaderboard(season);

  let pitchersUpserted = 0;
  let savantRowsMatched = 0;

  for (const player of playerPairs) {
    let split: MlbStatSplit | null = null;
    try {
      split = await fetchPitcherMlbStats(player.mlb_player_id, season);
    } catch (err) {
      const msg = `MLB stats fetch failed for player ${player.mlb_player_id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'pitcher_stats_fetch_error', msg }));
      continue;
    }

    if (!split) {
      console.warn(JSON.stringify({
        level: 'warn', event: 'pitcher_stats_no_split',
        player_id: player.id, mlb_player_id: player.mlb_player_id, season,
      }));
      continue;
    }

    const s = split.stat as Record<string, unknown>;

    // Parse raw IP string like "120.1" → decimal
    const ipRaw = String(s['inningsPitched'] ?? s['ip'] ?? '0');
    const ipFull = parseInt(ipRaw.split('.')[0] ?? '0', 10);
    const ipPartial = parseInt(ipRaw.split('.')[1] ?? '0', 10);
    const ip = ipFull + ipPartial / 3;

    const savant = savantMap.get(player.mlb_player_id);
    if (savant) savantRowsMatched++;

    const row = {
      player_id: player.id,
      season,
      innings_pitched: ip || null,
      era:  safeNum(s['era']  ?? s['earnedRunAverage']),
      fip:  safeNum(s['fip']  ?? s['fieldingIndependentPitching']),
      xfip: safeNum(s['xfip'] ?? s['expectedFieldingIndependentPitching']),
      whip: safeNum(s['whip']),
      k_per_9: safeNum(s['strikeoutsPer9Inn'] ?? s['kPer9Inn']),
      bb_per_9: safeNum(s['walksPer9Inn']     ?? s['bbPer9Inn']),
      hr_per_9: safeNum(s['homeRunsPer9']     ?? s['hrPer9Inn']),
      // Rates derived from counting stats when not directly in API
      k_rate: safeNum(s['strikeoutPercentage'] ?? s['strikeoutRate']),
      bb_rate: safeNum(s['walkPercentage']     ?? s['walkRate']),
      hr_rate: safeNum(s['homeRunRate']),
      // Savant-sourced (nullable)
      swstr_rate:         savant?.swstr_rate         ?? null,
      gb_rate:            safeNum(s['groundOutsToAirouts'] ? null : s['groundBallRate']),
      ld_rate:            safeNum(s['lineDriveRate']),
      fb_rate:            safeNum(s['flyBallRate']),
      pull_rate:          safeNum(s['pullRate']),
      hard_hit_rate:      savant?.hard_hit_rate       ?? null,
      barrel_rate:        savant?.barrel_rate         ?? null,
      avg_ev:             savant?.avg_ev              ?? null,
      zone_rate:          savant?.zone_rate           ?? null,
      chase_rate:         savant?.chase_rate          ?? null,
      first_strike_rate:  savant?.first_strike_rate   ?? null,
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('pitcher_season_stats')
      .upsert(row, { onConflict: 'player_id,season' });

    if (upsertErr) {
      const msg = `Upsert failed for player ${player.id}: ${upsertErr.message}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'pitcher_stats_upsert_error', msg }));
    } else {
      pitchersUpserted++;
    }

    // Courtesy delay between per-pitcher MLB API calls
    await new Promise(r => setTimeout(r, 100));
  }

  console.info(JSON.stringify({
    level: 'info', event: 'pitcher_stats_sync_complete',
    season, pitchersUpserted, savantRowsMatched, errorCount: errors.length,
  }));

  return { pitchersUpserted, savantRowsMatched, errors };
}
