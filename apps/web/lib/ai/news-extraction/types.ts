/**
 * Types for the news signal extraction pipeline.
 *
 * These mirror the news_signals table schema (migration 0008) and the
 * NewsSignals interface in ADR-002. The payload JSONB column stores
 * one of the typed payloads below, keyed by signal_type.
 *
 * Rules:
 * - signal_type values are the DB CHECK constraint values exactly.
 * - player_id is always a UUID string or null — never an integer.
 * - confidence is a float 0.0–1.0, not an enum, because the DB schema
 *   stores it as real. The prompt produces 0.3/0.5/0.7/1.0 as named points.
 */

// ---------------------------------------------------------------------------
// Per-signal payload types (stored in news_signals.payload JSONB)
// ---------------------------------------------------------------------------

export interface LateScratchPayload {
  player_name: string;
  player_id: string | null;
  team: string;
  position: string | null;
  war_proxy: number | null;
  reason: 'injury' | 'rest' | 'personal' | 'unknown';
  confidence: number;
  source_excerpt: string;
}

export interface LineupChangePayload {
  player_in: string | null;
  player_out: string | null;
  position: string | null;
  order_change: { from: number | null; to: number | null };
  team: string;
  confidence: number;
  source_excerpt: string;
}

export interface InjuryUpdatePayload {
  player_name: string;
  player_id: string | null;
  severity: 'day_to_day' | 'questionable' | 'il_10' | 'il_15' | 'il_60';
  body_part: string | null;
  expected_return_days: number | null;
  confidence: number;
  source_excerpt: string;
}

export interface WeatherNotePayload {
  venue: string;
  condition: 'rain' | 'wind' | 'cold' | 'heat' | 'roof_open' | 'roof_closed';
  delay_probability: number | null;
  confidence: number;
  source_excerpt: string;
}

export interface OpenerAnnouncementPayload {
  team: string;
  expected_starter: string | null;
  expected_innings: number | null;
  confidence: number;
  source_excerpt: string;
}

export interface OtherPayload {
  headline: string;
  source_excerpt: string;
}

export type SignalPayload =
  | LateScratchPayload
  | LineupChangePayload
  | InjuryUpdatePayload
  | WeatherNotePayload
  | OpenerAnnouncementPayload
  | OtherPayload;

// ---------------------------------------------------------------------------
// Raw Claude output types (what the model returns before DB normalization)
// ---------------------------------------------------------------------------

export type SignalType =
  | 'late_scratch'
  | 'lineup_change'
  | 'injury_update'
  | 'weather_note'
  | 'opener_announcement'
  | 'other';

/** A single extracted signal as returned by Claude — before DB normalization. */
export interface RawExtractedSignal {
  signal_type: SignalType;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// news_signals row ready to insert into Supabase
// ---------------------------------------------------------------------------

/**
 * A fully-formed news_signals row, ready for upsert.
 *
 * The calling code (extract-signals.ts) populates news_event_id and game_id
 * before the row is written. Claude populates signal_type, player_id, payload,
 * and confidence via the extraction + player-resolver steps.
 */
export interface NewsSignalInsert {
  news_event_id: string;      // UUID — the source news_events row
  game_id: string | null;     // UUID — resolved by game-matcher; null if unresolvable
  signal_type: SignalType;
  player_id: string | null;   // UUID — resolved by player-resolver; null if unresolvable
  payload: SignalPayload;
  confidence: number;         // 0.0–1.0
}

// ---------------------------------------------------------------------------
// Token usage and cost tracking (passed back to the caller for audit logging)
// ---------------------------------------------------------------------------

export interface ExtractionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

export interface ExtractionResult {
  game_id: string;
  signals: NewsSignalInsert[];
  usage: ExtractionUsage;
  extracted_at: string; // ISO 8601 UTC
}
