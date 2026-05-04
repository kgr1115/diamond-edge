### Proposal: statcast-fb-ingestion-2026-05-04 (Statcast batted-ball ingestion as xFIP remediation)

**Verdict:** APPROVED

**Rationale:** Remediation of a previously-approved infra path (xFIP infra, scope-gate APPROVED in `dc23022`) that failed at the verification gate due to wrong source semantics. Replaces MLB boxscore `flyOuts` (outs-only) with Savant `bb_type='fly_ball'` (total flyballs). Stack-conformant, $0/mo, fully reversible, non-subscriber data, additive migration with explicit rollback.

**Scope annotations:**
- **File scope:** 6 files (4 new + 2 modified). One file over the ≤5 guideline; splitting would be artificial since the unit is "one feature-source pivot." Allowed without decomposition.
  - New: `supabase/migrations/0031_pitcher_game_log_fb_source.sql`, `scripts/backfill-db/09-pitcher-fb-statcast.mjs`, `apps/web/app/api/cron/statcast-fb-refresh/route.ts`, `tests/fixtures/feature-parity/xfip-statcast-verification-2026-05-04.json`
  - Modified: `scripts/backfill-db/07-pitcher-game-log.mjs` (remove `fb` from `parsePitcherStats()` + upsert SET clause), `apps/web/vercel.json` (cron entry + functions maxDuration entry)
- **Compliance surfaces touched:** none. `user_facing: no`. No 21+/geo/RG disclaimer surfaces. Tester does NOT need to verify subscriber-facing compliance for this change.
- **Cost impact accepted:** $0/month delta. Vercel function 4,500s/mo within Pro tier included allocation. Savant free.
- **Migration policy:** migration 0031 is additive (TEXT column with default 'mlb_boxscore_flyouts'). Touches 61,950 existing rows (default-write only — no semantic change to existing data). Backfill rewrites ~19,440 rows of `pitcher_game_log.fb` for 2021-2024 starters, distinguishable post-hoc via `fb_source = 'statcast_bb_type_v1'`. Pause point #7 NOT triggered — model-feature data, not subscriber data.
- **Architect consult:** flagged in proposal for migration 0031 column shape (per-column TEXT vs shared JSONB). LOW stakes per proposer. **Defer to mlb-architect for a fast verdict before implementer writes migration 0031.** If consult returns within 1 hour with no objection, implementer defaults to per-column TEXT (proposer's choice).
- **Non-negotiables:**
  - The `fb` parse in `scripts/backfill-db/07-pitcher-game-log.mjs` line 63 MUST be removed (and the `fb` field MUST be removed from the upsert SET clause) in the SAME diff as the Statcast pipeline lands. Leaving it active would re-overwrite Statcast values on any re-run of `07-pitcher-game-log.mjs`. Tester verifies this surgical change.
  - Backfill script runs at ≥3-second cadence per request. Implementer must wire exponential backoff (5s → 120s, 5 retries, dead-letter to `cron_runs`) for 429/5xx.
  - `models/moneyline/current/` and `models/moneyline/holdout-declaration.json` MUST NOT be touched in this chain. Retrain is deferred per CSO/CEng conditions in the prior xFIP infra verdict.
  - Verification gate: 5/5 pitchers within ±0.20 xFIP units vs FanGraphs truth. No exceptions on PASS. Soft-fail (1 between 0.20 and 0.40) requires CEng review before chain advances.

**Testing requirements:**
- **Migration 0031 dry-run:** apply against a dev DB; verify all 61,950 rows of `pitcher_game_log` get `fb_source = 'mlb_boxscore_flyouts'`; verify DROP COLUMN reverses cleanly; no FK/RLS breakage.
- **Backfill script edge cases:**
  - 0 pitchers returned for a season (off-season / empty result) — script exits cleanly, writes WARN, no DB writes.
  - 1 pitcher with 1 game in window — single upsert succeeds, fb_source updated to 'statcast_bb_type_v1'.
  - Many pitchers (worst-case ~600 per season) — completes within 2.5h target wall time.
  - HTTP 429 mid-run — exponential backoff fires; eventual success within 5 retries; dead-letter on 5th retry.
  - Schema drift (CSV missing `bb_type`) — structured WARN logged with actual columns; row skipped; cron_runs entry reflects failure.
  - Coverage check — post-run audit query confirms ≥95% non-NULL fb per backfilled season.
- **Daily cron edge cases:**
  - No games yesterday (MLB off-day in November-March) — cron returns 200 with `pitchers_processed: 0`, no Savant requests, no DB writes.
  - 30-pitcher worst case — completes within 180s `maxDuration` ceiling.
  - CRON_SECRET bearer check — request without correct header returns 401 (matches existing `odds-refresh` pattern).
  - Pitcher_game_log row missing for a Savant-returned pitcher (data race) — upsert with ON CONFLICT (pitcher_id, game_id) creates or updates correctly.
- **07-pitcher-game-log.mjs surgery:**
  - Re-running the modified script does NOT overwrite Statcast `fb` values — confirmed by inspecting `fb_source` column post-run (must remain 'statcast_bb_type_v1' for any rows the script touches).
  - The other fields (ip, hr, bb, hbp, k, is_starter) DO continue to update correctly.
- **Verification gate fixture:**
  - `tests/fixtures/feature-parity/xfip-statcast-verification-2026-05-04.json` written with the 5-pitcher schema specified in proposal section 7.
  - All 5 pass at ±0.20 vs FanGraphs truth.
- **Pipeline non-degradation:** existing crons (`pick-pipeline`, `clv-compute`, `calibration-snapshot`, `odds-refresh`, `schedule-sync`, `outcome-grader`) untouched and continue to fire on schedule. The new cron entry in `vercel.json` does not displace any existing entry.
- **Compliance surfaces:** N/A — no subscriber-facing change. Tester explicitly notes "no compliance surface touched" in test report.

**Auto-chain:** Per CLAUDE.md, on APPROVED auto-fire `implement-change`. mlb-architect consult on migration 0031 shape runs in parallel — implementer waits on its return (or 1h timeout, then defaults to per-column TEXT) before writing migration 0031.
