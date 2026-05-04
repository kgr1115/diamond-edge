# Moneyline v0 — Feature Engineering Brief

**Agent:** mlb-feature-eng
**Cycle:** v0 cold-start (`docs/proposals/moneyline-v0-model-2026-04-30-rev3.md`)
**Status:** Drafted 2026-04-30. Fires after `mlb-data-engineer` completes pitcher/batter game-log backfill.
**Predecessor outputs required:** pitcher_game_log + batter_game_log + game_starters (or `games.probable_*_pitcher_id` if architect chose that path) populated for 2022–2024 with ≥98% coverage on the training window.

---

## Objective

Implement the 12-feature snapshot-pinned pipeline specified in `docs/features/moneyline-v0-feature-spec.md`, with two non-negotiable side artifacts: a deliberate look-ahead canary and a train/serve parity fixture. Output is the training feature matrix written to a parquet/CSV file at `data/features/moneyline-v0/` plus a TypeScript serving function the pick cron will call at T-60min.

---

## Inputs

- `docs/features/moneyline-v0-feature-spec.md` — full per-feature spec; **read top-to-bottom before writing code**. Every formula, snapshot pin, leakage check, null-handling rule, invalidation rule is already pinned there. Do not re-derive any of it.
- `docs/proposals/moneyline-v0-model-2026-04-30-rev3.md` — proposal. Lens-holder conditions live in the verdicts.
- `docs/proposals/moneyline-v0-2026-04-30-rev3-coverage-gap-verdict-ceng.md` — **CEng's drop-rule (Option A)**: rows where BOTH DK and FD closes are missing get dropped. Train, holdout, and live-serving use the same predicate. No imputation of the anchor.
- `docs/proposals/moneyline-v0-2026-04-30-rev3-verdict-ceng.md` — bundled-report items including bootstrap CIs, deliberate-leakage canary, parity test.
- `docs/audits/moneyline-v0-backfill-results-2026-04-30.json` — coverage numbers (post data-engineer second pass).
- `docs/schema/moneyline-v0-migrations.md` — schema additions (lineup pinned_at, park_factor_runs, game_wind_features view, odds.closing_snapshot, odds.source).

---

## Deliverables

### 1. Training feature matrix

- File: `data/features/moneyline-v0/train.parquet` (or `.csv` if parquet tooling adds friction; document choice).
- Rows: every game in 2022-09-18 → 2024 with both DK and FD closing-snapshot odds present, AFTER the drop predicate runs. September 2022 rows are tagged `warmup_only = true` and excluded from training but kept for rolling-feature warmup.
- Columns: 15 feature columns in the exact order from the Feature Vector Contract (spec lines 340–358), plus:
  - `game_id` (uuid)
  - `home_win` (int8 outcome label, 1 if home team won, 0 otherwise)
  - `feature_snapshot_ts` (timestamptz, audit-only — must equal `game_time_utc - 60min`)
  - `feature_flags` (int32 bitmask documenting which features were imputed; see spec for bit assignments)
  - `warmup_only` (boolean)
  - `holdout_split` (text: `'train'`, `'holdout'`, `'warmup'`). Holdout = 2024 post-All-Star-break per CSO/CEng condition. Pre-declare the holdout cutoff in writing BEFORE generating any model output — store the cutoff date + UTC declaration timestamp in `models/moneyline/current/holdout_declaration.json`.
- Drop predicate (Option A): write the SQL filter as one named function/view, not inlined in two places. mlb-feature-eng owns this predicate; `mlb-model` and `mlb-backtester` import it.

### 2. Serving feature function

- TypeScript function in `apps/web/lib/features/moneyline-v0.ts` (create the directory).
- Signature: `buildFeatureVector(gameId: string, asOf: Date): Promise<{ vector: number[]; flags: number; snapshotTs: Date }>`.
- Same SQL queries as the training pipeline, parameterized by `as_of`. **Parity is enforced by the parity fixture (deliverable 4) — both code paths must read from the same shared utilities for vig removal (`devig.ts`) and FIP computation. No inline re-implementation.**
- NULL anchor (no DK or FD snapshot at or before T-60) → throw a `MissingAnchorError`. The pick cron catches this and skips the game. Do NOT impute, do NOT use a stale snapshot, do NOT silently fall back.
- Latency budget: ≤200ms warm, ≤2s cold (per COO condition). Hit Supabase via the connection pool, not a fresh client per call.

### 3. Look-ahead canary

- Per spec section "Look-Ahead Canary Design" — implement `first_inning_runs_home` as a 16th feature in a parallel `v0_canary` build path. The canary feature is constructed by reading `games.home_first_inning_runs` (or equivalent — confirm the column exists with `mlb-data-engineer`; if not, use `games.home_score` as a proxy and document).
- Build TWO training matrices: `train.parquet` (15 features, ships) and `train_canary.parquet` (16 features, audit-only, never ships).
- Write the look-ahead audit script at `scripts/audit/look-ahead-audit.mjs`. The audit:
  1. For every feature, asserts the source SQL query has a `<= :as_of` filter on the timestamp column. Hard-coded list of (feature_name, source_table, time_column) — if any feature's query is missing the filter, emit `LEAKY: <feature_name>`.
  2. For every feature, computes mutual information with `home_win` on the training set. Flags any feature with MI > 0.10 (the canary should land here at MI ≈ 0.5+).
