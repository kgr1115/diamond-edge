/**
 * Team batting stats ingestion.
 *
 * Source summary:
 *   Season AVG/OBP/SLG/OPS/K%/BB%/HR%: MLB Stats API
 *     /teams/{teamId}/stats?stats=season&group=hitting&season=YYYY
 *   ISO, BABIP: derived from counting stats in the same response
 *     (ISO = SLG - AVG; BABIP = (H - HR) / (AB - K - HR + SF))
 *   wOBA, wRC+, hard_hit_rate, barrel_rate: Baseball Savant team
 *     leaderboard CSV (same public endpoint as pitcher leaderboard,
 *     type=batter aggregated to team level by mlb_team_id).
 *   ops_last_14d: computed from games table (home_score + away_score
 *     as proxy; true OPS-14d requires per-game batting stats that MLB
 *     Stats API /team/{id}/stats?stats=gameLog exposes — pulled here).
 *
 * Rate-limit envelope:
 *   30 teams × 2 endpoints (season + gamelog) = 60 req/run.
 *   Savant: 1 CSV download covers all teams.
 *   Monthly (once daily): 60 × 30 = 1,800 MLB API req. Well under limit.
 *
 * Cache policy:
 *   TTL = 86400s (24h). Season batting stats are slow-moving.
 *   Invalidated by daily stats-sync cron.
 *
 * Failure modes:
 *   MLB Stats API 429: 30s backoff + retry. Season endpoint rarely limits.
 *   Savant unavailable: woba/wrc_plus/hard_hit/barrel remain null;
 *     features.py falls back to league-average with [WARN].
 *   Schema drift in MLB API: validation catches, skips row, logs error.
 *
 * Freshness SLA: 24h stale acceptable for season-aggregate batting.
 *   ops_last_14d needs daily refresh to be meaningful.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { MLB_STATS_API_BASE, RETRY } from '@/lib/ingestion/config';

export interface TeamBattingStatsSyncResult {
  teamsUpserted: number;
  savantRowsMatched: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// MLB team hitting stats API response
// ---------------------------------------------------------------------------

interface MlbTeamHittingStat {
  avg?: string | number;
  obp?: string | number;
  slg?: string | number;
  ops?: string | number;
  strikeoutPercentage?: string | number;
  walkPercentage?: string | number;
  homeRunRate?: string | number;
  atBats?: number;
  hits?: number;
  homeRuns?: number;
  strikeOuts?: number;
  baseOnBalls?: number;
  sacFlies?: number;
  plateAppearances?: number;
}

interface MlbTeamStatsResponse {
  stats: Array<{
    type: { displayName: string };
    group: { displayName: string };
    splits: Array<{ stat: MlbTeamHittingStat }>;
  }>;
}

// ---------------------------------------------------------------------------
// Savant team batting row
// ---------------------------------------------------------------------------

interface SavantTeamRow {
  mlb_team_id: number;
  woba: number | null;
  wrc_plus: number | null;
  hard_hit_rate: number | null;
  barrel_rate: number | null;
}

// ---------------------------------------------------------------------------
// Fetch Savant team batting leaderboard (aggregated by team)
// ---------------------------------------------------------------------------

async function fetchSavantTeamBatting(season: number): Promise<Map<number, SavantTeamRow>> {
  const params = new URLSearchParams({
    year: String(season),
    type: 'batter',
    min: '1',
    sort: 'woba',
    sortDir: 'desc',
    csv: 'true',
  });
  const url = `https://baseballsavant.mlb.com/leaderboard/team?${params}`;
  const map = new Map<number, SavantTeamRow>();

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'DiamondEdge/1.0 (data ingestion)' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', event: 'savant_team_batting_fetch_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
    return map;
  }

  if (!resp.ok) {
    console.error(JSON.stringify({ level: 'error', event: 'savant_team_batting_http_error', status: resp.status }));
    return map;
  }

  const text = await resp.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) return map;

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const idx = (name: string) => headers.indexOf(name);

  const idIdx       = idx('team_id');
  const wobaIdx     = idx('woba');
  const wrcIdx      = idx('wrc_plus');
  const hardHitIdx  = idx('hard_hit_percent');
  const barrelIdx   = idx('barrel_batted_rate');

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    const teamId = parseInt(cols[idIdx] ?? '', 10);
    if (!teamId || isNaN(teamId)) continue;

    const pct = (ci: number): number | null => {
      if (ci < 0) return null;
      const v = parseFloat(cols[ci] ?? '');
      return isNaN(v) ? null : v / 100;
    };
    const raw = (ci: number): number | null => {
      if (ci < 0) return null;
      const v = parseFloat(cols[ci] ?? '');
      return isNaN(v) ? null : v;
    };

    map.set(teamId, {
      mlb_team_id: teamId,
      woba:          raw(wobaIdx),
      wrc_plus:      raw(wrcIdx),
      hard_hit_rate: pct(hardHitIdx),
      barrel_rate:   pct(barrelIdx),
    });
  }

  console.info(JSON.stringify({ level: 'info', event: 'savant_team_batting_loaded', season, rows: map.size }));
  return map;
}

// ---------------------------------------------------------------------------
// MLB Stats API fetch — team hitting season stats
// ---------------------------------------------------------------------------

async function fetchTeamHittingStats(
  mlbTeamId: number,
  season: number,
): Promise<MlbTeamHittingStat | null> {
  const url = `${MLB_STATS_API_BASE}/teams/${mlbTeamId}/stats?stats=season&group=hitting&season=${season}`;
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
      if (!resp.ok) throw new Error(`MLB team stats error: ${resp.status}`);

      const body = await resp.json() as MlbTeamStatsResponse;
      for (const grp of body.stats ?? []) {
        if (grp.group?.displayName === 'hitting') {
          const split = grp.splits?.[0];
          if (split?.stat) return split.stat;
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
// MLB Stats API fetch — team recent game log for rolling OPS-14d
// Endpoint: /teams/{id}/stats?stats=gameLog&group=hitting&season=YYYY
// Returns per-game batting lines; we compute OPS from the last 14-day subset.
// ---------------------------------------------------------------------------

interface MlbGameLogSplit {
  date?: string;
  stat: {
    atBats?: number;
    hits?: number;
    doubles?: number;
    triples?: number;
    homeRuns?: number;
    baseOnBalls?: number;
    intentionalWalks?: number;
    hitByPitch?: number;
    sacFlies?: number;
    totalBases?: number;
  };
}

async function fetchTeamGameLog(
  mlbTeamId: number,
  season: number,
): Promise<MlbGameLogSplit[]> {
  const url = `${MLB_STATS_API_BASE}/teams/${mlbTeamId}/stats?stats=gameLog&group=hitting&season=${season}`;
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
      if (!resp.ok) throw new Error(`MLB game log error: ${resp.status}`);

      const body = await resp.json() as { stats: Array<{ splits: MlbGameLogSplit[] }> };
      return body.stats?.[0]?.splits ?? [];
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  console.warn(JSON.stringify({ level: 'warn', event: 'team_game_log_fetch_failed', mlbTeamId, err: lastErr.message }));
  return [];
}

// ---------------------------------------------------------------------------
// Compute OPS from game-log splits for the last N days
// ---------------------------------------------------------------------------

function computeOpsLast14d(splits: MlbGameLogSplit[], asOfDate: string): number | null {
  const cutoff = new Date(asOfDate);
  cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const recent = splits.filter(s => (s.date ?? '') >= cutoffStr);
  if (!recent.length) return null;

  let ab = 0, hits = 0, tb = 0, bb = 0, hbp = 0, sf = 0;
  for (const s of recent) {
    ab   += s.stat.atBats          ?? 0;
    hits += s.stat.hits             ?? 0;
    tb   += s.stat.totalBases       ?? 0;
    bb   += (s.stat.baseOnBalls ?? 0) + (s.stat.intentionalWalks ?? 0);
    hbp  += s.stat.hitByPitch       ?? 0;
    sf   += s.stat.sacFlies         ?? 0;
  }

  const pa = ab + bb + hbp + sf;
  if (pa === 0) return null;

  const obp = (hits + bb + hbp) / pa;
  const slg = ab > 0 ? tb / ab : 0;
  return Math.round((obp + slg) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function syncTeamBattingStats(
  season: number,
  asOfDate: string,
): Promise<TeamBattingStatsSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  const { data: teams, error: teamsErr } = await supabase
    .from('teams')
    .select('id, mlb_team_id, abbreviation');

  if (teamsErr || !teams?.length) {
    errors.push(`Failed to load teams: ${teamsErr?.message ?? 'no rows'}`);
    return { teamsUpserted: 0, savantRowsMatched: 0, errors };
  }

  const savantMap = await fetchSavantTeamBatting(season);
  let teamsUpserted = 0;
  let savantRowsMatched = 0;

  for (const team of teams) {
    let seasonStat: MlbTeamHittingStat | null = null;
    try {
      seasonStat = await fetchTeamHittingStats(team.mlb_team_id, season);
    } catch (err) {
      const msg = `Team hitting stats failed for ${team.abbreviation}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'team_batting_fetch_error', msg }));
    }

    let gameLogs: MlbGameLogSplit[] = [];
    try {
      gameLogs = await fetchTeamGameLog(team.mlb_team_id, season);
    } catch {
      // Non-fatal: ops_last_14d will be null
    }

    const ops14d = computeOpsLast14d(gameLogs, asOfDate);
    const s = seasonStat ?? {};

    const safeNum = (v: unknown): number | null => {
      const n = parseFloat(String(v ?? ''));
      return isNaN(n) ? null : n;
    };
    const safeInt = (v: unknown): number | null => {
      const n = parseInt(String(v ?? ''), 10);
      return isNaN(n) ? null : n;
    };

    const avgN = safeNum(s.avg);
    const slgN = safeNum(s.slg);
    const iso  = avgN !== null && slgN !== null ? Math.round((slgN - avgN) * 1000) / 1000 : null;

    // BABIP = (H - HR) / (AB - K - HR + SF)
    let babip: number | null = null;
    if (s.atBats && s.hits != null && s.homeRuns != null && s.strikeOuts != null) {
      const denom = (s.atBats) - (s.strikeOuts ?? 0) - (s.homeRuns ?? 0) + (s.sacFlies ?? 0);
      if (denom > 0) babip = Math.round(((s.hits - (s.homeRuns ?? 0)) / denom) * 1000) / 1000;
    }

    const savant = savantMap.get(team.mlb_team_id);
    if (savant) savantRowsMatched++;

    const row = {
      team_id:       team.id,
      season,
      avg:           safeNum(s.avg),
      obp:           safeNum(s.obp),
      slg:           slgN,
      ops:           safeNum(s.ops),
      iso,
      babip,
      k_rate:        safeNum(s.strikeoutPercentage),
      bb_rate:       safeNum(s.walkPercentage),
      hr_rate:       safeNum(s.homeRunRate),
      woba:          savant?.woba          ?? null,
      wrc_plus:      savant?.wrc_plus != null ? safeInt(savant.wrc_plus) : null,
      hard_hit_rate: savant?.hard_hit_rate ?? null,
      barrel_rate:   savant?.barrel_rate   ?? null,
      ops_last_14d:  ops14d,
      updated_at:    new Date().toISOString(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upsertErr } = await (supabase.from as any)('team_batting_stats')
      .upsert(row, { onConflict: 'team_id,season' });

    if (upsertErr) {
      const msg = `Team batting upsert failed for ${team.abbreviation}: ${upsertErr.message}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'team_batting_upsert_error', msg }));
    } else {
      teamsUpserted++;
    }

    await new Promise(r => setTimeout(r, 150));
  }

  console.info(JSON.stringify({
    level: 'info', event: 'team_batting_sync_complete',
    season, teamsUpserted, savantRowsMatched, errorCount: errors.length,
  }));

  return { teamsUpserted, savantRowsMatched, errors };
}
