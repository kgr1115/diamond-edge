-- Migration 0024: park_factor_runs static lookup table
-- ~30 rows; one per MLB venue. Seeded separately by mlb-data-engineer
-- from FanGraphs/Baseball Reference multi-year park factors.
-- Updated once per season (January or after ~2 months of current-season data).
-- Service-role-only — no user-facing reads in v1.
-- Depends on: none (new table)

CREATE TABLE IF NOT EXISTS park_factor_runs (
  venue_name            TEXT         PRIMARY KEY,
  runs_factor           NUMERIC(5,2) NOT NULL,
  outfield_bearing_deg  SMALLINT     CHECK (outfield_bearing_deg BETWEEN 0 AND 359),
  is_dome               BOOLEAN      NOT NULL DEFAULT false,
  season_years          TEXT,
  source                TEXT         NOT NULL DEFAULT 'fangraphs',
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE park_factor_runs IS
  'Static venue-level runs park factor. One row per MLB venue. '
  'Seeded from FanGraphs or Baseball Reference multi-year factors. '
  'Updated once per season. Service-role-only — not user-facing. '
  'See ADR-003.';

COMMENT ON COLUMN park_factor_runs.runs_factor IS
  'Multi-year average runs park factor, normalized to 100. '
  '100 = league average. >100 = hitter-friendly. <100 = pitcher-friendly.';

COMMENT ON COLUMN park_factor_runs.outfield_bearing_deg IS
  'Compass bearing from home plate toward center field (0-359 degrees). '
  'Used to derive weather_wind_out_mph in the game_wind_features view. '
  'NULL if not yet seeded for this venue; view returns NULL wind scalar.';

COMMENT ON COLUMN park_factor_runs.is_dome IS
  'True for retractable or fixed dome stadiums. '
  'Weather features default to 0 (wind 0.0 mph) for dome venues.';

ALTER TABLE park_factor_runs ENABLE ROW LEVEL SECURITY;

-- No authenticated or anon reads. Feature construction is service-role only.
-- Policy is idempotent via the DO block guard.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'park_factor_runs'
      AND schemaname = 'public'
      AND policyname = 'park_factor_runs_service_role_only'
  ) THEN
    CREATE POLICY "park_factor_runs_service_role_only" ON park_factor_runs
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
