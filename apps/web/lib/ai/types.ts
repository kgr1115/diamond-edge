/**
 * AI Reasoning layer types for Diamond Edge.
 *
 * These TypeScript interfaces mirror the Python PickCandidate schema in
 * worker/models/pick_candidate_schema.py and the contract defined in
 * docs/api/ml-output-contract.md — field-for-field.
 *
 * Any change here must be coordinated with the Python schema and the
 * RationaleInput/RationaleOutput interfaces downstream.
 */

import type { SubscriptionTier } from '@/lib/types/database';

// ---------------------------------------------------------------------------
// PickCandidate component types
// ---------------------------------------------------------------------------

export type MarketType = 'moneyline' | 'run_line' | 'total' | 'prop';
export type PickSide = 'home' | 'away' | 'over' | 'under' | string;
export type ConfidenceTier = 1 | 2 | 3 | 4 | 5;
export type SportsbookKey = 'draftkings' | 'fanduel';
export type FeatureDirection = 'positive' | 'negative';

export interface BestLine {
  /** American odds, e.g. -110, +150. Negative = favorite, positive = underdog. */
  price: number;
  /** 'draftkings' or 'fanduel' — matches sportsbooks.key in Supabase. */
  sportsbook_key: SportsbookKey;
  /** ISO 8601 UTC timestamp: when this line was pulled from The Odds API. */
  snapshotted_at: string;
}

/**
 * SHAP-style feature attribution for a single feature driving this pick.
 *
 * The AI Reasoning layer MUST cite only facts present in this structure.
 * The `label` field is the human-readable string the rationale uses directly.
 * The `shap_value` field is in log-odds space (positive = toward pick_side winning).
 */
export interface FeatureAttribution {
  /** Machine-readable identifier. Matches a key in PickCandidate.features. */
  feature_name: string;
  /** Actual value of the feature for this game. */
  feature_value: number | string;
  /**
   * SHAP contribution to the model's log-odds output.
   * Positive → pushes prediction toward pick_side winning.
   * Negative → pushes prediction away from pick_side winning.
   */
  shap_value: number;
  /**
   * 'positive' if shap_value > 0 (feature supports the pick).
   * 'negative' if shap_value < 0 (feature argues against the pick).
   */
  direction: FeatureDirection;
  /**
   * Human-readable label for use in rationale text. AI layer cites this verbatim.
   * Format: '{Human Feature Name}: {formatted_value} ({optional context})'
   * Examples:
   *   'Home Starter ERA (30-day): 2.14'
   *   'Away Bullpen Load (2-day IP): 7.2 innings — elevated fatigue'
   *   'Wind: 18 mph blowing out to CF (offense-favored conditions)'
   */
  label: string;
}

/**
 * ML model output for a single market/game combination.
 * Produced by the Fly.io worker /predict endpoint.
 * Field-for-field match to Python PickCandidate dataclass.
 */
export interface PickCandidate {
  // Identity
  game_id: string;
  market: MarketType;
  pick_side: PickSide;

  // Model outputs
  /** Calibrated probability that pick_side wins/covers/hits, 0.0–1.0. */
  model_probability: number;
  /** Market's implied probability from the best available line (includes vig). */
  implied_probability: number;
  /**
   * Expected value per $1 wagered.
   * Formula: model_probability * net_payout - (1 - model_probability)
   * e.g., 0.042 = 4.2% edge.
   */
  expected_value: number;
  /**
   * Confidence tier 1–5. Derived from EV + bootstrap uncertainty.
   * Tier 3+ (EV > 4%) = publication threshold (locked decision).
   */
  confidence_tier: ConfidenceTier;

  // Best line used for EV computation
  best_line: BestLine;

  /**
   * Top 7 features by |shap_value| driving this pick. Sorted descending.
   * Must not be empty — picks without attributions are not published.
   */
  feature_attributions: FeatureAttribution[];

  /** Complete feature vector used to generate this pick (audit/retraining). */
  features: Record<string, number | string | null>;

  /** Semantic version of the model artifact: '{market}-v{major}.{minor}.{patch}' */
  model_version: string;
  /** ISO 8601 UTC timestamp: when this PickCandidate was produced. */
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Rationale generation contract
// ---------------------------------------------------------------------------

export interface GameContext {
  home_team: { name: string; abbreviation: string; record: string };
  away_team: { name: string; abbreviation: string; record: string };
  /** Local ET time, e.g. '7:05 PM ET' */
  game_time_local: string;
  venue: string;
  probable_home_pitcher: { full_name: string } | null;
  probable_away_pitcher: { full_name: string } | null;
  weather: {
    condition: string;
    temp_f: number;
    wind_mph: number;
    wind_dir: string;
  } | null;
}

/**
 * Input to the AI reasoning layer.
 * Passed to generateRationale(); never stored directly — only the output is cached.
 */
export interface RationaleInput {
  pick: PickCandidate;
  game_context: GameContext;
  /**
   * Determines which LLM model and rationale depth.
   * free → function throws (no LLM call, locked decision)
   * pro  → Haiku 4.5, 3–5 sentences, top 2–3 attributions
   * elite → Sonnet 4.6, full paragraph + bullet breakdown of top 5 features
   */
  tier: Exclude<SubscriptionTier, 'free'>;
}

/**
 * Output from the AI reasoning layer.
 * Stored in rationale_cache table; consumed by the picks API route.
 */
export interface RationaleOutput {
  /**
   * Full markdown rationale text.
   * pro: 3–5 sentences, cites top 2–3 feature attributions
   * elite: full paragraph + bullet breakdown of top 5 features
   */
  rationale_text: string;
  /** First 1–2 sentences. Used for pro+ card previews in the slate view. */
  rationale_preview: string;
  model_used: 'claude-haiku-4-5' | 'claude-sonnet-4-6';
  tokens_used: number;
  cost_usd: number;
  generated_at: string;
}
