# Moneyline v0 — Bundled Report for CEng Sign-Off (rev3)

**Status:** DRAFT — pending data backfill completion + downstream specialist outputs.
**Prepared by:** pick-implementer (orchestrator), 2026-05-03
**Decision target:** CEng v0 promotion verdict (cold-start lane single-use)

This report bundles every item required by the rev3 CEng `bundled_report_complete`
condition. Sections marked TBD are populated by the downstream chain
(mlb-feature-eng -> mlb-model -> mlb-calibrator -> mlb-backtester) once
backfills complete.

---

## 1. Option taken (B vs C) and probe outcome

**Option B — full 2022-09 through 2024 per-game re-pull.**

Probe gating: COO `snap_param_validation` required a 200-credit probe to
validate The Odds API historical endpoint returns snaps near
`game_time_utc - 75min` when requested with that timestamp.

**Probe verdict: PASS.** 14/14 games on 2024-07-23 (representative night-heavy
slate) returned snaps within ±5min of target (well inside ±15min tolerance).
10 distinct returned timestamps across the 14 games confirms per-game routing.
Probe credit burn: 130 (vs 500 hard halt).

Probe artifact: `docs/audits/moneyline-v0-snap-param-probe-2026-05-03.json`

Critical finding from the probe: The Odds API returns HTTP 422
`INVALID_HISTORICAL_TIMESTAMP` for any date param with millisecond precision.
The first probe attempt failed all 14 calls (0 credits burned; 422s) until
this constraint was discovered and `snapshot-param.ts` was patched to strip
`.000` from the ISO output. Documented in code with a regression test.

---

## 2. Script-fix commit

Per COO `script_fix_committed` condition: snapshot-timestamp fix lands as a
SEPARATE commit BEFORE any Odds API credits are spent on the re-pull.

**Commit:** `dbb7789` — `fix(backfill): store actual snapshot timestamp on
historical odds re-pull`

What changed:
- New module `scripts/backfill-historical-odds/snapshot-param.ts` — pure
  function `computeSnapshotParam(gameTimeUtc) -> ISO_string` (T-75min, no ms).
- New `scripts/backfill-historical-odds/run-per-game.ts` — fetches one snap
  per game, persists raw payload to `data/historical-odds-pergame/{year}/
  {game_id}.json`. CLI: `--probe / --window=2024 / --window=full`.
- New `scripts/backfill-db/03b-odds-historical-pergame.mjs` — loader that
  reads per-game payloads, deletes old buggy `odds_api_historical` closing
  rows for the affected game, inserts fresh `odds_api_historical_pergame`
  rows with `snapshotted_at = raw.timestamp` (NOT script wall-clock).
- New `tests/integration/backfill-historical-odds-pergame.spec.ts` —
  9 vitest tests asserting the fix; documents the wall-clock regression.

The follow-up commit `4952012` adds the .000Z stripping fix and probe artifact.

---

## 3. Holdout pre-declaration (before re-pull started)

Per CEng rev3 `holdout_predeclared_before_repull` condition.

**Declaration:** `models/moneyline/holdout-declaration.json`
**Committed at:** `f057e2c` — `feat(moneyline-v0): pre-declare holdout slice`

| Window | Start | End | Notes |
|---|---|---|---|
| Warmup-only | 2022-09-01 | 2023-03-29 | Per CEng rev2 carry-forward; not used for fitting |
| Effective training | 2023-04-01 | 2024-07-15 | Last pre-ASB date inclusive |
| Holdout | 2024-07-19 | 2024-12-31 | Post-ASB regular season + postseason |

Drop predicate (Option A from CEng coverage-gap verdict): both DK + FD missing
at T-60 -> drop, no anchor imputation. Same predicate train/holdout/serve.

Source-of-truth: training source = serving source = CLV-grading source =
DK+FD via The Odds API. Documented in `architecture.md` as a one-liner.

---

## 4. Post-pull coverage actuals (TBD pending backfill completion)

Re-pull receipt path: `docs/audits/moneyline-v0-pergame-repull-receipt-full-{date}.json`

