-- Diamond Edge — Pick journal + bankroll settings columns
-- Run order: 14 (depends on: 0005_pick_tables, 0006_user_tables)
--
-- Adds:
--   picks.user_note         — free-text journal note per pick
--   picks.user_tags         — freeform tag array per pick
--   profiles.bankroll_unit_pct      — unit size as % of bankroll (default 1%)
--   profiles.daily_exposure_cap_pct — daily exposure ceiling (default 3%)
--   profiles.kelly_fraction         — Kelly fraction multiplier (default 0.25)

-- ---------------------------------------------------------------------------
-- picks journal columns
-- ---------------------------------------------------------------------------

ALTER TABLE picks
  ADD COLUMN IF NOT EXISTS user_note text,
  ADD COLUMN IF NOT EXISTS user_tags text[] NOT NULL DEFAULT ARRAY[]::text[];

-- GIN index for array containment queries ("show picks tagged 'weather-play'")
CREATE INDEX IF NOT EXISTS idx_picks_user_tags ON picks USING gin(user_tags);

-- ---------------------------------------------------------------------------
-- profiles bankroll-settings columns
-- ---------------------------------------------------------------------------

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS bankroll_unit_pct      numeric(4,2) NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS daily_exposure_cap_pct numeric(4,2) NOT NULL DEFAULT 3.0,
  ADD COLUMN IF NOT EXISTS kelly_fraction         numeric(4,2) NOT NULL DEFAULT 0.25;

-- Validate ranges at DB level so the API can trust the stored values
ALTER TABLE profiles
  ADD CONSTRAINT chk_bankroll_unit_pct
    CHECK (bankroll_unit_pct BETWEEN 0.1 AND 25.0),
  ADD CONSTRAINT chk_daily_exposure_cap_pct
    CHECK (daily_exposure_cap_pct BETWEEN 0.5 AND 20.0),
  ADD CONSTRAINT chk_kelly_fraction
    CHECK (kelly_fraction BETWEEN 0.1 AND 1.0);
