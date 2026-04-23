/**
 * The Odds API client — typed fetch wrapper with retry + exponential backoff.
 *
 * Source summary:
 *   Endpoint: GET /v4/sports/baseball_mlb/odds
 *   One call returns ALL MLB games with all requested markets for all requested bookmakers.
 *   No per-game calls needed — very budget-efficient.
 *
 * Budget discipline:
 *   - API key in ODDS_API_KEY env var; never in client bundles.
 *   - Response headers x-requests-remaining / x-requests-used are surfaced to callers
 *     for budget tracking and structured logging.
 *   - 429 responses log the call count context before backing off.
 */

import { ODDS_API_BASE, RETRY } from '@/lib/ingestion/config';

// ---------------------------------------------------------------------------
// Response types — mirror The Odds API v4 schema
// ---------------------------------------------------------------------------

export interface OddsApiOutcome {
  name: string;   // team name (h2h/spreads) or 'Over'/'Under' (totals)
  price: number;  // American odds, e.g. -110
  point?: number; // spread or total line, e.g. -1.5 or 8.5
}

export interface OddsApiMarket {
  key: string;           // 'h2h' | 'spreads' | 'totals'
  last_update: string;   // ISO 8601 UTC
  outcomes: OddsApiOutcome[];
}

export interface OddsApiBookmaker {
  key: string;           // 'draftkings' | 'fanduel' (matches sportsbooks.key)
  title: string;         // 'DraftKings' | 'FanDuel'
  last_update: string;   // ISO 8601 UTC
  markets: OddsApiMarket[];
}

export interface OddsApiGame {
  id: string;            // The Odds API internal game ID (not MLB gamePk)
  sport_key: string;     // 'baseball_mlb'
  sport_title: string;
  commence_time: string; // ISO 8601 UTC — matches our game_time_utc
  home_team: string;     // full team name, e.g. 'New York Yankees'
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

export interface OddsApiFetchResult {
  games: OddsApiGame[];
  requestsRemaining: number; // from x-requests-remaining header; -1 if missing
  requestsUsed: number;      // from x-requests-used header; -1 if missing
}

// ---------------------------------------------------------------------------
// Public fetch function
// ---------------------------------------------------------------------------

interface FetchOddsParams {
  /** Sportsbook keys to request — read from DB at call site, not hardcoded here. */
  bookmakerKeys: string[];
  /** Defaults to all three standard MLB markets. */
  markets?: string[];
}

/**
 * Fetch current MLB odds from The Odds API.
 * Returns all games with all requested bookmakers and markets in a single HTTP call.
 * Retries on 429 (rate-limited) and 5xx with exponential backoff.
 */
export async function fetchMlbOdds(params: FetchOddsParams): Promise<OddsApiFetchResult> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error('ODDS_API_KEY env var is not set');

  const { bookmakerKeys, markets = ['h2h', 'spreads', 'totals'] } = params;

  const url = new URL(`${ODDS_API_BASE}/sports/baseball_mlb/odds`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', markets.join(','));
  url.searchParams.set('bookmakers', bookmakerKeys.join(','));
  url.searchParams.set('oddsFormat', 'american');

  const response = await fetchWithRetry(url.toString());

  const requestsRemaining = parseInt(
    response.headers.get('x-requests-remaining') ?? '-1',
    10
  );
  const requestsUsed = parseInt(
    response.headers.get('x-requests-used') ?? '-1',
    10
  );

  const games: OddsApiGame[] = await response.json();

  return { games, requestsRemaining, requestsUsed };
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

async function fetchWithRetry(url: string): Promise<Response> {
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
      response = await fetch(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'odds_api_network_error',
          attempt,
          err: lastError.message,
        })
      );
      continue;
    }

    if (response.status === 429) {
      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterMs = retryAfterRaw ? parseInt(retryAfterRaw, 10) * 1000 : 60_000;
      const requestsRemaining = response.headers.get('x-requests-remaining') ?? 'unknown';
      const requestsUsed = response.headers.get('x-requests-used') ?? 'unknown';

      // 429 must be logged with call-count context — never silently dropped.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'odds_api_rate_limited',
          attempt,
          retryAfterMs,
          requestsRemaining,
          requestsUsed,
        })
      );

      lastError = new Error(`Odds API rate limited (429)`);
      await sleep(Math.min(retryAfterMs, 120_000));
      continue;
    }

    if (response.status >= 500) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'odds_api_server_error',
          attempt,
          status: response.status,
        })
      );
      lastError = new Error(`Odds API server error: ${response.status}`);
      continue;
    }

    if (!response.ok) {
      // 4xx other than 429: do not retry — these are caller errors.
      throw new Error(`Odds API client error: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
