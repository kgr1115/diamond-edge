-- Enforce one logical pick per (game, market, side, date).
-- Backfill via scripts/run-migrations/dedupe-picks-backfill.mjs --apply MUST run first.
CREATE UNIQUE INDEX IF NOT EXISTS picks_natural_uniq
  ON picks(game_id, market, pick_side, pick_date);
