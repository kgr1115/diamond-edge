-- Diamond Edge — Pick Tables
-- Run order: 5 (depends on: enums, lookup tables, reference tables, core tables)

-- ============================================================
-- picks
-- One row per generated pick. Append-only for audit.
-- Tier gating is enforced at the API layer (column masking),
-- not via RLS. RLS here controls row visibility only.
-- ============================================================

CREATE TABLE picks (
  id                 uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id            uuid              NOT NULL REFERENCES games(id),
  pick_date          date              NOT NULL,
  market             market_type       NOT NULL,
  pick_side          text              NOT NULL,  -- 'home','away','over','under', or prop description
  -- Model outputs
  model_probability  numeric(5,4)      NOT NULL,  -- 0.0000–1.0000
  implied_probability numeric(5,4),               -- derived from best available line
  expected_value     numeric(6,4),                -- (model_prob * payout) - (1 - model_prob)
  confidence_tier    smallint          NOT NULL CHECK (confidence_tier BETWEEN 1 AND 5),
  -- Best line at generation time
  best_line_price    integer,          -- American odds
  best_line_book_id  uuid              REFERENCES sportsbooks(id),
  -- LLM rationale
  rationale_id       uuid              REFERENCES rationale_cache(id),
  -- Minimum subscription tier to see this pick
  required_tier      subscription_tier NOT NULL DEFAULT 'free',
  -- Lifecycle
  result             pick_result       NOT NULL DEFAULT 'pending',
  generated_at       timestamptz       NOT NULL DEFAULT now(),
  created_at         timestamptz       NOT NULL DEFAULT now()
);

CREATE INDEX idx_picks_pick_date       ON picks(pick_date DESC);
CREATE INDEX idx_picks_game_id         ON picks(game_id);
CREATE INDEX idx_picks_market          ON picks(market);
CREATE INDEX idx_picks_confidence_tier ON picks(confidence_tier DESC);
CREATE INDEX idx_picks_result          ON picks(result);

ALTER TABLE picks ENABLE ROW LEVEL SECURITY;

-- Authenticated users can see all picks (tier-gating is column masking in API code)
CREATE POLICY "picks_select_authenticated" ON picks
  FOR SELECT TO authenticated USING (true);

-- Anon users can only see free-tier picks
CREATE POLICY "picks_select_anon_free" ON picks
  FOR SELECT TO anon USING (required_tier = 'free');

-- ============================================================
-- pick_outcomes
-- Populated by outcome-grader job. One row per pick (1:1).
-- ============================================================

CREATE TABLE pick_outcomes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id    uuid        NOT NULL UNIQUE REFERENCES picks(id),
  game_id    uuid        NOT NULL REFERENCES games(id),
  result     pick_result NOT NULL,
  home_score smallint    NOT NULL,
  away_score smallint    NOT NULL,
  graded_at  timestamptz NOT NULL DEFAULT now(),
  notes      text        -- e.g., 'postponed', 'push due to line movement'
);

CREATE INDEX idx_pick_outcomes_pick_id   ON pick_outcomes(pick_id);
CREATE INDEX idx_pick_outcomes_game_id   ON pick_outcomes(game_id);
CREATE INDEX idx_pick_outcomes_result    ON pick_outcomes(result);
CREATE INDEX idx_pick_outcomes_graded_at ON pick_outcomes(graded_at DESC);

ALTER TABLE pick_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pick_outcomes_select_public" ON pick_outcomes FOR SELECT USING (true);
