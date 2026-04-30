-- OPTIONAL: wipe analysis-output rows from pick tables.
-- NOT auto-applied. Kyle decides whether to clear history before the
-- replacement analysis layer ships.
--
-- Schemas are preserved either way. This only wipes ROWS.
--
-- If you want to keep rows for historical analysis / replay later,
-- DO NOTHING here.
--
-- If you want a clean slate (no historical picks, no rationales, no CLV):

BEGIN;

-- Children first to satisfy FKs
DELETE FROM feature_attributions;
DELETE FROM pick_clv;
DELETE FROM pick_outcomes;

-- Pick rows
DELETE FROM picks_today;
DELETE FROM picks;

-- Rationale cache (will rebuild from scratch under new analysis layer)
DELETE FROM rationale_cache;

-- Verify:
--   SELECT 'picks' AS t, COUNT(*) FROM picks
--   UNION ALL SELECT 'picks_today', COUNT(*) FROM picks_today
--   UNION ALL SELECT 'pick_outcomes', COUNT(*) FROM pick_outcomes
--   UNION ALL SELECT 'pick_clv', COUNT(*) FROM pick_clv
--   UNION ALL SELECT 'rationale_cache', COUNT(*) FROM rationale_cache
--   UNION ALL SELECT 'feature_attributions', COUNT(*) FROM feature_attributions;
-- All should be 0.

COMMIT;

-- If anything looks wrong, ROLLBACK before COMMIT runs.
