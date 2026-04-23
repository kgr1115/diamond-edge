/**
 * Schedule sync — upserts today + tomorrow games into the `games` table.
 *
 * Flow:
 * 1. Fetch schedule from MLB Stats API (with weather + probable pitcher hydration).
 * 2. For each game, resolve team UUIDs from our DB (by mlb_team_id).
 *    If a team is missing, create a minimal record so the FK is valid.
 * 3. Resolve probable pitcher UUIDs similarly.
 * 4. Upsert game rows (ON CONFLICT mlb_game_id).
 * 5. Parse weather from the MLB API response (available same-day for most games).
 *    Tomorrow's games that lack weather data will be filled later by the weather client.
 *
 * Freshness SLA: runs 2× per day via Vercel Cron. Games table is at most ~12h stale
 * for schedule metadata; odds freshness is governed by the separate odds-refresh cron.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { fetchSchedule } from './client';
import type { MlbScheduleGame } from './client';
import { VENUE_STATES } from '@/lib/ingestion/weather/stadiums';
import type { Database, GameStatus } from '@/lib/types/database';

type GameInsertRow = Database['public']['Tables']['games']['Insert'];

export interface ScheduleSyncResult {
  dates: string[];
  gamesUpserted: number;
  teamsResolved: number;
  pitchersResolved: number;
  errors: string[];
}

/**
 * Sync schedule for the given UTC dates ('YYYY-MM-DD').
 * Typically called with [today, tomorrow] from the cron handler.
 */
