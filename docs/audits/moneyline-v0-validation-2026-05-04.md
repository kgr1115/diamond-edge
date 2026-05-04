# Moneyline v0 — validation report (walk-forward + named baselines + block bootstrap)

**Date:** 2026-05-04
**Author:** pick-implementer
**Verdict:** **MIXED — escalate to CEng + CSO**
**Pre-declaration:** `models/moneyline/validation-holdout-declaration-pre-asb-2024.json`
**Backing data:** `docs/audits/moneyline-v0-validation-2026-05-04.json`
**Cell-table source:** `models/moneyline/validation-pre-asb-2024/validation-cell-table.json`

## TL;DR

The v0 walk-forward refit on a held-out pre-ASB-2024 slice returns **positive
point ROI** (+4.82% at +2% EV, n=569) but the bootstrap CI lower bound is
**-3.98%** (i.i.d.) / **-3.47%** (7-day-block) — both breach the declaration's
"lower CI bound >= -1%" floor. The walk-forward refit ALSO loses to a 1-feature
anchor-only logistic on the pre-ASB slice by ~2pp. The residual stack still
pulls weight on the post-ASB slice (v0 beats anchor-only by +5.31pp there), so
the model isn't broken — but the size of the effect on a single slice (post-ASB)
matters less now that we have a second slice that doesn't replicate it.

A separate finding from the same validation: the existing post-ASB i.i.d.
bootstrap CI was **over-confident**. The 5-day and 7-day block-bootstrap CIs
flip the sign of the lower bound (i.i.d. +0.0084 → 5d-block -0.0235 → 7d-block
-0.0242 → 10d-block back to +0.0088). CEng's existing v0 sign-off cited the
i.i.d. lower bound > 0; that bound does not survive a more honest variance
accounting on slate-correlated outcomes.

## Headline 4×2 cell table at +2% EV

| model                                  | post-ASB-2024 (n=609 holdout) | pre-ASB-2024 (n=842 holdout) |
|----------------------------------------|-------------------------------|------------------------------|
| **v0** (own-window)                    | ROI=**+11.33%** n=416 iid=(+0.84%, +22.51%) 7d=(-2.42%, +25.20%) | ROI=**+4.82%** n=569 iid=(-3.98%, +14.74%) 7d=(-3.47%, +13.91%) |
| baseline_market_prior_only             | n=0 (no edge by construction) | n=0 (no edge by construction) |
| baseline_anchor_only_logistic          | ROI=+6.02% n=342 iid=(-6.96%, +19.69%)  | ROI=+6.79% n=395 iid=(-5.92%, +19.79%) |
| baseline_anchor_plus_favorite_winpct   | ROI=+5.65% n=364              | ROI=+5.80% n=419              |

**v0 vs anchor-only:**
- post-ASB-2024: v0 +11.33% vs anchor-only +6.02% → **+5.31pp** (PASS, residuals carry weight)
- pre-ASB-2024: v0 +4.82% vs anchor-only +6.79% → **-1.97pp** (anchor-only wins)

**v0 vs anchor+favwinpct:** the 2-feature baseline is essentially identical to
anchor-only (favwinpct coefficient is +0.017 post-scaling on post-ASB, +0.005 on
pre-ASB — favorite season-to-date win pct adds nothing on top of the anchor).
Confirms the simpler 1-feature anchor-only baseline is the right rival.

## Success-criteria check

Per the validation declaration's `success_criteria.primary`:

| # | Criterion | Result | Pass? |
|---|---|---|---|
| 1 | v0_walkforward ROI on its holdout: positive point AND lower CI bound >= -1% | Point +4.82%; i.i.d. lower -3.98%; 7d-block lower -3.47% | **FAIL** (point passes, CI lower fails) |
| 2 | v0 (post-ASB) beats market-prior by >= 2pp | market-prior n=0 picks; trivially passes | PASS (trivial) |
| 3 | v0_walkforward (pre-ASB) beats market-prior by >= 2pp | market-prior n=0 picks; trivially passes | PASS (trivial) |
| 4 | v0 beats anchor-only by >= 1pp on AT LEAST ONE slice | post-ASB +5.31pp; pre-ASB -1.97pp | PASS (post-ASB carries it) |

