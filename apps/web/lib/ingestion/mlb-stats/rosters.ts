/**
 * Full roster + team sync — runs once daily.
 *
 * Upserts all 30 MLB teams with complete metadata, then upserts all active roster
 * players for every team. This is the authoritative source for teams.division,
 * teams.league, and player position/handedness.
 *
 * Because roster sync is a heavyweight daily job (~31 API calls: 1 teams + 30 rosters),
 * it runs as a Supabase Edge Function on a daily schedule rather than Vercel Cron.
 * (Edge Functions support longer timeouts; 30 sequential roster calls can take ~10s.)
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { fetchTeams, fetchRoster } from './client';
import type { MlbTeamFull, MlbRosterEntry } from './client';
import { VENUE_STATES } from '@/lib/ingestion/weather/stadiums';
import type { Database } from '@/lib/types/database';

type TeamInsertRow = Database['public']['Tables']['teams']['Insert'];
type PlayerInsertRow = Database['public']['Tables']['players']['Insert'];

export interface RosterSyncResult {
  teamsUpserted: number;
  playersUpserted: number;
  errors: string[];
}

/**
 * Sync all MLB teams and their active rosters.
 * Safe to run multiple times — all operations are upserts.
 */
export async function syncRosters(): Promise<RosterSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // ------------------------------------------------------------------
  // 1. Fetch all teams
  // ------------------------------------------------------------------
  let mlbTeams: MlbTeamFull[];
  try {
    mlbTeams = await fetchTeams();
  } catch (err) {
    errors.push(`Teams fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { teamsUpserted: 0, playersUpserted: 0, errors };
  }

  // Filter to active MLB teams only (excludes minor league affiliates returned by API)
  const activeTeams = mlbTeams.filter(t => t.active);

  // ------------------------------------------------------------------
  // 2. Upsert teams
  // ------------------------------------------------------------------
  const teamRows: TeamInsertRow[] = activeTeams.map(t => buildTeamRow(t));

  const { error: teamUpsertError } = await supabase
    .from('teams')
    .upsert(teamRows, { onConflict: 'mlb_team_id' });

  if (teamUpsertError) {
    errors.push(`Teams upsert failed: ${teamUpsertError.message}`);
    // Don't abort — we can still try rosters with potentially stale team data
  }

  // Fetch back team ID map (mlb_team_id → our UUID)
  const { data: teamIdRows } = await supabase
    .from('teams')
    .select('id, mlb_team_id')
    .in('mlb_team_id', activeTeams.map(t => t.id));

  const teamIdMap = new Map<number, string>(
    (teamIdRows ?? []).map(t => [t.mlb_team_id, t.id])
  );

  // ------------------------------------------------------------------
  // 3. Upsert rosters for each team
  //    Sequential with a 200ms delay between teams to be polite.
  // ------------------------------------------------------------------
  let totalPlayersUpserted = 0;

  for (const team of activeTeams) {
    try {
      const roster = await fetchRoster(team.id);
      const teamUuid = teamIdMap.get(team.id);

      if (!teamUuid) {
        errors.push(`No UUID for team ${team.name} (${team.id}) — skipping roster`);
        continue;
      }

      const playerRows = roster.map(entry =>
        buildPlayerRow(entry, teamUuid)
      );

      if (playerRows.length === 0) continue;

      const { error: playerError } = await supabase
        .from('players')
        .upsert(playerRows, { onConflict: 'mlb_player_id' });

      if (playerError) {
        errors.push(`Roster upsert for ${team.name}: ${playerError.message}`);
      } else {
        totalPlayersUpserted += playerRows.length;
      }
    } catch (err) {
      errors.push(
        `Roster fetch for ${team.name} (${team.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Polite throttle: 200ms between teams ≈ 6 req/s, well under courtesy limit
    await sleep(200);
  }

  // ------------------------------------------------------------------
  // 4. Mark players not in any current roster as inactive
  //    (Handles mid-season releases/retirements)
  // ------------------------------------------------------------------
  const allCurrentMlbPlayerIds: number[] = [];
  // Re-fetch all rosters for active player IDs would require another round of calls;
  // instead, trust that the upserts above set active=true for all current roster members.
  // A separate nightly DFA/waiver-wire pass can set active=false for absent players.
  // Skipping this step in v1 to avoid 30 additional API calls in this run.

  console.info(
    JSON.stringify({
      level: 'info',
      event: 'roster_sync_complete',
      teamsProcessed: activeTeams.length,
      playersUpserted: totalPlayersUpserted,
      errors: errors.length,
    })
  );

  return {
    teamsUpserted: teamRows.length,
    playersUpserted: totalPlayersUpserted,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function buildTeamRow(team: MlbTeamFull): TeamInsertRow {
  const league = normalizeLeague(team.league.abbreviation);
  const venueName = team.venue.name;

  return {
    mlb_team_id: team.id,
    name: team.name,
    abbreviation: team.abbreviation,
    city: team.locationName,
    division: team.division.name,
    league,
    venue_name: venueName,
    venue_city: team.locationName,
    venue_state: VENUE_STATES[venueName] ?? null,
    updated_at: new Date().toISOString(),
  };
}

function buildPlayerRow(entry: MlbRosterEntry, teamUuid: string): PlayerInsertRow {
  const bats = validateHandedness(entry.person.batSide?.code);
  const throws_ = validateThrows(entry.person.pitchHand?.code);

  return {
    mlb_player_id: entry.person.id,
    full_name: entry.person.fullName,
    position: entry.position.abbreviation,
    bats,
    throws: throws_,
    team_id: teamUuid,
    active: true,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeLeague(abbrev: string): 'AL' | 'NL' {
  if (abbrev === 'AL') return 'AL';
  if (abbrev === 'NL') return 'NL';
  return 'AL'; // fallback; should never hit in practice
}

function validateHandedness(code?: string): 'L' | 'R' | 'S' | null {
  if (code === 'L' || code === 'R' || code === 'S') return code;
  return null;
}

function validateThrows(code?: string): 'L' | 'R' | null {
  if (code === 'L' || code === 'R') return code;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