Expected (per probe + spec): coverage at strict `snapshotted_at <= game_time_utc -
60min` should clear ~85-95% of finals (was 37% on the buggy per-batch pull).

| Year | Finals in window | DK pin OK | FD pin OK | Both pin OK |
|---|---|---|---|---|
| 2022 | 482 | TBD | TBD | TBD |
| 2023 | 2430 | TBD | TBD | TBD |
| 2024 (pre-ASB) | ~1500 | TBD | TBD | TBD |
| 2024 (post-ASB) | ~880 | TBD | TBD | TBD |

CEng `coverage_floor_after_repull` gate: ≥ 3,500 graded train rows post-warmup-and-drop.

---

## 5. Look-ahead audit + canary (TBD)

Audit script: `scripts/audit/look-ahead-audit.mjs`
Audit run report: `docs/audits/moneyline-v0-look-ahead-audit-{date}.json` (TBD)

Audit must:
- Use strict `<= as_of` filter, not `<= game_time_utc` (CEng `audit_script_filter_unchanged`).
- Run on `train.parquet` AND `train_canary.parquet`.
- Canary verdict MUST be FAIL (canary set produces non-zero post-pin source rows).
  Audit that catches nothing on the canary set is invalidated per CEng rev1.

---

## 6. Anchor coefficient point estimate + 95% CI (TBD)

Per CEng rev1 condition. Source: `models/moneyline/current/feature-coefficients.json`
field `anchor.coefficient` and `anchor.ci_95_lo` / `anchor.ci_95_hi`.

Expected: anchor coefficient near 1.0 (model accepts market signal). Far from 1.0
without strong residual support is a red flag for variance-collapse.

---

## 7. Sum of |residual coefficients| post-scaling (TBD)

Per CEng rev1 condition. Source: `feature-coefficients.json` field
`sum_abs_residuals_post_scaling`. Hard floor: > 0.05 (variance-collapse guard).

If floor missed, `metrics.json.variance_collapse_flag = true` and CEng
escalation is required.

---

## 8. Picks-per-day distribution at chosen EV threshold (TBD)

Per CEng rev1 condition. Source: `metrics.json.picks_per_day_distribution_at_default_threshold`
(default = +2% EV).

Reports n_days, mean, median, p25/p50/p75, min, max picks per day on the holdout slice.

---

## 9. ECE + max calibration deviation + reliability bins (TBD)

Per CEng rev1 condition. Source: `metrics.json.calibration`.

Target: `ece_calibrated_holdout <= 0.04`. If raw misses target, isotonic-wrap
applied and calibrated ECE reported.

---

## 10. ROI + CLV at +1/+2/+3% EV thresholds (TBD)

Per CEng rev1 condition. Source: `metrics.json.ev_threshold_sweep`.

For v0, CLV is identically 0 by construction (training source = closing source).
CLV-as-a-gate becomes meaningful once the live cron captures closing snaps a
few minutes apart from the model's anchor pin. This is documented in
`architecture.md`.

---

## 11. Log-loss vs market-prior delta (TBD)

Per CEng rev1 condition. Source: `metrics.json.log_loss.delta_vs_market_prior`.

Positive = model improves over the market-only baseline. Negative or near-zero
= the model isn't adding signal beyond the line and risks shipping noise.

---

## 12. Train/serve parity test output

Test file: `tests/integration/feature-parity-moneyline-v0.spec.ts`

**Status: PASS (13/13).** Asserts FIP_CONSTANT, LEAGUE_AVG_FIP, LEAGUE_AVG_BULLPEN_FIP,
LEAGUE_AVG_WRC_PLUS, DAYS_REST_CAP all match between
`scripts/features/build-moneyline-v0.py` and `apps/web/lib/features/moneyline-v0.ts`.
Wind-out scalar verified across 5 edge cases (dome, null wind speed, null wind dir,
unseeded venue, blowing-out, blowing-in, crosswind). Anchor formula
hand-derived against expected values.

Backfill regression test (snapshot-timestamp bug fix): 9/9 PASS. See
`tests/integration/backfill-historical-odds-pergame.spec.ts`.

---

## 13. 1000-iteration bootstrap CIs on ROI, CLV, log-loss-vs-prior, ECE (TBD)

