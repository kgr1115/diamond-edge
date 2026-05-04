### Proposal: wrcplus-ingestion-revB-2026-05-04

**Verdict:** APPROVED

**Rationale:** All eight locked criteria pass. Live probes killed every simpler source path (Savant per-player CSV column empty, Savant team CSV 404, MLB Stats API season endpoint returns no wRC+). The compute-from-raw path using MLB Stats API byDateRange + hand-transcribed league constants + existing `park_factor_runs` is the only remaining viable route to fulfill the standing CSO direction. $0 recurring cost. No schema migration (column exists per migration 0029). No compliance surface touched. The effort increase from rev A (~1.5 days) to rev B (~3-4 days) does not require CSO re-consult — the CSO directed the destination, not the path, and the personal-tool/portfolio phase explicitly tolerates this level of investment. The tight pre-retrain verification gate (5 spot-checks against the MLB Stats API sabermetrics endpoint before holdout consumption) provides formula-correctness assurance that rev A's "just works" path did not need.

**Scope annotations (on APPROVED):**

Files (4 new, 1 existing modified with 2 line additions, no file replaced):

- `scripts/lib/wrc-plus-formula.ts` (new) — pure compute module. Inputs: per-player counting stats over a window, season year, park_factor (decimal, 1.00 = neutral). Output: wRC+ integer. No API calls. No side effects. Hardcoded `LEAGUE_WOBA_CONSTANTS` object covering 2022, 2023, 2024. Source URL (Tom Tango's tangotiger.com wOBA year-by-year page) AND transcription date must appear in a comment directly above the constants declaration. A TODO comment must state the 2025 refresh obligation. Unit tests live alongside this file.
- `scripts/backfill-db/08b-batter-wrcplus-compute.mjs` (new) — MLB Stats API byDateRange loop + Supabase UPDATE. Only writes `wrc_plus` and `wrc_plus_source = 'mlb_computed_v1'`. Does NOT modify `08-batter-game-log.mjs`. Does NOT write `pa` or any other column.
- `apps/web/app/api/cron/wrcplus-refresh/route.ts` (new) — CRON_SECRET bearer check must match `apps/web/app/api/cron/odds-refresh/route.ts:17-30` exactly. Schedule `"0 11 * * *"` (06:00 ET). `maxDuration: 60`.
- `scripts/run-migrations/check-v0-wrcplus-coverage.mjs` (new) — read-only diagnostic; % non-NULL `wrc_plus` per season in 2022-09-01 to 2024-12-31.
- `apps/web/vercel.json` (existing) — add one cron entry (`/api/cron/wrcplus-refresh` at `"0 11 * * *"`) and one functions entry (`"app/api/cron/wrcplus-refresh/route.ts": { "maxDuration": 60 }`). No other line touched.

Column writes:
- `batter_game_log.wrc_plus` (SMALLINT, already exists) — computed value, rounded to nearest integer.
- `batter_game_log.wrc_plus_source` (TEXT, already exists) — set to `'mlb_computed_v1'` on every written row.
- No other column is written. `pa` and all other existing columns are untouched.

Constants table maintenance:
- Lives in `scripts/lib/wrc-plus-formula.ts` as a hardcoded TS object, NOT in Supabase.
- Owner: mlb-data-engineer. Refresh cadence: once per season, after Tom Tango / FanGraphs publishes finalized weights for the prior year (typically January).
- Source URL + transcription date in code comment above the declaration. This annotation is non-negotiable — the next engineer adding 2025 constants needs to know exactly where to verify.
- Add 2025 constants before any 2025-data retrain. This is a project_state follow-up item, not a current-proposal blocker.

Park-factor decimal conversion (non-negotiable):
- `park_factor_runs.runs_factor` is stored normalized to 100 (100 = league average). The wRC+ formula requires a decimal park factor (1.00 = neutral). `runs_factor / 100.0` before using in the formula. Using `runs_factor` raw corrupts the park adjustment by a factor of 100.

Interpretation B (season-to-date, no look-ahead):
- Each row receives season-to-date wRC+ as of `game_date - 1`. The byDateRange call uses `startDate = season opening day for that season` and `endDate = game_date - 1`. Do NOT use same-day data.
- For batters below a meaningful PA threshold early in a season: write NULL, not 0 and not 100. The serving code PA-weighted rollup handles NULL correctly; a spurious 0 or 100 corrupts it.
- Switching to L30 wRC+ (Interpretation A) is a separate proposal — out of scope here.

No change to:
- `apps/web/lib/features/moneyline-v0.ts` (serving activates automatically)
- `scripts/features/build-moneyline-v0.py` (training activates automatically)
- `models/moneyline/current/` (untouched until post-retrain pick-tester PASS)
- Any subscriber bet, bankroll, or subscription row

Compliance surface: none touched. No 21+ gate, geo-block, or RG disclaimer surface affected.

Effort flag: CSO re-consult not required. Proceeding on the strength of the unchanged CSO direction and the fact that rev B is the only viable implementation path.

**Testing requirements (on APPROVED):**

Verification gate — runs before mlb-model retrains (mlb-feature-eng owns):
- Compute full-season 2024 wRC+ using the formula module for 5 batters: Aaron Judge 2024, Bobby Witt Jr 2024, Mookie Betts 2023, Aaron Judge 2023, Aaron Judge 2022. Pull corresponding `wRcPlus` from `statsapi.mlb.com/api/v1/people/{id}/stats?stats=sabermetrics&season=YYYY&group=hitting`. PASS = all 5 within ±3. FAIL = chain stops; mlb-data-engineer fixes constants table or formula before advancing. This gate is mandatory — it is the only formula-correctness check before holdout consumption.

Coverage gate — after backfill, before mlb-feature-eng fires (mlb-data-engineer owns):
- `check-v0-wrcplus-coverage.mjs` reports ≥95% non-NULL `wrc_plus` across 2022-09-01 to 2024-12-31, broken out by season. Below 95% for any season stops the chain.

Idempotency:
- Run the backfill against a 10-game sample twice. Row count identical after both runs. No duplicate rows.

NULL handling:
- Spot-check 20 post-backfill NULL rows. Confirm each corresponds to a genuinely excluded batter. NULL is the correct value. Zero is not acceptable as a NULL substitute.

Source field integrity:
- SELECT 50 random non-NULL rows post-backfill. Every row must show `wrc_plus_source = 'mlb_computed_v1'`.

`pa` column integrity:
- Confirm zero rows have a changed `pa` value after the backfill run.

Rate-limit / retry:
- Confirm the byDateRange loop sleeps on HTTP 429 and retries with exponential backoff. Retry ceiling required (no infinite loop). Backfill scheduled for an off-peak window outside existing cron slots.

Daily cron date boundary:
- Confirm `endDate = yesterday` is computed in ET (UTC-4/5 with DST), not UTC.

Holdout declaration check (mlb-feature-eng, before retrain):
- Confirm `models/moneyline/holdout-declaration.json` declaration_id is still `moneyline-v0-holdout-2026-05-03` and the file is unchanged. If any other retrain has touched it since 2026-05-03, stop and surface to CEng.

Post-retrain pick-tester gates:
- ROI at the chosen EV threshold ≥ −0.5% vs current v0 on the same holdout.
- CLV ≥ −0.1% vs current v0.
- ECE point estimate ≤ current ECE (0.0304) + 0.02.
- 7d-block bootstrap CI required alongside i.i.d. per CEng's `block_bootstrap_reporting` condition.
- Report `team_wrcplus_l30_home` and `team_wrcplus_l30_away` coef values alongside all nine existing residuals.

wRC+-specific gate:
- If both `team_wrcplus_l30_home` and `team_wrcplus_l30_away` |coef| < 0.02 after non-NULL data: ingester ships regardless; retrained candidate does NOT promote to `current/`. CSO receives "ingested but not pulling weight" with Stuff+ proxy from Savant `pitch-arsenal-stats` as the documented pivot recommendation.

Park-factor diagnostic:
- Report `park_factor_runs` coef from the candidate's `feature-coefficients.json`. If |value| < 0.005, stop promotion and surface to CEng before any swap of `current/`.

Candidate artifact location:
- Save to `models/moneyline/candidate-wrcplus-revB-2026-05-04/`. Do NOT touch `models/moneyline/current/` until pick-tester PASS is confirmed.

**Revision guidance (on DENIED):** N/A — verdict is APPROVED.

---

## Auto-chain status

Auto mode active. Per CLAUDE.md, scope-gate APPROVED → `pick-implement` auto-fires. No pause-point hits (no lens-holder disagreement, no DENY, no tester loop, no deploy, no paid-spend, no compliance weakening, no production mutation, no user pause request on this revision). Implementer chain runs end-to-end through pick-tester from this APPROVED.
