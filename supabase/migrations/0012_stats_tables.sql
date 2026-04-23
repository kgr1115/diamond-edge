-- Diamond Edge — Stats Tables for Full 90-Feature Vector
-- Run order: 12 (depends on: players, teams, games from 0003, 0004)
--
-- Adds five tables that wire the 44 currently-imputed features to real data:
--   pitcher_season_stats  — 24 SP numeric features
--   bullpen_team_stats    — 10 bullpen features
--   team_batting_stats    — 14 team batting features
--   umpire_assignments    — 3 umpire features
--   lineup_entries        — 3 platoon/lineup features
--
-- All tables are service-role-only (no user-facing reads).
-- RLS enabled on every table; authenticated and anon roles cannot read.
-- Ingestion writes via service-role key only.

-- ============================================================
-- pitcher_season_stats
-- Per pitcher per season. Source: MLB Stats API /people/{id}/stats
-- + Baseball Savant leaderboard (swstr_rate, barrel_rate, avg_ev,
--   zone_rate, chase_rate are Statcast-only; imputed when unavailable).
-- PK: (player_id, season) — one row per pitcher per season.
-- ============================================================

CREATE TABLE pitcher_season_stats (
  player_id           uuid        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season              smallint    NOT NULL,

  -- Core MLB Stats API fields
  innings_pitched     real,                 -- decimal IP, e.g. 120.333
  era                 real,
  fip                 real,
  xfip                real,
  whip                real,
  k_per_9             real,
  bb_per_9            real,
  hr_per_9            real,
  k_rate              real,                 -- K/PA
  bb_rate             real,                 -- BB/PA
  hr_rate             real,                 -- HR/PA

  -- Statcast / Baseball Savant fields (nullable if scraping unavailable)
  swstr_rate          real,                 -- swinging strike rate
  gb_rate             real,                 -- ground ball rate
  ld_rate             real,                 -- line drive rate
  fb_rate             real,                 -- fly ball rate
  pull_rate           real,                 -- pull%
  hard_hit_rate       real,                 -- hard hit%
  barrel_rate         real,                 -- barrel%
  avg_ev              real,                 -- average exit velocity (mph)
  zone_rate           real,                 -- zone% (pitches in zone)
  chase_rate          real,                 -- O-Swing%
  first_strike_rate   real,                 -- first pitch strike%

  updated_at          timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (player_id, season)
);

CREATE INDEX idx_pss_player_season ON pitcher_season_stats(player_id, season);
CREATE INDEX idx_pss_updated_at    ON pitcher_season_stats(updated_at DESC);

ALTER TABLE pitcher_season_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pitcher_season_stats_service_role_only" ON pitcher_season_stats
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_pitcher_season_stats_updated_at
  BEFORE UPDATE ON pitcher_season_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- bullpen_team_stats
-- Per team per season (refreshed daily; last-7d/last-3d fields
-- are rolling windows computed at ingest time from game appearances).
-- Source: aggregated from pitcher_season_stats (role != SP) +
--         MLB Stats API game-by-game appearance data.
-- PK: (team_id, season)
-- ============================================================

CREATE TABLE bullpen_team_stats (
  team_id                     uuid        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season                      smallint    NOT NULL,

  bullpen_era                 real,
  bullpen_fip                 real,
  bullpen_whip                real,
  bullpen_k_rate              real,
  bullpen_bb_rate             real,
  bullpen_hr_rate             real,

  -- Rolling load windows (decimal innings pitched)
  bullpen_ip_last_7d          real        NOT NULL DEFAULT 0,
  bullpen_pitches_last_3d     integer     NOT NULL DEFAULT 0,

  -- Availability scores (0.0–1.0; 1.0 = fully fresh)
  closer_availability         real        NOT NULL DEFAULT 1.0
                                CHECK (closer_availability BETWEEN 0 AND 1),
  high_leverage_availability  real        NOT NULL DEFAULT 1.0
                                CHECK (high_leverage_availability BETWEEN 0 AND 1),

  updated_at                  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (team_id, season)
);

CREATE INDEX idx_bts_team_season  ON bullpen_team_stats(team_id, season);
CREATE INDEX idx_bts_updated_at   ON bullpen_team_stats(updated_at DESC);