Per CEng rev2 carry-forward. Source: `metrics.json.ev_threshold_sweep.{...}.{roi,clv}_ci_lower/upper`.

Implemented in `scripts/model/train-moneyline-v0.py` `bootstrap_ci()` function
with `seed=20260503` for reproducibility.

---

## 14. Sub-300 sample variance-aware ship rule (TBD)

Per CEng rev2 carry-forward. Source: `metrics.json.sub_300_variance_aware_rule`.

Rule: if `200 <= n_picks < 300` at the chosen EV threshold, lower CI bound on
ROI AND CLV must be ≥ -1%. Otherwise, the standard ship gate applies.

---

## 15. Odds API backfill credit reconciliation

Per COO rev3 conditions `credit_reconciliation_extended` and `hard_halt_at_100k`.

Pre-pull balance (post-probe): ~4,999,830 credits (from probe artifact).
Estimated cost: ~50,000 credits (5,339 games × 10 credits/call, h2h-only).
Hard ceiling: 100,000 credits (will halt and surface to user if approached).

Per-month ledger: emitted in `docs/audits/moneyline-v0-pergame-repull-receipt-full-*.json`
field `monthly_ledger`. (TBD until re-pull completes.)

---

## 16. Canary feature verdict (gate)

The deliberate-leakage canary (`train_canary.parquet`) intentionally weakens
the as_of pin to surface post-game data in the games table. The look-ahead
audit run on the canary set MUST detect this — verdict reported in section 5.

A canary that does NOT trigger detection invalidates the entire audit (per
CEng rev1). Re-run must follow before re-asking for promotion.

---

## Promotion gate summary (TBD)

To be populated when `metrics.json.promotion_gate_summary` is available.

| Gate | Target | Actual | Pass |
|---|---|---|---|
| ROI@+2% EV | ≥ 0% | TBD | TBD |
| ROI CI lower | ≥ -1% (sub-300 only) | TBD | TBD |
| ECE (calibrated) | ≤ 0.04 | TBD | TBD |
| n_picks @ +2% EV | ≥ 200 | TBD | TBD |
| log_loss delta vs market | > 0 | TBD | TBD |
| Variance-collapse flag | false | TBD | TBD |
| Look-ahead audit (train) | 0 violations | TBD | TBD |
| Canary audit (canary) | > 0 violations | TBD | TBD |
| Coverage post-re-pull | ≥ 3,500 train rows | TBD | TBD |
| Train/serve parity | PASS | PASS | YES |
| Snapshot fix regression | PASS | PASS | YES |
| Holdout pre-declared before re-pull | YES | YES | YES |

**CEng decision target (when complete):** approve / approve-with-conditions / reject.

---

## What is dropped vs rev2

Per the rev3 proposal `bundled_report_items_dropped_vs_rev2`:

- **Proxy-residual audit** (global + per-cluster) — no proxy in rev3, sources
  are identical between train and serve.
- **Training-source-vs-serving-source statement** — collapses to one line in
  `architecture.md`.
- **Rationale-eval gate output** — rationale archived for v0 per Kyle's
  2026-04-30 directive.

---

## References

- `docs/proposals/moneyline-v0-2026-04-30-rev3-three-blockers-verdict-ceng.md`
- `docs/proposals/moneyline-v0-2026-04-30-rev3-backfill-option-verdict-coo.md`
- `docs/proposals/moneyline-v0-2026-04-30-rev3-blocker-resolution-verdict-cso.md`
- `docs/proposals/moneyline-v0-2026-04-30-rev3-coverage-gap-verdict-ceng.md`
- `docs/proposals/moneyline-v0-2026-04-30-rev3-verdict-ceng.md`
- `docs/proposals/moneyline-v0-model-2026-04-30-rev3.md` (the proposal itself)
- `docs/audits/moneyline-v0-backfill-results-2026-04-30.json` (the audit that triggered rev3)
- `docs/audits/moneyline-v0-snap-param-probe-2026-05-03.json` (probe PASS)
- `docs/features/moneyline-v0-feature-spec.md`
- `models/moneyline/holdout-declaration.json`
