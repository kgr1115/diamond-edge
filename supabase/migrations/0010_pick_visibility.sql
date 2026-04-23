-- Diamond Edge — picks.visibility column + shadow/live two-gate RLS
-- Run order: 10 (depends on: 0005_pick_tables)
--
-- Shadow picks (EV >= 4%, tier >= 3) are stored to DB for CLV data
-- accumulation and model improvement. Live picks (EV >= 8%, tier >= 5)
-- are user-visible. RLS enforces this — users never see shadow rows.
--
-- ADR-002 Phase 5 spec:
--   SHADOW: EV >= 0.04 AND confidence_tier >= 3 (stored, not user-visible)
--   LIVE:   EV >= 0.08 AND confidence_tier >= 5 (user-visible; existing gate)

-- Add visibility column. Default 'shadow' so any pick inserted without
-- explicit visibility is conservatively hidden until the pipeline upgrades it.
ALTER TABLE picks
  ADD COLUMN visibility text NOT NULL DEFAULT 'shadow'
    CHECK (visibility IN ('shadow', 'live'));

-- Index for efficient query by the picks-today API route and the
-- outcome-grader (needs both shadow and live for grading).
CREATE INDEX idx_picks_visibility_game ON picks(visibility, game_id);

-- ---------------------------------------------------------------------------
-- RLS policy refresh
-- Drop the old open "authenticated sees all" policy. Replace with two
-- explicit policies:
--   - live picks: authenticated users see picks WHERE visibility = 'live'
--   - anon users: only live + free-tier (unchanged behavior, scoped to live)
--   - service role: unrestricted (for grading + shadow accumulation)
-- ---------------------------------------------------------------------------

-- Drop existing policies on picks table
DROP POLICY IF EXISTS "picks_select_authenticated" ON picks;
DROP POLICY IF EXISTS "picks_select_anon_free"     ON picks;

-- Live picks visible to authenticated users (tier-gating done in API code)
CREATE POLICY picks_select_live_authenticated ON picks
  FOR SELECT
  TO authenticated
  USING (visibility = 'live');

-- Live + free-tier picks visible to anon users
CREATE POLICY picks_select_live_anon_free ON picks
  FOR SELECT
  TO anon
  USING (visibility = 'live' AND required_tier = 'free');

-- Service role reads everything (needed for outcome-grader + shadow analytics)
-- Supabase grants service_role BYPASSRLS by default, so no explicit policy
-- needed — this comment documents intent only.

-- ---------------------------------------------------------------------------
-- ADR-002 column additions to picks (market_novig_prior, model_delta,
-- news_signals_applied, news_signals_id, market_prior_id)
-- Nullable for backward compatibility; pre-ADR-002 picks land with nulls.
-- ---------------------------------------------------------------------------

ALTER TABLE picks
  ADD COLUMN IF NOT EXISTS market_novig_prior   numeric(5,4),
  ADD COLUMN IF NOT EXISTS model_delta          numeric(6,4),
  ADD COLUMN IF NOT EXISTS news_signals_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS news_signals_id      uuid REFERENCES news_signals(id),
  ADD COLUMN IF NOT EXISTS market_prior_id      uuid REFERENCES market_priors(id);

-- Index to support CLV measurement queries (games with novig prior set)
CREATE INDEX IF NOT EXISTS idx_picks_market_novig_prior
  ON picks(market_novig_prior)
  WHERE market_novig_prior IS NOT NULL;
