/**
 * DEPRECATED — feature engineering moved to worker/app/features.py.
 *
 * This file is retained for one release cycle so any code that imports
 * buildFeatureVector receives a clear error rather than a silent failure.
 *
 * The worker (Fly.io) now queries Supabase directly using its service-role key,
 * builds the full 90-feature vector matching the B2 model contract, and runs
 * inference.  The Edge Function sends only { game_id, markets } to /predict.
 *
 * To remove this file: delete after confirming no remaining imports.
 * The import in index.ts is already commented out.
 */
console.warn('[DEPRECATED] feature-builder.ts — buildFeatureVector has moved to worker/app/features.py');

import type { GameRow, OddsRow } from './types.ts';

// ---------------------------------------------------------------------------
// news_signals row shape (subset we use for feature aggregation)
// ---------------------------------------------------------------------------

interface NewsSignalRow {
  signal_type: string;
  confidence: number;
  payload: {
    war_proxy?: number | null;
    severity?: string | null;
    [key: string]: unknown;
  } | null;
}

// Numeric encoding for injury severity — higher = more severe impact on win prob.
// Sourced from ADR-002 §News-derived features.
const SEVERITY_WEIGHT: Record<string, number> = {
  day_to_day:   1,
  questionable: 2,
  il_10:        3,
  il_15:        4,
  il_60:        5,
};

// ---------------------------------------------------------------------------
// Feature vector types
// ---------------------------------------------------------------------------

export interface NewsFeatures {
  late_scratch_count: number;
  late_scratch_war_impact_sum: number;
  lineup_change_count: number;
  injury_update_severity_max: number;
  opener_announced: number;   // 0 | 1
  weather_note_flag: number;  // 0 | 1
}

export interface FeatureVector {
  // Team identity
  home_team_id: string;
  away_team_id: string;

  // Moneyline prices (best across DK/FD)
  home_ml_price: number | null;
  away_ml_price: number | null;

  // Run line prices
  home_rl_price: number | null;
  away_rl_price: number | null;
  run_line_spread: number | null;

  // Totals
  over_price: number | null;
  under_price: number | null;
  total_line: number | null;

  // Weather
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;

  // Pitchers
  home_pitcher_id: string | null;
  away_pitcher_id: string | null;

  // Venue
  venue_state: string | null;

  // News signals (Phase 5 / ADR-002)
  // All default to 0 when news pipeline hasn't run yet.
  late_scratch_count: number;
  late_scratch_war_impact_sum: number;
  lineup_change_count: number;
  injury_update_severity_max: number;
  opener_announced: number;
  weather_note_flag: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a feature vector from DB data for a single game.
 * Selects the best available line price across all sportsbooks for each market.
 * news_signals rows are optional — pass [] if the late-news pipeline hasn't run yet.
 */
export function buildFeatureVector(
  game: GameRow,
  odds: OddsRow[],
  newsSignals: NewsSignalRow[] = [],
): FeatureVector {
  // Odds aggregation — pick the best available price per market/side.
  let home_ml_price: number | null = null;
  let away_ml_price: number | null = null;
  let home_rl_price: number | null = null;
  let away_rl_price: number | null = null;
  let run_line_spread: number | null = null;
  let over_price: number | null = null;
  let under_price: number | null = null;
  let total_line: number | null = null;

  for (const row of odds) {
    if (row.market === 'moneyline') {
      if (row.home_price !== null) {
        home_ml_price = home_ml_price === null
          ? row.home_price
          : bestPrice(home_ml_price, row.home_price);
      }
      if (row.away_price !== null) {
        away_ml_price = away_ml_price === null
          ? row.away_price
          : bestPrice(away_ml_price, row.away_price);
      }
    }
    if (row.market === 'run_line') {
      if (row.home_price !== null) {
        home_rl_price = home_rl_price === null
          ? row.home_price
          : bestPrice(home_rl_price, row.home_price);
      }
      if (row.away_price !== null) {
        away_rl_price = away_rl_price === null
          ? row.away_price
          : bestPrice(away_rl_price, row.away_price);
      }
      if (row.run_line_spread !== null && run_line_spread === null) {
        run_line_spread = row.run_line_spread;
      }
    }
    if (row.market === 'total') {
      if (row.over_price !== null) {
        over_price = over_price === null ? row.over_price : bestPrice(over_price, row.over_price);
      }
      if (row.under_price !== null) {
        under_price = under_price === null
          ? row.under_price
          : bestPrice(under_price, row.under_price);
      }
      if (row.total_line !== null && total_line === null) {
        total_line = row.total_line;
      }
    }
  }

  const news = aggregateNewsFeatures(newsSignals);

  return {
    home_team_id: game.home_team_id,
    away_team_id: game.away_team_id,
    home_ml_price,
    away_ml_price,
    home_rl_price,
    away_rl_price,
    run_line_spread,
    over_price,
    under_price,
    total_line,
    weather_temp_f: game.weather_temp_f,
    weather_wind_mph: game.weather_wind_mph,
    weather_wind_dir: game.weather_wind_dir,
    home_pitcher_id: game.probable_home_pitcher_id,
    away_pitcher_id: game.probable_away_pitcher_id,
    venue_state: game.venue_state,
    ...news,
  };
}

// ---------------------------------------------------------------------------
// News signal aggregation (ADR-002 §News-derived features)
// ---------------------------------------------------------------------------

/**
 * Aggregate news_signals rows for a single game into numeric features.
 * All signals from the T-6h window are considered; caller is responsible
 * for pre-filtering by game_id and published_at.
 *
 * Worker-side _build_feature_vector() fills absent keys with 0.0, so
 * returning 0 for any absent signal type is the correct safe default.
 */
function aggregateNewsFeatures(signals: NewsSignalRow[]): NewsFeatures {
  let late_scratch_count = 0;
  let late_scratch_war_impact_sum = 0;
  let lineup_change_count = 0;
  let injury_update_severity_max = 0;
  let opener_announced = 0;
  let weather_note_flag = 0;

  for (const sig of signals) {
    switch (sig.signal_type) {
      case 'late_scratch': {
        late_scratch_count += 1;
        const war = sig.payload?.war_proxy ?? null;
        if (typeof war === 'number' && isFinite(war)) {
          late_scratch_war_impact_sum += war;
        }
        break;
      }
      case 'lineup_change': {
        lineup_change_count += 1;
        break;
      }
      case 'injury_update': {
        const severity = sig.payload?.severity ?? null;
        const weight = typeof severity === 'string'
          ? (SEVERITY_WEIGHT[severity] ?? 1)
          : 1;
        if (weight > injury_update_severity_max) {
          injury_update_severity_max = weight;
        }
        break;
      }
      case 'opener_announcement': {
        opener_announced = 1;
        break;
      }
      case 'weather_note': {
        weather_note_flag = 1;
        break;
      }
      // 'other' and unrecognized types contribute no numeric features
    }
  }

  return {
    late_scratch_count,
    late_scratch_war_impact_sum,
    lineup_change_count,
    injury_update_severity_max,
    opener_announced,
    weather_note_flag,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the "better" of two American odds prices for line-shopping purposes.
 * Higher number = better payout = preferred for EV computation.
 * (e.g., +150 is better than +130; -105 is better than -115)
 */
function bestPrice(a: number, b: number): number {
  return b > a ? b : a;
}
