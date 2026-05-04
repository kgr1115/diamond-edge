-- Migration 0031: pitcher_game_log.fb_source — provenance audit for the fb column
--
-- Background: migration 0030 added pitcher_game_log.fb sourced from MLB Stats API
-- boxscore pitching.flyOuts. That field counts outs-on-flyballs only — flyballs
-- that became hits or HRs are excluded. The FanGraphs xFIP definition uses TOTAL
-- flyballs (all outcomes), so the boxscore-derived value systematically underestimates
-- xFIP by ~0.7 units (verified against 5 spot-check pitchers, 5/5 fail at ±0.20).
--
-- This migration adds a provenance column to distinguish legacy rows
-- ('mlb_boxscore_flyouts') from rows re-sourced via Baseball Savant pitch-by-pitch
-- bb_type='fly_ball' aggregation ('statcast_bb_type_v1'). The column enables:
--   1. Targeted rollback (UPDATE … WHERE fb_source = 'statcast_bb_type_v1')
--   2. Coverage audit (post-backfill query for fb_source still at 'mlb_boxscore_flyouts')
--   3. Re-run safety (07-pitcher-game-log.mjs no longer touches fb after this chain)
--
-- Source proposal: docs/proposals/statcast-fb-ingestion-2026-05-04.yaml
-- Architect consult: per-column TEXT shape approved over JSONB provenance object.

ALTER TABLE pitcher_game_log
  ADD COLUMN IF NOT EXISTS fb_source TEXT NOT NULL DEFAULT 'mlb_boxscore_flyouts';

COMMENT ON COLUMN pitcher_game_log.fb_source IS
  'Provenance for the fb column. Values: '
  '''mlb_boxscore_flyouts'' (initial source via 07-pitcher-game-log.mjs; outs-on-flyballs only — incorrect semantics, default for pre-backfill rows); '
  '''statcast_bb_type_v1'' (Savant bb_type=''fly_ball'' only — undercounts FG ''FB'' by ~30-40% because popups are excluded; superseded by v2); '
  '''statcast_bb_type_v2'' (Savant bb_type ∈ {''fly_ball'', ''popup''} aggregation; matches FanGraphs xFIP ''FB'' definition, verified vs MLB Stats API sabermetrics xfip on 5 spot-check pitchers). '
  'Updated by scripts/backfill-db/09-pitcher-fb-statcast.mjs (historical backfill) and /api/cron/statcast-fb-refresh (daily incremental). '
  'Targeted rollback to pre-Statcast state: UPDATE pitcher_game_log SET fb=0, fb_source=''mlb_boxscore_flyouts'' WHERE fb_source IN (''statcast_bb_type_v1'',''statcast_bb_type_v2'').';