- Audit must be runnable as `node scripts/audit/look-ahead-audit.mjs` and exits non-zero on any leak detection.
- The canary MUST fail the audit on `train_canary.parquet`. The audit running clean on `train.parquet` proves nothing unless it also catches the canary. Both runs land in the bundled report.

### 4. Train/serve parity fixture

- Per spec section "Train/Serve Parity Fixture Spec" — fixture file at `tests/fixtures/feature-parity/moneyline-v0-2024-08-15-nyyvsboston.json`.
- Identify the actual NYY-vs-BOS 2024-08-15 game UUID, populate the input record (lines ~432–473 of the spec) with real values from the backfill, compute the expected 15-element vector, and store both in the JSON.
- If 2024-08-15 NYY/BOS doesn't have all 15 features (e.g., starter scratch, missing weather), pick the next earliest 2024 NYY-home game that does and rename the fixture accordingly. Document the substitution.
- Write the parity test at `tests/feature-parity.test.ts` (Vitest). Two paths:
  - Path A: read the row from `train.parquet` keyed on the fixture `game_id`.
  - Path B: call `buildFeatureVector(fixture.game_id, fixture.as_of)`.
  - Assert `path_a[i] == path_b[i]` for all 15 elements within 1e-6 absolute tolerance for floats and exact match for integers.
- After `mlb-model` trains, the fixture's `expected_model_probability` field gets populated by mlb-model and a second test asserts `model.predict_proba([expected_vector])[0][1]` matches.

### 5. Shared utilities

- `apps/web/lib/features/devig.ts` — proportional vig removal (default per spec). Optional Shin implementation as a second exported function. Used by both training (called from a Node.js training-prep script that reads from Supabase) and serving.
- `apps/web/lib/features/fip.ts` — FIP formula with the constant 3.10 hardcoded as `FIP_CONSTANT_2022_2024`. Both starter and bullpen calls import the same constant.
- `apps/web/lib/features/devig.py` — only if any training script lives in Python. If you keep the whole pipeline in TypeScript / Node + SQL, skip the Python utility entirely. The proposal does not require Python at this stage; CSO/CEng/COO have not asked for it.

### 6. Coverage + integrity report

- Append to `docs/audits/moneyline-v0-backfill-results-2026-04-30.json` (or write a sibling `moneyline-v0-feature-eng-results.json`):
  - Total rows in `train.parquet` post-drop, broken out by year + train/holdout/warmup split.
  - Per-feature null-rate and imputed-rate (from `feature_flags` bitmask).
  - Drop count attributable to the Option A predicate (rows dropped because both DK and FD closes were missing) — both as an absolute count and as a percentage of the original season slice.
  - Look-ahead audit results for both `train.parquet` and `train_canary.parquet` (the canary MUST flag leaky).
  - Parity fixture results.
  - Holdout-declaration timestamp + cutoff date.

---

## Constraints

- **Snapshot pin is the contract.** Every feature uses `as_of = game_time_utc - 60min`. Any feature query missing the `<= :as_of` filter on its time column is a leakage bug — the audit catches this.
- **Train source = serve source.** DK+FD via The Odds API for both. Architecture.md gets the one-liner per CSO condition.
- **No imputation of the anchor.** `market_log_odds_home = NULL` → row is dropped (training) or pick is skipped (serving). Never substituted.
- **Bootstrap CIs are mlb-backtester's job, not yours** — but make sure your output preserves enough information (per-row `home_win` + per-row `feature_vector` + train/holdout split) that 1000-iter resampling on the holdout works downstream.
- **Auto-chain on completion.** Hand off to `mlb-model` with: (a) parquet file path, (b) holdout-declaration JSON path, (c) parity fixture path, (d) audit results, (e) coverage report. `mlb-model` reads the feature vector contract from the spec and trains.
- **Do NOT route to `mlb-rationale`.** Rationale is archived for v0 per the 2026-04-30 directive.
- **No commits unless you're done.** A half-built feature pipeline doesn't merge. If you need to pause, write a state file in `docs/features/moneyline-v0-progress.md` describing what's done and what's next, but leave the working tree clean of half-written code.

---

## Open coordination items (resolve directly with the relevant specialist; do not stop and ask Kyle)

- If `pitcher_game_log` schema differs from what the spec assumes (column names, data types), reconcile with `mlb-data-engineer` directly. Update the spec inline with a "Schema reconciliation 2026-04-30" note.
- If you need a new column on `games` (e.g., `home_first_inning_runs` for the canary), route to `mlb-architect` for the migration. Auto-chain says architect produces the migration; data-engineer applies it.
- If `wrc_plus` is sourced as OPS+ proxy per the data-engineer's call, document it in your coverage report and in `models/moneyline/current/architecture.md`. mlb-model needs to know.

---

## Done definition

- `train.parquet` exists, drop-predicate-applied, with 15 + audit columns, ≥3,500 graded training rows post-warmup-exclusion.
- `train_canary.parquet` exists with the 16th feature.
- Look-ahead audit clean on `train.parquet`, FAILING on `train_canary.parquet` (both results recorded).
- Parity fixture exists with real values and the parity test passes.
- Serving function at `apps/web/lib/features/moneyline-v0.ts` exists and is called from a unit test that reproduces the parity fixture vector.
- Coverage + integrity report written.
- Holdout declaration JSON written with UTC timestamp BEFORE any training output is generated.
- Auto-invoke `mlb-model` with the handoff bundle.
