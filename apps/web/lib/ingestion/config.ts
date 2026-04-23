/**
 * Ingestion layer constants — market mappings, API base URLs, cadence thresholds.
 * All sportsbook identity comes from the DB `sportsbooks` table at runtime;
 * the only hardcoded list here is the default fallback for cold-start situations.
 */

import type { MarketType } from '@/lib/types/database';

// ---------------------------------------------------------------------------
// External API base URLs
// ---------------------------------------------------------------------------
export const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
export const MLB_STATS_API_BASE =
  process.env.MLB_STATS_API_BASE ?? 'https://statsapi.mlb.com/api/v1';
export const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1';

// ---------------------------------------------------------------------------
// The Odds API — market key mapping
// The Odds API key → our schema market_type enum value
// Adding a new market: extend this map + add to ODDS_API_MARKETS array.
// ---------------------------------------------------------------------------
export const ODDS_API_MARKET_MAP: Record<string, MarketType> = {
  h2h: 'moneyline',
  spreads: 'run_line',
  totals: 'total',
} as const;

/** Markets to request in every Odds API call. */
export const ODDS_API_MARKETS = Object.keys(ODDS_API_MARKET_MAP); // ['h2h', 'spreads', 'totals']

// ---------------------------------------------------------------------------
// Polling cadence thresholds (in milliseconds)
// Used by poll.ts to decide how often to call The Odds API.
// ---------------------------------------------------------------------------
export const POLL_CADENCE = {
  /** Poll every 30 min when at least one game starts within 3 hours. */
  PRE_GAME_WINDOW_MS: 3 * 60 * 60 * 1000,
  /** Poll every 2 hours when games are 3–24 hours out. */
  NEAR_WINDOW_MS: 24 * 60 * 60 * 1000,
} as const;

// ---------------------------------------------------------------------------
// MLB season boundaries — used to tighten polling outside the season.
// These are approximate; adjust at season start/end.
// ---------------------------------------------------------------------------
export const MLB_SEASON = {
  /** Month index (0-based) when the regular season typically starts. */
  START_MONTH: 2, // March
  /** Month index (0-based) when the regular season typically ends. */
  END_MONTH: 9, // October
} as const;

// ---------------------------------------------------------------------------
// Retry configuration shared across all external HTTP clients
// ---------------------------------------------------------------------------
export const RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_BACKOFF_MS: 1_000,
  MAX_BACKOFF_MS: 16_000,
} as const;
