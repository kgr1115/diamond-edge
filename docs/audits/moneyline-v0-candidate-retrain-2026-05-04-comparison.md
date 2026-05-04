# moneyline-v0 vs candidate-retrain-2026-05-04 — side-by-side comparison

**Date:** 2026-05-04
**Author:** pick-implementer (orchestrator)
**Purpose:** Test the train-size artefact reading from the
`moneyline-v0-validation-2026-05-04` cycle by retraining v0 against the now-
99.6%-coverage dataset (post October re-pull). Same architecture, same
declaration, same drop predicate. Candidate landed at
`models/moneyline/candidate-retrain-2026-05-04/`. **Production v0 at
`models/moneyline/current/` is unchanged and continues to ship.**

## Inputs

| Item | v0 (production) | candidate v0.1 |
|---|---|---|
| Holdout declaration | `models/moneyline/holdout-declaration.json` (id `moneyline-v0-holdout-2026-05-03`) | same — pinned, not re-declared |
| Architecture | logistic + anchor + 11 standardized residuals + L2 C=1.0 | identical |
| Drop predicate | Option A (no DK and no FD at T-60 → drop) | identical |
| Training window | 2023-04-01 → 2024-07-15 (effective) | identical |
| Holdout window | 2024-07-19 → 2024-12-31 | identical |
| Calibration | raw sigmoid (no isotonic, ECE 0.0304 < 0.04) | raw sigmoid (no isotonic, ECE 0.0252 < 0.04) |
| Feature parquet | `data/features/moneyline-v0/` | `data/features/moneyline-v0-candidate-retrain-2026-05-04/` |

## Headline numbers

| Metric | v0 (current) | v0.1 (candidate) | Delta |
|---|---|---|---|
| Train n | 3,282 | 3,858 | +576 (+17.5%) |
| Holdout n | 609 | 979 | +370 (+60.8%) |
| Train drop count (Option A) | not recomputed; ~579 (from prior n=3,861 - n=3,282) | 3 | -576 (coverage gain) |
| Anchor coefficient (point) | 0.9767 | 1.0240 | +0.0473 |
| Anchor coefficient 95% CI (Wald) | (0.7814, 1.1720) | (0.8426, 1.2053) | tighter, shifted up |
| sum_abs_residuals_post_scaling | 0.2952 | 0.2635 | -0.0317 (-10.7%) |
| Variance-collapse flag | false (floor 0.05) | false (floor 0.05) | both clear |
| ECE (raw, 10-bin) | 0.0304 | 0.0252 | -0.0052 (improved) |
| ECE iid 95% CI | (0.0200, 0.0747) | (0.0134, 0.0589) | tighter, lower |
| Max calibration deviation | 0.1873 | 0.1620 | -0.0253 (improved) |
| Log-loss (model) | 0.6757 | 0.6722 | -0.0035 |
| Log-loss (market prior) | 0.6780 | 0.6727 | -0.0053 |
| Log-loss delta vs market (point) | +0.00225 | +0.00046 | -0.00179 (model still beats market, by less) |
| Log-loss delta 7d-block CI | (-0.00222, +0.00681) | (-0.00199, +0.00305) | tighter, but still spans 0 |
| Train label rate (home win) | 0.520 | 0.525 | +0.005 |
| Holdout label rate (home win) | 0.498 | 0.510 | +0.012 |

## ROI sweep — i.i.d. + 7d-block CIs

| Threshold | v0 n | v0 ROI | v0 iid CI | v0 7d-block CI | candidate n | candidate ROI | candidate iid CI | candidate 7d-block CI |
|---|---|---|---|---|---|---|---|---|
| +1% EV | 505 | +8.31% | (-1.75%, +17.85%) | (-3.49%, +20.69%) | 761 | +9.37% | (+1.40%, +17.33%) | (-1.12%, +19.43%) |
| +2% EV | 416 | +11.33% | (+0.84%, +22.51%) | (-2.42%, +25.20%) | 572 | +10.44% | (+1.02%, +19.36%) | (-0.00%, +21.04%) |
| +3% EV | 339 | +11.39% | (-0.59%, +23.57%) | (-4.94%, +25.56%) | 426 | +7.21% | (-4.10%, +18.45%) | (-3.21%, +17.20%) |

Per-EV-threshold ROI delta (point): +1% **+1.06pp** / +2% **-0.89pp** / +3% **-4.18pp**.

Per-EV-threshold 7d-block CI lower-bound delta: +1% **+2.37pp** (-3.49 → -1.12) / +2% **+2.42pp** (-2.42 → -0.00) / +3% **+1.73pp** (-4.94 → -3.21).

## Per-residual coefficient deltas

| Residual | v0 coef | candidate coef | Delta | Sign flip? |
|---|---|---|---|---|
| starter_fip_home | +0.0133 | +0.0361 | +0.0228 | no (both +) |
| starter_fip_away | -0.0853 | -0.0671 | +0.0182 (weakened toward zero) | no (both -) |
| starter_days_rest_home | -0.0802 | -0.0894 | -0.0092 (strengthened) | no (both -) |
| starter_days_rest_away | -0.0075 | -0.0043 | +0.0032 (near zero, weaker) | no (both -) |
| bullpen_fip_l14_home | +0.0213 | +0.0125 | -0.0088 (weakened) | no (both +) |
| bullpen_fip_l14_away | +0.0445 | +0.0221 | -0.0224 (weakened by half) | no (both +) |
| team_wrcplus_l30_home | 0.0000 | 0.0000 | exact zero in both | n/a |
| team_wrcplus_l30_away | 0.0000 | 0.0000 | exact zero in both | n/a |
| park_factor_runs | +0.0283 | +0.0204 | -0.0079 (weakened) | no (both +) |
| weather_temp_f | -0.0074 | -0.0002 | +0.0072 (collapsed to ~zero) | no (both -, but candidate is essentially nil) |
| weather_wind_out_mph | +0.0073 | +0.0115 | +0.0042 (strengthened slightly) | no (both +) |

