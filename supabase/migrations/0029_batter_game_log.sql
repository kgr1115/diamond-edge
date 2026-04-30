-- Migration 0029: batter_game_log — per-game batting stats for rolling wRC+/OPS+ features
-- Source: MLB Stats API /game/{gamePk}/boxscore (free, public)
-- PK: (batter_id, game_id) — one row per batter per game
--
-- Required by moneyline v0 features:
--   team_wrcplus_l30_home/away — last 30 days, PA-weighted wRC+ (or OPS+ proxy for v0)
--
-- wRC+ proxy decision (v0):
--   MLB Stats API does not return wRC+ directly. Computing wRC+ from box score components
--   requires league-average wOBA constants and park factors — high-effort for v0.
--   CEng-authorized proxy: store OPS+ from MLB Stats API as wrc_plus for v0.
--   Column name stays wrc_plus regardless of source so the feature contract is stable.
--   Switch to true wRC+ is a v1 data-engineer task; schema requires no change.
--   Source is documented in batter_game_log.wrc_plus_source column.
--
-- Depends on: 0002_players.sql (players), 0003_teams.sql (teams), 0004_core_tables.sql (games)

CREATE TABLE IF NOT EXISTS batter_game_log (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  batter_id        UUID         NOT NULL REFERENCES players(id)  ON DELETE CASCADE,
  team_id          UUID         NOT NULL REFERENCES teams(id)    ON DELETE CASCADE,
  game_id          UUID         NOT NULL REFERENCES games(id)    ON DELETE CASCADE,
  game_date        DATE         NOT NULL,
  pa               SMALLINT     NOT NULL DEFAULT 0 CHECK (pa >= 0),
  wrc_plus         SMALLINT,
  wrc_plus_source  TEXT         NOT NULL DEFAULT 'ops_plus_proxy',
  source_url       TEXT,
  retrieved_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (batter_id, game_id)
);

COMMENT ON TABLE batter_game_log IS
  'Per-game batting stats for rolling-window wRC+/OPS+ feature construction. '
  'One row per batter per game. Source: MLB Stats API boxscore endpoint. '
  'wrc_plus stores OPS+ as a proxy for v0 (see wrc_plus_source). '
  'Feature team_wrcplus_l30_home/away reads from here. '
  'Backfilled for 2022-09 through 2024. Updated nightly after game completion.';

COMMENT ON COLUMN batter_game_log.pa IS
  'Plate appearances in this game. Used as weight in PA-weighted average wRC+ computation.';

COMMENT ON COLUMN batter_game_log.wrc_plus IS
  'Weighted Runs Created Plus (or OPS+ proxy for v0). NULL when the player has '
  'no qualifying at-bat history (e.g., pitcher hitting). '
  'Normalized to 100 = league average; higher = better hitter.';

COMMENT ON COLUMN batter_game_log.wrc_plus_source IS
  'Documents the computation method for wrc_plus. '
  'Known values: ''ops_plus_proxy'' (v0 default — uses MLB Stats API seasonStats.ops '
  'converted to OPS+ scale); ''true_wrc_plus'' (future — computed from wOBA components). '
  'Must match between training and serving for any given model version.';

-- FK + query pattern: WHERE batter_id = :id AND game_date BETWEEN ...
CREATE INDEX IF NOT EXISTS idx_bgl_batter_date
  ON batter_game_log(batter_id, game_date DESC);

-- Team rolling aggregate: WHERE team_id = :id AND game_date BETWEEN ...
CREATE INDEX IF NOT EXISTS idx_bgl_team_date
  ON batter_game_log(team_id, game_date DESC);

-- FK support
CREATE INDEX IF NOT EXISTS idx_bgl_game_id
  ON batter_game_log(game_id);

CREATE INDEX IF NOT EXISTS idx_bgl_updated_at
  ON batter_game_log(updated_at DESC);

-- Trigger
CREATE OR REPLACE TRIGGER set_updated_at_batter_game_log
  BEFORE UPDATE ON batter_game_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: service-role only
ALTER TABLE batter_game_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'batter_game_log'
      AND schemaname = 'public'
      AND policyname = 'batter_game_log_service_role_only'
  ) THEN
    CREATE POLICY "batter_game_log_service_role_only" ON batter_game_log
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
