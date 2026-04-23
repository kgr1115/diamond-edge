/**
 * MLB Stats API client — typed fetch wrapper.
 *
 * Source: https://statsapi.mlb.com/api/v1  (free, public, no auth required)
 * No hard rate limit is documented; stay under 60 req/min as a courtesy.
 *
 * All timestamps returned by the MLB Stats API are UTC (ISO 8601 with Z suffix)
 * and are stored as-is — no timezone conversion needed here.
 */

import { MLB_STATS_API_BASE, RETRY } from '@/lib/ingestion/config';

// ---------------------------------------------------------------------------
// Schedule types
// ---------------------------------------------------------------------------

export interface MlbGameStatus {
  abstractGameState: 'Preview' | 'Live' | 'Final';
  detailedState: string;   // 'Scheduled', 'In Progress', 'Final', 'Postponed', etc.
  statusCode: string;      // 'S', 'I', 'F', 'DR', 'PW', etc.
}

export interface MlbTeamRef {
  id: number;
  name: string;
  abbreviation?: string;
}

export interface MlbProbablePitcher {
  id: number;
  fullName: string;
}

export interface MlbScheduleTeamEntry {
  team: MlbTeamRef;
  score?: number;
  isWinner?: boolean;
  probablePitcher?: MlbProbablePitcher;
}

export interface MlbVenue {
  id: number;
  name: string;
}

export interface MlbWeather {
  condition: string;  // 'Clear', 'Cloudy', 'Overcast', 'Drizzle', 'Rain', etc.
  temp: string;       // numeric string, Fahrenheit, e.g. '72'
  wind: string;       // e.g. '10 mph, Out To CF' or '0 mph, Calm'
}

export interface MlbLinescore {
  currentInning?: number;
  currentInningOrdinal?: string;
  teams?: {
    home?: { runs?: number };
    away?: { runs?: number };
  };
}

export interface MlbScheduleGame {
  gamePk: number;
  gameDate: string;       // ISO 8601 UTC, e.g. '2026-04-22T23:10:00Z'
  officialDate?: string;  // 'YYYY-MM-DD' local date (less reliable — use UTC)
  status: MlbGameStatus;
  teams: {
    home: MlbScheduleTeamEntry;
    away: MlbScheduleTeamEntry;
  };
  venue: MlbVenue;
  weather?: MlbWeather;
  linescore?: MlbLinescore;
  isTie?: boolean;
  gameNumber?: number;     // 1 or 2 for doubleheaders
  doubleHeader?: string;   // 'Y' | 'N' | 'S'
}

export interface MlbScheduleDate {
  date: string;    // 'YYYY-MM-DD'
  games: MlbScheduleGame[];
}

export interface MlbScheduleResponse {
  dates: MlbScheduleDate[];
}

// ---------------------------------------------------------------------------
// Teams types
// ---------------------------------------------------------------------------

export interface MlbTeamDivision {
  name: string;        // 'American League East'
  abbreviation?: string;
}

export interface MlbTeamLeague {
  name: string;        // 'American League' | 'National League'
  abbreviation: string; // 'AL' | 'NL'
}

export interface MlbTeamFull {
  id: number;
  name: string;
  abbreviation: string;
  teamName: string;         // short name, e.g. 'Yankees'
  locationName: string;     // city, e.g. 'New York'
  firstYearOfPlay?: string;
  division: MlbTeamDivision;
  league: MlbTeamLeague;
  venue: MlbVenue;
  active: boolean;
}

export interface MlbTeamsResponse {
  teams: MlbTeamFull[];
}

// ---------------------------------------------------------------------------
// Roster types
// ---------------------------------------------------------------------------

export interface MlbPerson {
  id: number;
  fullName: string;
  primaryPosition?: { abbreviation: string };
  batSide?: { code: 'L' | 'R' | 'S' };
  pitchHand?: { code: 'L' | 'R' };
}

export interface MlbRosterEntry {
  person: MlbPerson;
  position: { abbreviation: string };
  jerseyNumber?: string;
}