Three residuals strengthened (`starter_fip_home`, `starter_days_rest_home`, `weather_wind_out_mph`). Six weakened. Both wRC+ residuals remain exact zero across both fits — same hard-to-fit signal seen in v0. `weather_temp_f` collapses to essentially zero in the candidate. **No sign flips.** The anchor's coefficient strengthening (+0.05) absorbs some of the residual signal — the model is leaning slightly more on the market prior than v0 did.

## Bootstrap inputs / outputs

- v0 bootstrap (per CEng/CSO 2026-05-04 verdict): `docs/audits/moneyline-v0-backtest-bootstrap-2026-05-04.json`
- Candidate bootstrap (this cycle): `docs/audits/moneyline-v0-candidate-retrain-2026-05-04-bootstrap.json`
- Side-by-side ROI block bootstrap (this cycle): `docs/audits/moneyline-v0-candidate-retrain-2026-05-04-roi-block-bootstrap.json`
- Comparison helper script: `scripts/model/_compare_v0_candidate_2026-05-04.py`

`scripts/model/backtest-finalize-moneyline-v0.py` was extended with `--artifact-dir` and `--out-path` flags to support candidate runs without touching the production artifact path. Per-stage commit history captures the diff.

## Verdict

**REJECTED — train-size artefact reading is NOT confirmed; v0 was right to ship as-is.**

The candidate v0.1 — same architecture, same declaration, +17.5% train rows, +60.8% holdout rows — produces ROI@+2% of **+10.44%** versus v0's **+11.33%** (delta -0.89pp, well within the brief's ±1pp REJECTED band). At +3% EV (the live serving threshold per CEng's 2026-05-04 verdict), point ROI degrades by 4pp; the +3% block-CI lower bound improves only modestly (-4.94% → -3.21%). The residual stack did **not** stabilize on the larger train — sum_abs went **down** by 10.7% — and the anchor coefficient absorbed some of that signal (0.9767 → 1.0240). Calibration and log-loss both improved marginally; ECE iid CI tightened from (0.020, 0.075) to (0.013, 0.059).

The most load-bearing finding is in the variance picture, not the point estimate: at +2% EV, the candidate's 7d-block CI lower bound moves from v0's **-2.42%** to **-0.00%** (essentially the zero line). That's the ~57% larger holdout doing exactly what the validation cycle predicted it would do — paying for the re-pull in evidence-quality units, not in additional ROI. The point estimate barely moved because the original v0 wasn't slice-distorted in a way the larger holdout corrects; the model's edge on this slice is what it is.

This validates the validation verdict's *slice variance* reading of the v0-vs-anchor-only pre-ASB-2024 miss. The cross-window diagnostic (v0_current returning +6.81% on pre-ASB-2024) was the real signal, not a training-size deficit. The pre-ASB miss for the walk-forward refit was the smaller training set hurting that fit specifically — not the production v0 being under-fit. With the original v0 already trained on the full window through 2024-07-15, the additional rows added by the October re-pull don't unlock new edge.

## Recommendation for CEng

**Do not promote v0.1.** v0 stays in `models/moneyline/current/`. The candidate at `models/moneyline/candidate-retrain-2026-05-04/` is preserved as evidence the validation verdict's slice-variance reading was correct, not as a promotable artifact. Three follow-ups are worth noting:

1. **The retrain itself is cheap evidence.** Banking it lets future kind:model-change proposals point at "we already tried more data, it tied" instead of re-litigating that hypothesis. Keep the artifact.
2. **+3% EV serving floor (live since 2026-05-04 verdict) survives this evidence intact.** Candidate ROI@+3% is +7.21% (positive) with iid CI lower -4.10% and 7d-block lower -3.21% — both negative on a wider holdout, but the point is positive and the live-cron re-check at 200-400 graded picks remains the binding evidence per the unchanged `live_ece_recheck_at_200_picks` condition. No action.
3. **If CEng wants the candidate as a "data-refresh promotion" anyway** (same predicate, same declaration, same architecture, no methodology change), the pre-declaration's `what_changes_invalidate_this_declaration` clause needs review — a re-train on a refreshed feature build with no architectural change is the boundary case, and the calibration choice (raw sigmoid) was locked in v0's metrics.json. Promoting v0.1 against the same holdout it was just evaluated on is technically a holdout re-use for a selection decision (v0 vs v0.1), even though both hit the same gate. The cleaner path is: keep v0 as `current/`, re-declare a fresh post-2024-12-31 holdout for the next retrain cycle, and let v0.1 sit as banked evidence. If CEng disagrees and waives the fresh declaration, that decision should commit to a verdict doc citing this comparison.

## Audit trail

- This comparison: `docs/audits/moneyline-v0-candidate-retrain-2026-05-04-comparison.md`
- v0 bootstrap (production): `docs/audits/moneyline-v0-backtest-bootstrap-2026-05-04.json`
- Candidate bootstrap: `docs/audits/moneyline-v0-candidate-retrain-2026-05-04-bootstrap.json`
- Candidate ROI block bootstrap: `docs/audits/moneyline-v0-candidate-retrain-2026-05-04-roi-block-bootstrap.json`
- Candidate artifact: `models/moneyline/candidate-retrain-2026-05-04/`
- Pinned holdout declaration: `models/moneyline/holdout-declaration.json`
- Validation cycle that motivated this run: `docs/audits/moneyline-v0-validation-2026-05-04.md`
- Validation verdicts: `docs/proposals/moneyline-v0-validation-2026-05-04-verdict-{ceng,cso}.md`
