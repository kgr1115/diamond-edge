-- Migration 0027: v0 cluster audit columns
-- Adds games.divisional_flag and odds.source for moneyline v0 cold-start audit.
-- Depends on: 0003_reference_tables.sql (teams), 0004_core_tables.sql (games, odds)
--
-- games.divisional_flag — CEng per-cluster proxy audit (rev2 condition: cluster
--   cuts include `divisional`). Backfilled via JOIN on teams.division text column.
--
-- odds.source — CSO monthly train-vs-serve residual metric (rev2 condition: log
--   Pinnacle-vs-DK/FD residual on a recurring cadence). Existing rows are
--   'odds_api_live' per their actual provenance.

-- ============================================================
-- games.divisional_flag
-- ============================================================

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS divisional_flag BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN games.divisional_flag IS
  'True when home_team_id and away_team_id are in the same MLB division '
  '(i.e., teams.division is identical for both). Backfilled at migration time '
  'via JOIN on teams.division. Needed for CEng per-cluster proxy audit '
  '(moneyline v0 rev2 verdict condition: cluster cuts include divisional). '
  'Refreshed by the ingestion job on game upsert.';

-- Backfill: same division string = divisional game.
-- teams.division holds 'AL East', 'NL West', etc. — plain text equality is safe.
-- Note: Postgres UPDATE...FROM does not allow JOIN to reference the UPDATE
-- target inside ON; use comma-list with join conditions in WHERE.
UPDATE games g
SET divisional_flag = true
FROM teams ht, teams away_team
WHERE ht.id = g.home_team_id
  AND away_team.id = g.away_team_id
  AND ht.division = away_team.division;

-- ============================================================
-- odds.source
-- ============================================================

ALTER TABLE odds
  ADD COLUMN IF NOT EXISTS source TEXT;

COMMENT ON COLUMN odds.source IS
  'Origin tag for this odds row. Known values: '
  '''odds_api_live'' — live DK/FD snapshots from The Odds API (default for all '
  'existing rows); '
  '''pinnacle_archive'' — backfilled historical Pinnacle lines; '
  '''kaggle_dk_fd_dataset'' — fallback dataset rows if used. '
  'NULL is permitted for rows written before this column existed. '
  'Needed for CSO monthly train-vs-serve Pinnacle-vs-DK/FD residual metric.';

-- Backfill existing rows: they all came from live Odds API ingestion.
UPDATE odds
SET source = 'odds_api_live'
WHERE source IS NULL;

-- Index for the recurring residual query pattern:
--   WHERE source = 'pinnacle_archive' AND game_id = :game_id
-- and the cross-source join used to compute Pinnacle-vs-DK/FD residual.
CREATE INDEX IF NOT EXISTS idx_odds_source_game_id
  ON odds(source, game_id);