export interface MlbRosterResponse {
  roster: MlbRosterEntry[];
}

// ---------------------------------------------------------------------------
// Box score types (linescore endpoint)
// ---------------------------------------------------------------------------

export interface MlbLinescoreResponse {
  currentInning?: number;
  teams: {
    home: { runs: number; hits: number; errors: number };
    away: { runs: number; hits: number; errors: number };
  };
}

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

export interface ScheduleFetchOptions {
  /** Hydration fields: 'team,venue,probablePitcher(note),weather,linescore' */
  hydrate?: string;
}

/**
 * Fetch the MLB schedule for one or more dates (YYYY-MM-DD).
 *
 * MLB Stats API semantics:
 *   - Single date  → ?date=YYYY-MM-DD
 *   - Date range   → ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *   - Comma-separated dates in one `date=` param are REJECTED with 400.
 */
export async function fetchSchedule(
  dates: string[],
  options: ScheduleFetchOptions = {}
): Promise<MlbScheduleResponse> {
  const hydrate = options.hydrate ?? 'team,venue,probablePitcher(note),weather,linescore';
  const params = new URLSearchParams({ sportId: '1', hydrate });

  if (dates.length === 1) {
    params.set('date', dates[0]);
  } else {
    // Multi-date: use inclusive range (sorted ascending).
    const sorted = [...dates].sort();
    params.set('startDate', sorted[0]);
    params.set('endDate', sorted[sorted.length - 1]);
  }

  const url = `${MLB_STATS_API_BASE}/schedule?${params}`;
  const response = await mlbFetch(url);
  return response.json() as Promise<MlbScheduleResponse>;
}

/** Fetch all active MLB teams. */
export async function fetchTeams(): Promise<MlbTeamFull[]> {
  const url = `${MLB_STATS_API_BASE}/teams?sportId=1&activeStatus=Y`;
  const response = await mlbFetch(url);
  const body = await response.json() as MlbTeamsResponse;
  return body.teams ?? [];
}

/** Fetch the active roster for a single team. */
export async function fetchRoster(teamId: number): Promise<MlbRosterEntry[]> {
  const url = `${MLB_STATS_API_BASE}/teams/${teamId}/roster?rosterType=active&hydrate=person`;
  const response = await mlbFetch(url);
  const body = await response.json() as MlbRosterResponse;
  return body.roster ?? [];
}

/** Fetch the linescore for a single game (for live score updates). */
export async function fetchLinescore(gamePk: number): Promise<MlbLinescoreResponse> {
  const url = `${MLB_STATS_API_BASE}/game/${gamePk}/linescore`;
  const response = await mlbFetch(url);
  return response.json() as Promise<MlbLinescoreResponse>;
}

// ---------------------------------------------------------------------------
// Internal HTTP with retry
// ---------------------------------------------------------------------------

async function mlbFetch(url: string): Promise<Response> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(
        RETRY.BASE_BACKOFF_MS * Math.pow(2, attempt - 1),
        RETRY.MAX_BACKOFF_MS
      );
      await sleep(backoffMs);
    }

    let response: Response;
    try {
      // User-Agent identifies us; polite for unofficial API usage.
      response = await fetch(url, {
        headers: { 'User-Agent': 'DiamondEdge/1.0 (data ingestion)' },
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'mlb_stats_network_error',
          url,
          attempt,
          err: lastError.message,
        })
      );
      continue;
    }

    if (response.status === 429) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'mlb_stats_rate_limited',
          url,
          attempt,
        })
      );
      lastError = new Error('MLB Stats API rate limited (429)');
      await sleep(30_000); // 30s backoff for unexpected 429
      continue;
    }

    if (response.status >= 500) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'mlb_stats_server_error',
          url,
          status: response.status,
          attempt,
        })
      );
      lastError = new Error(`MLB Stats API server error: ${response.status}`);
      continue;
    }

    if (!response.ok) {
      throw new Error(`MLB Stats API error: ${response.status} ${url}`);
    }

    return response;
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