Per `success_criteria.secondary`:

| Criterion | Result | Pass? |
|---|---|---|
| Block-bootstrap CI lower bound on post-ASB-2024 ROI does not flip sign vs i.i.d. CI | i.i.d. lower +0.84%; 5d-block -2.35%; 7d-block -2.42%; 10d-block +0.88% | **FAIL — flag for CEng** |
| ECE on pre-ASB-2024: report point + bootstrap CI; isotonic NOT applied | Raw ECE 0.0158 (well under 0.04 target) | PASS |
| Coefficient comparison v0 (current) vs v0_walkforward | Anchor coef 0.9767 → 0.9793; residual loadings same shape, no sign flips on the active 9 residuals (the 2 wRC+ residuals stay 0 in both) | PASS |

## Block-bootstrap detail (post-ASB-2024 v0 ROI @ +2% EV)

| Method | CI lower | CI upper |
|---|---|---|
| i.i.d. (current reporting) | **+0.0084** | +0.2251 |
| 5-day-block | -0.0235 | +0.2475 |
| 7-day-block | -0.0242 | +0.2520 |
| 10-day-block | +0.0088 | +0.2166 |

Sign flip at 5d and 7d. The 10d block returns weakly positive — mechanically,
larger blocks have fewer effective resamples (n_blocks ≈ 73/10 = 7) and the CI
re-collapses toward the point estimate. The honest middle reading is
**i.i.d. and 10d disagree about the same data; the bootstrap method matters as
much as the data here**. The point estimate +11.33% is unchanged; what changes
is how confident we should be that the lower bound is above zero.

CEng's existing v0 sign-off cited "i.i.d. CI lower bound +0.67% (positive)" as
satisfying the cold-start "ROI ≥ 0" floor. The sign-flip evidence does not
retroactively un-sign-off v0 (the cold-start lane was correct in concept), but
it does mean **the live-slate ECE re-check at 200-400 picks** that CEng made a
condition is more important than originally framed — the in-sample CI is less
of a guarantee than the i.i.d. number suggested.

## Coefficient comparison (v0_current vs v0_walkforward)

| Feature | v0_current (full window) | v0_walkforward (prefix-only) |
|---|---|---|
| anchor (`market_log_odds_home`) | 0.9767 (CI 0.78, 1.17) | 0.9793 (CI 0.75, 1.20) |
| sum_abs_residuals_post_scaling | 0.2952 | 0.3400 |
| variance_collapse_flag | False | False |
| starter_fip_home | (small +) | +0.026 |
| starter_fip_away | (small -) | -0.078 |
| starter_days_rest_home | (small) | -0.096 |
| starter_days_rest_away | (small) | +0.050 |
| bullpen_fip_l14_home | (small +) | +0.024 |
| bullpen_fip_l14_away | (small +) | +0.030 |
| team_wrcplus_l30_home | 0 (wRC+ unfilled) | 0 (wRC+ unfilled) |
| team_wrcplus_l30_away | 0 (wRC+ unfilled) | 0 (wRC+ unfilled) |
| park_factor_runs | (small +) | +0.029 |
| weather_temp_f | (small) | -0.000 |
| weather_wind_out_mph | (small -) | -0.006 |

Anchor coefficient is **materially identical** (0.977 → 0.979, both CIs
contain 1.0). Residual shape is consistent (no sign flips on the 9 active
residuals). The walk-forward refit is a fair representation of the same
model; the worse pre-ASB result is therefore a slice property, not a
training-window-size artefact.

## Cross-window diagnostics (informational, not part of success criteria)

| Diagnostic | ROI@+2% | n_picks | log-loss delta vs market | ECE |
|---|---|---|---|---|
| v0_current applied to pre-ASB-2024 features | **+6.81%** | 569 | +0.0031 | 0.0155 |
| v0_walkforward applied to post-ASB-2024 features | +10.13% | 410 | +0.0016 | 0.0320 |

