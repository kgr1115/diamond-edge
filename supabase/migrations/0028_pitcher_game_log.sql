-- Migration 0028: pitcher_game_log — per-appearance pitching stats for rolling features
-- Source: MLB Stats API /game/{gamePk}/boxscore (free, public)
-- PK: (pitcher_id, game_id) — one row per pitcher per game appearance
--
-- Required by moneyline v0 features:
--   starter_fip_home/away     — 30-day IP-weighted FIP on the identified starter
--   starter_days_rest_home/away — days since last appearance
--   bullpen_fip_l14_home/away — 14-day IP-weighted FIP, excluding the identified starter
--
-- is_starter decision note:
--   A separate game_starters table was evaluated and rejected. games.probable_home/away_pitcher_id
--   already holds the starter identity for serve-time use. For backfill, the starter is identified
--   by is_starter = true in this table (set when the pitcher's game_sequence position = 1, i.e.,
--   the first pitcher listed in the boxscore). This eliminates the need for a third table and
--   keeps the schema minimal. See moneyline-v0 backfill runbook for the architect decision record.
--
-- Depends on: 0002_players.sql (players), 0003_teams.sql (teams), 0004_core_tables.sql (games)

CREATE TABLE IF NOT EXISTS pitcher_game_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  pitcher_id    UUID         NOT NULL REFERENCES players(id)  ON DELETE CASCADE,
  team_id       UUID         NOT NULL REFERENCES teams(id)    ON DELETE CASCADE,
  game_id       UUID         NOT NULL REFERENCES games(id)    ON DELETE CASCADE,
  game_date     DATE         NOT NULL,
  ip            NUMERIC(5,1) NOT NULL CHECK (ip >= 0),
  hr            SMALLINT     NOT NULL DEFAULT 0 CHECK (hr >= 0),
  bb            SMALLINT     NOT NULL DEFAULT 0 CHECK (bb >= 0),
  hbp           SMALLINT     NOT NULL DEFAULT 0 CHECK (hbp >= 0),
  k             SMALLINT     NOT NULL DEFAULT 0 CHECK (k >= 0),
  is_starter    BOOLEAN      NOT NULL DEFAULT false,
  source_url    TEXT,
  retrieved_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (pitcher_id, game_id)
);

COMMENT ON TABLE pitcher_game_log IS
  'Per-appearance pitching stats for rolling-window feature construction. '
  'One row per pitcher per game. Source: MLB Stats API boxscore endpoint. '
  'is_starter=true when the pitcher was the first pitcher listed (game_sequence=1). '
  'Features starter_fip_*, starter_days_rest_*, bullpen_fip_l14_* all read from here. '
  'Backfilled for 2022-09 through 2024. Updated nightly after game completion.';

COMMENT ON COLUMN pitcher_game_log.ip IS
  'Innings pitched as a decimal (e.g. 6.1 = 6 and 1/3 innings). '
  'Stored as NUMERIC not TEXT to enable IP-weighted FIP aggregation directly in SQL.';

COMMENT ON COLUMN pitcher_game_log.is_starter IS
  'True when this pitcher started the game (first pitcher listed in boxscore). '
  'Bullpen FIP queries exclude rows with is_starter=true when the same pitcher '
  'also has starter appearances in the rolling window.';

COMMENT ON COLUMN pitcher_game_log.source_url IS
  'MLB Stats API URL used to retrieve this row, for audit trail.';

-- FK index + query pattern: WHERE pitcher_id = :id AND game_date BETWEEN ...
CREATE INDEX IF NOT EXISTS idx_pgl_pitcher_date
  ON pitcher_game_log(pitcher_id, game_date DESC);

-- Bullpen FIP query: WHERE team_id = :id AND game_date BETWEEN ... AND is_starter = false
CREATE INDEX IF NOT EXISTS idx_pgl_team_date_starter
  ON pitcher_game_log(team_id, game_date DESC, is_starter);

-- FK support
CREATE INDEX IF NOT EXISTS idx_pgl_game_id
  ON pitcher_game_log(game_id);

CREATE INDEX IF NOT EXISTS idx_pgl_updated_at
  ON pitcher_game_log(updated_at DESC);

-- Trigger: keep updated_at current on any write
CREATE OR REPLACE TRIGGER set_updated_at_pitcher_game_log
  BEFORE UPDATE ON pitcher_game_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: service-role only (same posture as park_factor_runs; no user-facing reads)
ALTER TABLE pitcher_game_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pitcher_game_log'
      AND schemaname = 'public'
      AND policyname = 'pitcher_game_log_service_role_only'
  ) THEN
    CREATE POLICY "pitcher_game_log_service_role_only" ON pitcher_game_log
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
