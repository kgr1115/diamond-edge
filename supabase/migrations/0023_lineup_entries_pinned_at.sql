-- Migration 0023: add pinned_at to lineup_entries
-- Backward-compatible: nullable column, no DEFAULT.
-- Existing rows get NULL (correct — no historical pin was taken).
-- Depends on: 0012_stats_tables.sql (lineup_entries)

ALTER TABLE lineup_entries
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

COMMENT ON COLUMN lineup_entries.pinned_at IS
  'Timestamp at which this row was explicitly snapshotted as the T-60min '
  'training pin. NULL for historical rows without a deliberate pin. Distinct '
  'from updated_at, which reflects the most recent write. Set by the '
  'lineup-sync cron when it materializes a confirmed lineup snapshot for '
  'feature construction. See ADR-003.';

-- Partial index: supports the feature layer join
--   WHERE game_id = :game_id AND team_id = :team_id AND pinned_at <= :as_of
-- and the look-ahead audit:
--   WHERE pinned_at IS NOT NULL ORDER BY pinned_at
-- Only indexes rows that actually have a pin — keeps the index small.
CREATE INDEX IF NOT EXISTS idx_le_pinned_at
  ON lineup_entries(game_id, team_id, pinned_at)
  WHERE pinned_at IS NOT NULL;
