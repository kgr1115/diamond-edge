-- Diamond Edge — Core Tables
-- Run order: 4 (depends on: enums, lookup tables, reference tables)
--
-- NOTE: rationale_cache is created BEFORE picks to satisfy the FK reference
-- in picks.rationale_id. rationale_cache.pick_id is a plain UUID (no FK) to
-- break the circular dependency; pick_id is populated after picks are created.

-- ============================================================
-- games
-- One row per MLB game. Upserted by the ingestion job.
-- Append-on-new-game; updates on status/score/pitcher changes.
-- ============================================================

CREATE TABLE games (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_game_id                integer     NOT NULL UNIQUE,
  game_date                  date        NOT NULL,
  game_time_utc              timestamptz,
  status                     game_status NOT NULL DEFAULT 'scheduled',
  home_team_id               uuid        NOT NULL REFERENCES teams(id),
  away_team_id               uuid        NOT NULL REFERENCES teams(id),
  home_score                 smallint,
  away_score                 smallint,
  inning                     smallint,
  venue_name                 text,
  venue_state                char(2),
  weather_condition          text,        -- 'clear', 'cloudy', 'rain'
  weather_temp_f             smallint,
  weather_wind_mph           smallint,
  weather_wind_dir           text,
  probable_home_pitcher_id   uuid        REFERENCES players(id),
  probable_away_pitcher_id   uuid        REFERENCES players(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_games_game_date     ON games(game_date);
CREATE INDEX idx_games_mlb_game_id   ON games(mlb_game_id);
CREATE INDEX idx_games_status        ON games(status);
CREATE INDEX idx_games_home_team_id  ON games(home_team_id);
CREATE INDEX idx_games_away_team_id  ON games(away_team_id);

ALTER TABLE games ENABLE ROW LEVEL SECURITY;
CREATE POLICY "games_select_public" ON games FOR SELECT USING (true);

-- ============================================================
-- odds
-- Append-only snapshots. One row per game + market + book + time.
-- Never updated; query with ORDER BY snapshotted_at DESC for latest.
-- ============================================================

CREATE TABLE odds (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id          uuid        NOT NULL REFERENCES games(id),
  sportsbook_id    uuid        NOT NULL REFERENCES sportsbooks(id),
  market           market_type NOT NULL,
  -- Moneyline / run line prices in American odds (e.g., -110, +105)
  home_price       integer,
  away_price       integer,
  -- Totals
  total_line       numeric(4,1),
  over_price       integer,
  under_price      integer,
  -- Props
  prop_description text,
  prop_line        numeric(6,2),
  prop_over_price  integer,
  prop_under_price integer,
  -- Run line spread (almost always ±1.5 in MLB)
  run_line_spread  numeric(3,1),
  -- Snapshot metadata
  snapshotted_at   timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_odds_game_id          ON odds(game_id);
CREATE INDEX idx_odds_game_book_market ON odds(game_id, sportsbook_id, market, snapshotted_at DESC);
CREATE INDEX idx_odds_snapshotted_at   ON odds(snapshotted_at DESC);

ALTER TABLE odds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "odds_select_public" ON odds FOR SELECT USING (true);

-- ============================================================
-- rationale_cache
-- LLM-generated rationale. Created BEFORE picks table to satisfy
-- the picks.rationale_id FK. rationale_cache.pick_id is set after
-- the pick row is created (nullable, no FK constraint — intentional).
-- ============================================================

CREATE TABLE rationale_cache (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id        uuid,        -- set after pick row created; nullable to allow pre-generation
  model_used     text        NOT NULL,   -- 'claude-haiku-4-5', 'claude-sonnet-4-6'
  prompt_hash    text        NOT NULL UNIQUE,  -- SHA-256 of prompt for dedup
  rationale_text text        NOT NULL,
  tokens_used    integer,
  cost_usd       numeric(8,6),
  generated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rationale_cache_pick_id     ON rationale_cache(pick_id);
CREATE INDEX idx_rationale_cache_prompt_hash ON rationale_cache(prompt_hash);

ALTER TABLE rationale_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rationale_select_authenticated" ON rationale_cache
  FOR SELECT TO authenticated USING (true);
