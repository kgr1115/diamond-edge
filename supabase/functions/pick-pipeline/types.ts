// Type definitions for the pick pipeline Edge Function.
// These mirror the TypeScript types in apps/web/lib/ai/types.ts and
// worker/models/pick_candidate_schema.py — kept in sync manually.

export type MarketType = 'moneyline' | 'run_line' | 'total' | 'prop';
export type PickSide = 'home' | 'away' | 'over' | 'under' | string;
export type ConfidenceTier = 1 | 2 | 3 | 4 | 5;
export type SportsbookKey = 'draftkings' | 'fanduel';
export type RequiredTier = 'free' | 'pro' | 'elite';

export interface BestLine {
  price: number;
  sportsbook_key: SportsbookKey;
  snapshotted_at: string;
}

export interface FeatureAttribution {
  feature_name: string;
  feature_value: number | string;
  shap_value: number;
  direction: 'positive' | 'negative';
  label: string;
}

/** ML model output for a single game/market. Produced by Fly.io worker /predict. */
export interface PickCandidate {
  game_id: string;
  market: MarketType;
  pick_side: PickSide;
  model_probability: number;
  implied_probability: number;
  expected_value: number;
  confidence_tier: ConfidenceTier;
  best_line: BestLine;
  feature_attributions: FeatureAttribution[];
  features: Record<string, number | string | null>;
  model_version: string;
  generated_at: string;
}

/** Input to the Fly.io /predict endpoint.
 *
 * Feature engineering has moved to the worker (worker/app/features.py).
 * The worker queries Supabase directly using SUPABASE_SERVICE_ROLE_KEY.
 * The Edge Function no longer builds or sends a features dict.
 */
export interface PredictRequest {
  game_id: string;
  markets: ('moneyline' | 'run_line' | 'total')[];
}

/** Response from Fly.io /predict endpoint. */
export interface PredictResponse {
  candidates: PickCandidate[];
}

/** Input to the Fly.io /rationale endpoint. */
export interface RationaleRequest {
  pick: PickCandidate;
  game_context: GameContext;
  tier: 'pro' | 'elite';
}

export interface GameContext {
  home_team: { name: string; abbreviation: string; record: string };
  away_team: { name: string; abbreviation: string; record: string };
  game_time_local: string;
  venue: string;
  probable_home_pitcher: { full_name: string } | null;
  probable_away_pitcher: { full_name: string } | null;
  weather: { condition: string; temp_f: number; wind_mph: number; wind_dir: string } | null;
}

/** Response from Fly.io /rationale endpoint (or direct Claude call). */
export interface RationaleResponse {
  rationale_text: string;
  rationale_preview: string;
  model_used: string;
  tokens_used: number;
  cost_usd: number;
  generated_at: string;
}

/** Internal structure for assembled picks ready to DB-insert. */
export interface PreparedPick {
  candidate: PickCandidate;
  required_tier: RequiredTier;
  rationale_cache_id: string | null;
}

/** Minimal game row from the DB (only fields needed for feature assembly). */
export interface GameRow {
  id: string;
  mlb_game_id: number;
  game_date: string;
  game_time_utc: string | null;
  status: string;
  home_team_id: string;
  away_team_id: string;
  venue_name: string | null;
  venue_state: string | null;
  weather_condition: string | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
  probable_home_pitcher_id: string | null;
  probable_away_pitcher_id: string | null;
}

/** Odds row joined with sportsbook key for a specific game. */
export interface OddsRow {
  market: string;
  home_price: number | null;
  away_price: number | null;
  total_line: number | null;
  over_price: number | null;
  under_price: number | null;
  run_line_spread: number | null;
  snapshotted_at: string;
  sportsbooks: { key: string };
}
