-- Migration 0026: add closing_snapshot flag to odds
-- Backward-compatible: NOT NULL DEFAULT false means existing rows correctly
-- default to "not a closing snapshot" with no separate backfill pass.
-- The DEFAULT supplies the false value at column-add time for all live rows.
-- Depends on: 0004_core_tables.sql (odds)

ALTER TABLE odds
  ADD COLUMN IF NOT EXISTS closing_snapshot BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN odds.closing_snapshot IS
  'True when this snapshot was captured at or after game_time_utc, or within '
  'the pre-game closing window (default: game_time_utc - 5 minutes) with no '
  'subsequent line movement detected. Set by the odds-refresh ingester. '
  'Used by the feature layer to identify the closing line for CLV computation '
  'and training-data construction. closing_snapshot = true AND '
  'snapshotted_at <= as_of should never appear in a valid training row. '
  'See ADR-003.';

-- Unique partial index: enforces at most one closing snapshot per
-- (game, book, market) at the database level. Supports the common
-- training query "fetch the closing row per game per book per market"
-- without scanning the full odds append log.
-- A second attempt to flag a row as closing raises a unique violation —
-- the ingester should set the earlier row to false before inserting/updating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_odds_closing_per_game_book_market
  ON odds(game_id, sportsbook_id, market)
  WHERE closing_snapshot = true;

-- Secondary index for the look-ahead audit query:
--   WHERE closing_snapshot = true AND snapshotted_at <= :as_of
--   (this pattern should never appear in a valid training row)
CREATE INDEX IF NOT EXISTS idx_odds_closing_snapshotted_at
  ON odds(snapshotted_at DESC)
  WHERE closing_snapshot = true;