Notable: **v0_current generalizes to pre-ASB-2024 better than v0_walkforward
does** (+6.81% vs +4.82% at the same n=569). Likely cause: the larger training
set (3,282 vs 2,416 rows) lets the residual stack learn slightly more stable
loadings; the walk-forward refit doesn't see the 2024 pre-ASB slice in training,
so its residual loadings drift very slightly. This is interesting because it
flips the conventional walk-forward intuition — here the larger training window
helps rather than overfitting. Worth a CEng note but not a structural finding.

## Open items / recommended next moves

1. **Block-bootstrap on the existing v0 holdout flips sign at 5d and 7d
   blocks.** The existing CEng v0 sign-off cited "i.i.d. CI lower > 0" as
   satisfying the cold-start positive bar. The block-bootstrap evidence does
   not invalidate the sign-off (cold-start was correctly framed) but does
   strengthen the case for treating CEng's live-slate ECE re-check
   (`live_ece_recheck_at_200_picks`) as the binding evidence rather than the
   in-sample CI.

2. **v0 loses to a 1-feature anchor-only logistic on the pre-ASB-2024 slice
   by ~2pp.** v0 still wins on post-ASB by +5.31pp, so the residual stack
   isn't dead — but the win is a slice-specific result. Two possibilities:
   - **Slice variance.** With n=395 vs n=569 and a CI half-width of ~12pp on
     each side, a 2pp gap is well within noise. The two slices are giving
     near-equivalent point estimates with wide CIs.
   - **Real residual-stack signal that's smaller than the post-ASB result
     suggested.** The walk-forward refit is the more honest of the two
     measurements (because the pre-ASB slice was strictly held out).

   Recommended: re-run the comparison after live picks accumulate (CEng's
   200-pick gate), at which point the in-sample debate becomes moot.

3. **Anchor + favorite-winpct logistic adds nothing.** The favorite-winpct
   coefficient is +0.017 on post-ASB and +0.005 on pre-ASB (post-scaling) —
   structurally indistinguishable from the anchor-only baseline. This rules
   out the simplest residual rival but does NOT validate the v0 residual
   stack; it just means the head-to-head test you'd want is "v0 vs a richer
   2-3 feature baseline" (e.g., anchor + starter-FIP-diff + team-wRC+-diff
   if/when wRC+ ingestion lands).

4. **Approach C (LightGBM fallback per rev3 `approach_b_fallback`) is on
   the table per the validation declaration's escalation clause.** This
   report does NOT recommend triggering it yet — the data does not show a
   clear methodology failure (point ROI is positive on both slices), only a
   wider variance picture than i.i.d. suggested. Recommend collecting the
   200-pick live evidence first.

5. **wRC+ ingestion remains the highest-information feature gap.** Two of
   11 residuals are zeroed because the source column is empty. CEng's prior
   follow-up on this stands; nothing in this validation changes that.

## What the validation does NOT change

- The existing v0 artifact at `models/moneyline/current/` is unchanged. The
  validation training run wrote to `models/moneyline/validation-pre-asb-2024/`
  per the declaration's `no_promotion_clause`.
- The existing pre-declared post-ASB-2024 holdout is unchanged.
- The +2% EV threshold, the no-isotonic-on-validation rule, and the Option
  A drop predicate are all untouched per the declaration.
- `models/moneyline/holdout-declaration.json` is byte-identical to before.

## Files touched

- `models/moneyline/validation-pre-asb-2024/{model.joblib, scaler.joblib,
  metrics.json, architecture.md, feature-coefficients.json,
  holdout-predictions.parquet, validation-cell-table.json}` (created)
- `data/features/moneyline-v0-validation-pre-asb-2024/{train.parquet,
  holdout.parquet, ...}` (created, gitignored)
- `scripts/features/build-moneyline-v0.py` (added `--declaration` flag)
- `scripts/model/train-moneyline-v0.py` (added `--features-dir`,
  `--artifact-dir`, `--declaration`, `--no-isotonic` flags)
- `scripts/model/validate-moneyline-v0.py` (new — 4×2 cell driver +
  block bootstrap)
- `scripts/model/backtest-finalize-moneyline-v0.py` (added `--block-size`
  flag for log-loss-delta block bootstrap)
- `docs/audits/moneyline-v0-validation-2026-05-04.{md,json}` (this report)
