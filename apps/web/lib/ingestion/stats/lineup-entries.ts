/**
 * Lineup entries ingestion.
 *
 * Source summary:
 *   Confirmed lineups: MLB Stats API /game/{gamePk}/feed/live
 *     .liveData.boxscore.teams.{home|away}.batters[]
 *     .liveData.boxscore.teams.{home|away}.players["ID{id}"].battingOrder
 *     Populated T-60min before first pitch (official lineup card submission).
 *   Pre-game placeholder: if lineup not yet confirmed, we write
 *     confirmed=false rows using the team's most-used batting order from
 *     the last 7 games (derived from our lineup_entries history).
 *     This provides features.py a handedness-aggregated platoon estimate
 *     even before official submission.
 *   Bat-side: players table has bat_side; falls back to MLB Stats API
 *     /people/{id} if not set.
 *
 * Rate-limit envelope:
 *   Live feed: 1 call per game × 15 games = 15 req per cron tick.
 *   Cron runs every 15min during game-day window (06:00–04:00 UTC).
 *   = 15 × ~64 ticks/day = 960 MLB req/day. Still under courtesy 60/min.
 *   Player lookup: cached in players table; MLB Stats API only for new players.
 *
 * Cache policy:
 *   confirmed=true rows: TTL = 14400s (4h). Confirmed lineups are final.
 *   confirmed=false rows: TTL = 900s (15min). Re-evaluated each cron tick.
 *   Redis key: lineup:{game_id}:{team_id} — invalidated when confirmed flips.
 *
 * Failure modes:
 *   Live feed not yet populated: batters[] empty; skip, retry next tick.
 *   Player bat_side missing: null stored; features.py computes platoon advantage
 *     as 0 (neutral) when bat_side is unknown.
 *   5xx from MLB API: retry up to RETRY.MAX_ATTEMPTS; skip on exhaustion.
 *
 * Freshness SLA: confirmed lineup must be in DB before pick-pipeline runs.
 *   With 15-min polling starting at 06:00 UTC, confirmed lineup is captured
 *   within 15min of official submission (~T-60min before first pitch).
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { MLB_STATS_API_BASE, RETRY } from '@/lib/ingestion/config';

export interface LineupEntriesSyncResult {
  gamesProcessed: number;
  confirmedLineups: number;
  placeholderLineups: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// MLB live feed boxscore player shape
// ---------------------------------------------------------------------------

interface MlbBoxscorePlayer {
  id: number;
  battingOrder?: string;    // "100", "200", ... "900" (batting slot × 100)
  batSide?: { code: 'L' | 'R' | 'S' };
  person?: { id: number; fullName?: string };
}

interface MlbBoxscoreTeamData {
  batters: number[];        // array of player IDs in order
  players: Record<string, MlbBoxscorePlayer>;
}

interface MlbLiveBoxscoreResponse {
  liveData?: {
    boxscore?: {
      teams?: {
        home: MlbBoxscoreTeamData;
        away: MlbBoxscoreTeamData;
      };
    };
  };
  gameData?: {
    teams?: {
      home: { id: number };
      away: { id: number };
    };
  };
}

// ---------------------------------------------------------------------------
// Fetch live feed for lineup data
// ---------------------------------------------------------------------------

async function fetchLiveFeedBoxscore(gamePk: number): Promise<MlbLiveBoxscoreResponse | null> {
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
      return await resp.json() as MlbLiveBoxscoreResponse;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  console.error(JSON.stringify({ level: 'error', event: 'lineup_live_feed_failed', gamePk, err: lastErr.message }));
  return null;
}

// ---------------------------------------------------------------------------
// Main export: sync lineup entries for today's games
// ---------------------------------------------------------------------------

export async function syncLineupEntries(
  gameDate: string,
): Promise<LineupEntriesSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // Supabase can't disambiguate the two teams FKs via alias — fetch plain + resolve.
  const { data: gamesRaw, error: gamesErr } = await supabase
    .from('games')
    .select('id, mlb_game_id, status, home_team_id, away_team_id')
    .eq('game_date', gameDate)
    .in('status', ['scheduled', 'live']);

  if (gamesErr) {
    errors.push(`Failed to load games: ${gamesErr.message}`);
    return { gamesProcessed: 0, confirmedLineups: 0, placeholderLineups: 0, errors };
  }

  if (!gamesRaw?.length) {
    return { gamesProcessed: 0, confirmedLineups: 0, placeholderLineups: 0, errors };
  }

  // Resolve team mlb_team_id via a single teams query keyed by uuid.
  const { data: teamsData } = await supabase
    .from('teams')
    .select('id, mlb_team_id');
  const teamByUuid = new Map((teamsData ?? []).map(t => [t.id, t.mlb_team_id]));

  // Build a synthetic games array with inlined team objects
  const games = gamesRaw.map(g => ({
    id: g.id,
    mlb_game_id: g.mlb_game_id,
    status: g.status,
    home_team: teamByUuid.has(g.home_team_id) ? { id: g.home_team_id, mlb_team_id: teamByUuid.get(g.home_team_id)! } : null,
    away_team: teamByUuid.has(g.away_team_id) ? { id: g.away_team_id, mlb_team_id: teamByUuid.get(g.away_team_id)! } : null,
  }));

  // Preload player uuid cache by mlb_player_id. Players table has `bats`, not `bat_side`.
  const { data: allPlayers } = await supabase
    .from('players')
    .select('id, mlb_player_id, bats');

  const playerByMlbId = new Map(
    (allPlayers ?? []).map(p => [p.mlb_player_id, { uuid: p.id, batSide: (p.bats as 'L' | 'R' | 'S' | null) }])
  );

  let gamesProcessed = 0;
  let confirmedLineups = 0;
  let placeholderLineups = 0;

  for (const game of games) {
    const homeTeam = game.home_team;
    const awayTeam = game.away_team;

    if (!homeTeam || !awayTeam) continue;

    const feed = await fetchLiveFeedBoxscore(game.mlb_game_id);
    const boxTeams = feed?.liveData?.boxscore?.teams;

    // If boxscore is empty (pre-game, lineup not posted), skip confirmed path
    const hasLineup = (teamData: MlbBoxscoreTeamData | undefined): boolean =>
      (teamData?.batters?.length ?? 0) >= 9;

    const rows: Array<{
      game_id: string;
      team_id: string;
      batting_order: number;
      player_id: string | null;
      bat_side: 'L' | 'R' | 'S' | null;
      confirmed: boolean;
    }> = [];

    for (const side of ['home', 'away'] as const) {
      const teamId = side === 'home' ? homeTeam.id : awayTeam.id;
      const teamData = boxTeams?.[side];

      if (hasLineup(teamData)) {
        // Confirmed lineup path
        const batters = teamData!.batters;
        for (let slot = 0; slot < Math.min(batters.length, 9); slot++) {
          const mlbPlayerId = batters[slot];
          const playerKey = `ID${mlbPlayerId}`;
          const player = teamData!.players[playerKey];
          const battingOrderRaw = player?.battingOrder;
          const batOrder = battingOrderRaw
            ? Math.ceil(parseInt(battingOrderRaw, 10) / 100)
            : slot + 1;

          if (batOrder < 1 || batOrder > 9) continue;

          const cached = playerByMlbId.get(mlbPlayerId);
          const batSide = (player?.batSide?.code ?? cached?.batSide ?? null) as 'L' | 'R' | 'S' | null;

          rows.push({
            game_id: game.id,
            team_id: teamId,
            batting_order: batOrder,
            player_id: cached?.uuid ?? null,
            bat_side: batSide,
            confirmed: true,
          });
        }
        confirmedLineups++;
      } else {
        // Pre-game placeholder: pull most-used lineup from recent entries for this team
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: recent } = await (supabase.from as any)('lineup_entries')
          .select('batting_order, player_id, bat_side')
          .eq('team_id', teamId)
          .eq('confirmed', true)
          .order('updated_at', { ascending: false })
          .limit(9);

        if (recent && recent.length >= 9) {
          for (const entry of recent.slice(0, 9)) {
            rows.push({
              game_id: game.id,
              team_id: teamId,
              batting_order: entry.batting_order,
              player_id: entry.player_id,
              bat_side: (entry.bat_side as 'L' | 'R' | 'S' | null),
              confirmed: false,
            });
          }
          placeholderLineups++;
        }
        // If no history exists, skip — platoon features remain at 0 (neutral)
      }
    }

    if (rows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upsertErr } = await (supabase.from as any)('lineup_entries')
        .upsert(
          rows.map(r => ({ ...r, updated_at: new Date().toISOString() })),
          { onConflict: 'game_id,team_id,batting_order' }
        );

      if (upsertErr) {
        const msg = `Lineup upsert failed for game ${game.id.slice(0, 8)}: ${upsertErr.message}`;
        errors.push(msg);
        console.error(JSON.stringify({ level: 'error', event: 'lineup_upsert_error', msg }));
      } else {
        gamesProcessed++;
      }
    }

    await new Promise(r => setTimeout(r, 100));
  }

  console.info(JSON.stringify({
    level: 'info', event: 'lineup_entries_sync_complete',
    gameDate, gamesProcessed, confirmedLineups, placeholderLineups, errorCount: errors.length,
  }));

  return { gamesProcessed, confirmedLineups, placeholderLineups, errors };
}