ALTER TABLE bullpen_team_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bullpen_team_stats_service_role_only" ON bullpen_team_stats
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_bullpen_team_stats_updated_at
  BEFORE UPDATE ON bullpen_team_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- team_batting_stats
-- Per team per season. Source: MLB Stats API
-- /teams/{teamId}/stats?stats=season&group=hitting&season=YYYY
-- PK: (team_id, season)
-- ============================================================

CREATE TABLE team_batting_stats (
  team_id         uuid        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season          smallint    NOT NULL,

  avg             real,                 -- batting average
  obp             real,                 -- on-base percentage
  slg             real,                 -- slugging percentage
  ops             real,                 -- OPS
  iso             real,                 -- isolated power = SLG - AVG
  babip           real,                 -- BABIP
  k_rate          real,                 -- K/PA
  bb_rate         real,                 -- BB/PA
  hr_rate         real,                 -- HR/PA
  woba            real,                 -- wOBA (computed from Statcast or FanGraphs)
  wrc_plus        smallint,            -- wRC+ (integer index; 100 = league avg)
  hard_hit_rate   real,                 -- hard hit% (Statcast)
  barrel_rate     real,                 -- barrel% (Statcast)

  -- 14-day rolling OPS for recency signal (computed at ingest from recent game logs)
  ops_last_14d    real,

  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (team_id, season)
);

CREATE INDEX idx_tbs_team_season  ON team_batting_stats(team_id, season);
CREATE INDEX idx_tbs_updated_at   ON team_batting_stats(updated_at DESC);

ALTER TABLE team_batting_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_batting_stats_service_role_only" ON team_batting_stats
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_team_batting_stats_updated_at
  BEFORE UPDATE ON team_batting_stats
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- umpire_assignments
-- Per game. Source: MLB game feed /game/{gamePk}/feed/live
-- officials[] array (populated T-2h before first pitch).
-- Umpire performance stats (ump_k_rate, ump_bb_rate,
-- ump_strike_zone_size) sourced from UmpScorecards.com CSV or
-- computed from historical game logs joined on umpire name.
-- PK: (game_id) — one HP ump per game.
-- ============================================================

CREATE TABLE umpire_assignments (
  game_id                 uuid        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  home_plate_umpire_name  text        NOT NULL,

  -- Career / season averages for this umpire
  ump_k_rate              real,        -- fraction of PA ending in K under this ump
  ump_bb_rate             real,        -- fraction of PA ending in BB under this ump
  ump_strike_zone_size    real,        -- relative zone size (1.0 = league avg)

  updated_at              timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (game_id)
);

CREATE INDEX idx_ua_game_id    ON umpire_assignments(game_id);
CREATE INDEX idx_ua_ump_name   ON umpire_assignments(home_plate_umpire_name);
CREATE INDEX idx_ua_updated_at ON umpire_assignments(updated_at DESC);

ALTER TABLE umpire_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "umpire_assignments_service_role_only" ON umpire_assignments
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_umpire_assignments_updated_at
  BEFORE UPDATE ON umpire_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- lineup_entries
-- Per game per batting position (1–9) per team.
-- Source: MLB Stats API boxscore teams.{side}.batters array
-- (confirmed T-60min); pre-game uses recent starting lineup
-- aggregate as placeholder (confirmed = false).
-- PK: (game_id, team_id, batting_order)
-- ============================================================

CREATE TABLE lineup_entries (
  game_id         uuid        NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id         uuid        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  batting_order   smallint    NOT NULL CHECK (batting_order BETWEEN 1 AND 9),
  player_id       uuid                 REFERENCES players(id),
  bat_side        char(1)              CHECK (bat_side IN ('L', 'R', 'S')),
  confirmed       boolean     NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (game_id, team_id, batting_order)
);

CREATE INDEX idx_le_game_id    ON lineup_entries(game_id);
CREATE INDEX idx_le_team_id    ON lineup_entries(team_id);
CREATE INDEX idx_le_player_id  ON lineup_entries(player_id);
CREATE INDEX idx_le_updated_at ON lineup_entries(updated_at DESC);

ALTER TABLE lineup_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lineup_entries_service_role_only" ON lineup_entries
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE TRIGGER trg_lineup_entries_updated_at
  BEFORE UPDATE ON lineup_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
