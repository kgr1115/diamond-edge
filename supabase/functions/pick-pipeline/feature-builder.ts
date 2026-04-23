/**
 * Phase 2 simplified feature set for the pick pipeline.
 *
 * IMPORTANT: This is a simplified feature set using only data available in the
 * current DB schema (games, odds, teams, players). Full Statcast features
 * (ERA, WHIP, FIP, xFIP, wRC+, exit velocity, etc.) require the TASK-004
 * data pipeline to be fully operational with real API keys and training data.
 *
 * The ML worker will return empty candidates until model training completes on
 * real Statcast data — this is EXPECTED in staging. Flag this gap to the
 * orchestrator when staging validation begins.
 *
 * Full Statcast integration: TASK-004 + ML model training (post-Phase 2).
 */

import type { GameRow, OddsRow } from './types.ts';

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
}

/**
 * Assemble a Phase 2 simplified feature vector from DB data for a single game.
 * Selects the best available line price across all sportsbooks for each market.
 */
export function buildFeatureVector(game: GameRow, odds: OddsRow[]): FeatureVector {
  // For each market + side, take the most favorable line across DK and FD.
  // "Most favorable" for picking purposes = highest absolute price (most juice to pick side).
  // The ML worker uses these to compute implied probability.

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
      // Pick the best (highest) home/away ML price across books
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
  };
}

/**
 * Return the "better" of two American odds prices for line-shopping purposes.
 * Higher number = better payout = preferred for EV computation.
 * (e.g., +150 is better than +130; -105 is better than -115)
 */
function bestPrice(a: number, b: number): number {
  return b > a ? b : a;
}
