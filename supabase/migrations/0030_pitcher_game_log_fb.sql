-- Migration 0030: pitcher_game_log.fb (flyouts per appearance) for xFIP computation
-- Source: MLB Stats API /game/{gamePk}/boxscore — `pitching.flyOuts` field (live-probed 2026-05-04)
-- Scope: infra-only — adds the column + populates via existing 07-pitcher-game-log.mjs backfill rerun.
--        Production v0 served payload is NOT changed by this migration; the xFIP feature is not
--        wired into apps/web/lib/features/moneyline-v0.ts this cycle (CSO + CEng condition).
-- Source proposal: docs/proposals/stuff-plus-ingestion-2026-05-04-infra-scope-gate-verdict.md
--
-- DEFAULT 0 backfills existing rows safely (NOT NULL holds). The xFIP formula treats fb=0 as
-- "no flyouts in window" — equivalent to a pure groundball/strikeout outing — so the default is
-- semantically correct for a row that has not yet been re-parsed. Re-running 07-pitcher-game-log.mjs
-- with the parser extension overwrites the default with the true MLB API value.

ALTER TABLE pitcher_game_log
  ADD COLUMN IF NOT EXISTS fb SMALLINT NOT NULL DEFAULT 0 CHECK (fb >= 0);

COMMENT ON COLUMN pitcher_game_log.fb IS
  'Flyouts per appearance, sourced from MLB Stats API boxscore `pitching.flyOuts` field. '
  'Used for xFIP computation: xFIP = ((13 * FB * lgHRperFB) + 3*(BB+HBP) - 2*K) / IP + xFIP_const. '
  'Excludes popups (which have ~0 HR/FB rate); MLB API exposes `flyOuts` and `popOuts` separately, '
  '`airOuts = flyOuts + popOuts`. Backfilled via scripts/backfill-db/07-pitcher-game-log.mjs. '
  'Default 0 applies to pre-migration rows until the backfill rerun overwrites them.';