export async function syncSchedule(dates: string[]): Promise<ScheduleSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // ------------------------------------------------------------------
  // 1. Fetch from MLB Stats API
  // ------------------------------------------------------------------
  let scheduleResponse;
  try {
    scheduleResponse = await fetchSchedule(dates);
  } catch (err) {
    errors.push(`MLB schedule fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { dates, gamesUpserted: 0, teamsResolved: 0, pitchersResolved: 0, errors };
  }

  const allGames = scheduleResponse.dates.flatMap(d => d.games);
  if (allGames.length === 0) {
    console.info(
      JSON.stringify({ level: 'info', event: 'schedule_sync_no_games', dates })
    );
    return { dates, gamesUpserted: 0, teamsResolved: 0, pitchersResolved: 0, errors };
  }

  // ------------------------------------------------------------------
  // 2. Build team ID cache (mlb_team_id → our UUID)
  // Fetch all teams once; batch resolves within this sync run.
  // ------------------------------------------------------------------
  const mlbTeamIds = [
    ...new Set(allGames.flatMap(g => [g.teams.home.team.id, g.teams.away.team.id])),
  ];

  const { data: existingTeams } = await supabase
    .from('teams')
    .select('id, mlb_team_id')
    .in('mlb_team_id', mlbTeamIds);

  const teamIdCache = new Map<number, string>(
    (existingTeams ?? []).map(t => [t.mlb_team_id, t.id])
  );

  let teamsResolved = 0;

  // Resolve any missing teams (creates minimal stub records)
  for (const game of allGames) {
    for (const side of ['home', 'away'] as const) {
      const teamRef = game.teams[side].team;
      if (!teamIdCache.has(teamRef.id)) {
        const teamId = await resolveTeam(teamRef, supabase, errors);
        if (teamId) {
          teamIdCache.set(teamRef.id, teamId);
          teamsResolved++;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 3. Build pitcher ID cache (mlb_player_id → our UUID)
  // ------------------------------------------------------------------
  const pitcherIdCache = new Map<number, string>();
  let pitchersResolved = 0;

  // Collect all unique probable pitcher IDs from today's schedule
  const pitcherRefs: Array<{ id: number; fullName: string; teamId?: string }> = [];
  for (const game of allGames) {
    for (const side of ['home', 'away'] as const) {
      const pitcher = game.teams[side].probablePitcher;
      if (pitcher) {
        pitcherRefs.push({
          id: pitcher.id,
          fullName: pitcher.fullName,
          teamId: teamIdCache.get(game.teams[side].team.id),
        });
      }
    }
  }

  if (pitcherRefs.length > 0) {
    const mlbPitcherIds = [...new Set(pitcherRefs.map(p => p.id))];
    const { data: existingPitchers } = await supabase
      .from('players')
      .select('id, mlb_player_id')
      .in('mlb_player_id', mlbPitcherIds);

    (existingPitchers ?? []).forEach(p => pitcherIdCache.set(p.mlb_player_id, p.id));

    for (const p of pitcherRefs) {
      if (!pitcherIdCache.has(p.id)) {
        const playerId = await resolvePitcher(p, supabase, errors);
        if (playerId) {
          pitcherIdCache.set(p.id, playerId);
          pitchersResolved++;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 4. Build game rows and upsert
  // ------------------------------------------------------------------
  const gameRows: GameInsertRow[] = [];

  for (const game of allGames) {
    const homeTeamId = teamIdCache.get(game.teams.home.team.id);
    const awayTeamId = teamIdCache.get(game.teams.away.team.id);

    if (!homeTeamId || !awayTeamId) {
      errors.push(
        `Skipping game ${game.gamePk}: could not resolve team IDs ` +
        `(home: ${game.teams.home.team.id}, away: ${game.teams.away.team.id})`
      );
      continue;
    }

    // MLB API omits gameDate on TBD doubleheader slots — skip rather than crash
    if (!game.gameDate) {
      errors.push(`Skipping game ${game.gamePk}: missing gameDate`);
      continue;
    }

    const gameDate = game.gameDate.slice(0, 10); // 'YYYY-MM-DD' from UTC ISO string
    const venueName = game.venue.name;
    const venueState = VENUE_STATES[venueName] ?? null;
    const weather = parseWeather(game);

    const row: GameInsertRow = {
      mlb_game_id: game.gamePk,
      game_date: gameDate,
      game_time_utc: game.gameDate, // ISO 8601 UTC — no conversion needed
      status: mapGameStatus(game.status),
      home_team_id: homeTeamId,
      away_team_id: awayTeamId,
      home_score: game.teams.home.score ?? game.linescore?.teams?.home?.runs ?? null,
      away_score: game.teams.away.score ?? game.linescore?.teams?.away?.runs ?? null,
      inning: game.linescore?.currentInning ?? null,
      venue_name: venueName,
      venue_state: venueState,
      weather_condition: weather?.condition ?? null,
      weather_temp_f: weather?.temp_f ?? null,
      weather_wind_mph: weather?.wind_mph ?? null,
      weather_wind_dir: weather?.wind_dir ?? null,
      probable_home_pitcher_id:
        game.teams.home.probablePitcher
          ? (pitcherIdCache.get(game.teams.home.probablePitcher.id) ?? null)
          : null,
      probable_away_pitcher_id:
        game.teams.away.probablePitcher
          ? (pitcherIdCache.get(game.teams.away.probablePitcher.id) ?? null)
          : null,
      updated_at: new Date().toISOString(),
    };

    gameRows.push(row);
  }

  if (gameRows.length === 0) {
    return { dates, gamesUpserted: 0, teamsResolved, pitchersResolved, errors };
  }

  const { error: upsertError } = await supabase
    .from('games')
    .upsert(gameRows, { onConflict: 'mlb_game_id' });

  if (upsertError) {
    errors.push(`Games upsert failed: ${upsertError.message}`);
    return { dates, gamesUpserted: 0, teamsResolved, pitchersResolved, errors };
  }

  return {
    dates,
    gamesUpserted: gameRows.length,
    teamsResolved,
    pitchersResolved,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function mapGameStatus(status: MlbScheduleGame['status']): GameStatus {
  const { abstractGameState, detailedState } = status;

  if (detailedState === 'Postponed') return 'postponed';
  if (detailedState === 'Cancelled' || detailedState === 'Canceled') return 'cancelled';
  if (abstractGameState === 'Final') return 'final';
  if (abstractGameState === 'Live') return 'live';
  return 'scheduled';
}

// ---------------------------------------------------------------------------
// Weather parsing from MLB Stats API schedule hydration
// ---------------------------------------------------------------------------

interface ParsedWeather {
  condition: string | null;
  temp_f: number | null;
  wind_mph: number | null;
  wind_dir: string | null;
}

function parseWeather(game: MlbScheduleGame): ParsedWeather | null {
  const w = game.weather;
  if (!w) return null;

  const temp_f = w.temp ? parseInt(w.temp, 10) : null;

  // Wind format: "10 mph, Out To CF"  or "0 mph, Calm"
  const windMatch = w.wind?.match(/^(\d+)\s*mph,?\s*(.*)/i);
  const wind_mph = windMatch ? parseInt(windMatch[1], 10) : null;
  const wind_dir = windMatch ? (windMatch[2]?.trim() || null) : null;

  return {
    condition: w.condition?.toLowerCase() ?? null,
    temp_f: isNaN(temp_f ?? NaN) ? null : temp_f,
    wind_mph: isNaN(wind_mph ?? NaN) ? null : wind_mph,
    wind_dir,
  };
}

// ---------------------------------------------------------------------------
// Team resolution (create stub if missing)
// ---------------------------------------------------------------------------

async function resolveTeam(
  teamRef: { id: number; name?: string; abbreviation?: string },
  supabase: ReturnType<typeof createServiceRoleClient>,
  errors: string[]
): Promise<string | null> {
  // MLB API occasionally omits name for TBD/unknown team slots
  const safeName = teamRef.name ?? '';

  // Parse city from name (e.g., "New York" from "New York Yankees")
  const parts = safeName.split(' ');
  const city = parts.length > 1 ? parts.slice(0, -1).join(' ') : safeName;

  const { data, error } = await supabase
    .from('teams')
    .upsert(
      {
        mlb_team_id: teamRef.id,
        name: safeName,
        // Use 3-char abbreviation if available; fall back to first 3 of team name
        abbreviation: (teamRef.abbreviation ?? safeName.slice(0, 3) ?? 'UNK').toUpperCase(),
        city,
        division: 'Unknown',   // Roster sync will correct this
        league: 'AL' as const, // Roster sync will correct this
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'mlb_team_id' }
    )
    .select('id')
    .single();

  if (error) {
    errors.push(`Failed to resolve team ${teamRef.name} (${teamRef.id}): ${error.message}`);
    return null;
  }

  return data?.id ?? null;
}

// ---------------------------------------------------------------------------
// Pitcher resolution (create stub if missing)
// ---------------------------------------------------------------------------

async function resolvePitcher(
  pitcher: { id: number; fullName: string; teamId?: string },
  supabase: ReturnType<typeof createServiceRoleClient>,
  errors: string[]
): Promise<string | null> {
  const { data, error } = await supabase
    .from('players')
    .upsert(
      {
        mlb_player_id: pitcher.id,
        full_name: pitcher.fullName,
        position: 'SP', // Probable starter — assume SP; roster sync corrects
        team_id: pitcher.teamId ?? null,
        active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'mlb_player_id' }
    )
    .select('id')
    .single();

  if (error) {
    errors.push(`Failed to resolve pitcher ${pitcher.fullName} (${pitcher.id}): ${error.message}`);
    return null;
  }

  return data?.id ?? null;
}
