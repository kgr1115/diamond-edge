### Proposal: wrcplus-ingestion-savant-2026-05-04

**Verdict:** APPROVED

**Rationale:** All eight locked criteria pass cleanly. The proposal closes a documented structural gap (2 of 11 v0 residuals forced to zero by NULL feature data in `batter_game_log.wrc_plus`), uses Baseball Savant — already integrated in `apps/web/lib/ingestion/stats/team-batting.ts` — as the source, adds $0 recurring cost, touches no compliance surface, requires no schema migration, does not expand sportsbook coverage or state availability, and routes the downstream retrain through the full pick-tester gate before any model swap. Both the CSO direction (`docs/proposals/moneyline-v0-validation-2026-05-04-verdict-cso.md`, condition `research_priority_next`) and the CEng cold-start follow-up condition (`team_wrcplus zero residuals are an ingester follow-up`, `docs/proposals/moneyline-v0-2026-04-30-rev3-bundled-report-verdict-ceng.md` line 25) explicitly name this as the required next step.

**Scope annotations (on APPROVED):**

- Files: `scripts/backfill-db/08b-batter-wrcplus-savant.mjs` (new), `apps/web/app/api/cron/wrcplus-refresh/route.ts` (new), `scripts/run-migrations/check-v0-wrcplus-coverage.mjs` (new), `apps/web/vercel.json` (one cron entry + one functions entry added). Four files total — within the ≤5 ceiling.
- `scripts/backfill-db/08-batter-game-log.mjs` is NOT modified. The new script supplements; it does not replace. Only `wrc_plus` and `wrc_plus_source` columns are written. `pa` and all other columns from the existing script are untouched.
- `apps/web/lib/features/moneyline-v0.ts` and `scripts/features/build-moneyline-v0.py` are NOT modified. Serving and training code already read the `wrc_plus` column; they activate automatically once data is present.
- `wrc_plus_source` value written on every row must be `'savant_szn_to_date_v1'`. Rows previously attempted by `08-batter-game-log.mjs` with `wrc_plus_source = 'ops_plus_proxy'` and NULL `wrc_plus` are valid targets for the UPDATE (overwrite the source value along with the wrc_plus value).
- Savant endpoint: per-player leaderboard CSV (`baseballsavant.mlb.com/leaderboard/custom?...&player_type=batter&csv=true&endDate=YYYY-MM-DD`). Parameterized by `endDate` for both backfill and daily modes from the same script. Do NOT use FanGraphs (ToS bars systematic use) or MLB Stats API OPS+ (inferior quality, contradicts the proposal's explicit source choice).
- Backfill window: 2022-09-01 through 2024-12-31 inclusive. Do not extend beyond 2024-12-31 until a fresh holdout declaration covers 2025 data.
- Interpretation B semantics: each row receives the season-to-date wRC+ as of that game's date. This matches what `moneyline-v0.ts:222-242` and `build-moneyline-v0.py` expect. Switching to per-game wRC+ (Interpretation A) is an architecture change requiring a separate proposal.
- Cron route must use the identical CRON_SECRET bearer check pattern as `apps/web/app/api/cron/odds-refresh/route.ts:17-30`. Schedule: `"0 11 * * *"` (06:00 ET = 11:00 UTC). `maxDuration` in `vercel.json` functions block: 60s (single Savant pull + batch UPDATE does not require 300s).
- No compliance surface touched. No subscriber bet/bankroll/subscription rows mutated. No sportsbook UX changes. No state availability changes. No LLM provider changes.
- Park-factor double-count is a known, accepted risk per the proposal's methodology risk log. No ingestion-time mitigation required. Post-retrain diagnostic requirement: if `park_factor_runs` coef collapses to |value| < 0.005 after the candidate retrain, stop promotion and surface to CEng before swapping `current/`.
- Holdout consumption: this retrain consumes the pinned `models/moneyline/holdout-declaration.json` (declaration_id `moneyline-v0-holdout-2026-05-03`). mlb-feature-eng must confirm the declaration file is unchanged before triggering the retrain. If any other retrain has touched it since 2026-05-03, stop and surface to CEng. The retrain after this one requires a fresh post-2024-12-31 declaration before training runs — this is a CEng follow-up at that retrain's pick-test verdict, not now.

**Testing requirements (on APPROVED):**

- Coverage gate before chain advances to mlb-feature-eng: `check-v0-wrcplus-coverage.mjs` must report ≥95% non-NULL `wrc_plus` across 2022-09-01 to 2024-12-31, broken down by season. Coverage below 95% stops the chain; mlb-data-engineer investigates and resolves before mlb-feature-eng fires.
- Idempotency: run the backfill against a 10-game sample twice. Row count must be identical after both runs. No duplicate rows. NULL rows where Savant returned no match must remain NULL (not 0, not 100 — a spurious 0 corrupts the PA-weighted rollup in serving).
- NULL handling: spot-check 20 `batter_game_log` rows where `wrc_plus` is NULL after the backfill. Confirm these correspond to players Savant genuinely does not include (very-low-PA players, pitchers hitting in NL-era games, call-ups with <1 PA in the leaderboard minimum). Accept NULL as the correct value for these rows; the serving code handles them via the `denom < 50 PA` fallback.
- Source field: SELECT a random 50-row sample from `batter_game_log` post-backfill. Every non-NULL `wrc_plus` row must show `wrc_plus_source = 'savant_szn_to_date_v1'`.
- `pa` column integrity: confirm zero rows have a changed `pa` value after the backfill run. The UPDATE must target only `wrc_plus` and `wrc_plus_source`.
- Savant 429 handling: confirm the script sleeps and retries on 429 without aborting the backfill. At minimum, review the code path and confirm a retry ceiling is set (no infinite loop).
- Daily cron date boundary: confirm the refresh route computes `endDate = yesterday` in ET, not UTC. A test case: a cron firing at 00:30 UTC on a Wednesday must compute Tuesday's date in ET (still Tuesday in ET at 00:30 UTC = 20:30 ET Monday — actually still Monday ET). The ET offset (-4 or -5 depending on DST) must be applied before deriving the `endDate` string. Exercise the DST boundary explicitly if the cron target date falls near a DST transition.
- Post-retrain pick-tester gate: report both `team_wrcplus_l30_home` and `team_wrcplus_l30_away` coef values alongside all nine existing residuals. Gate criteria per pick-tester spec: ROI ≥ -0.5% vs current v0 at the same EV threshold, CLV ≥ -0.1% vs current, ECE ≤ current ECE + 0.02. Block-bootstrap CI (7d) required alongside i.i.d. per CEng's `block_bootstrap_permanent_in_backtest_finalize` condition.
- wRC+-specific gate: if both `team_wrcplus_l30_home` and `team_wrcplus_l30_away` |coef| < 0.02 after non-NULL data, the retrained candidate does NOT promote to `current/`. The ingester ships regardless (it's correct and cheap). CSO receives the "ingested but not pulling weight" finding. Methodology direction re-prioritizes per the proposal's documented floor case.
- Park-factor diagnostic: report `park_factor_runs` coef in the candidate's `feature-coefficients.json`. If |value| < 0.005 (collapse to zero), stop promotion and surface to CEng.
- Candidate artifact: save to `models/moneyline/candidate-wrcplus-2026-05-04/`. Do NOT move anything under `models/moneyline/current/` until pick-tester PASS.

**Revision guidance (on DENIED):** N/A — verdict is APPROVED.

---

## Auto-chain pause

Per CLAUDE.md, scope-gate APPROVED → implement-change auto-fires. **Kyle explicitly requested "queue wRC+" rather than "execute wRC+"**, which the orchestrator is interpreting as a pause-point at the implementer dispatch (CLAUDE.md auto-chain pause-point #8: "User explicitly requests pause mid-pipeline"). This APPROVED verdict is the queued artifact; mlb-data-engineer is NOT auto-fired. Resume by user instruction (`/pick-implement` or "go ahead with wRC+").
