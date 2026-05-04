# Moneyline v0 — Architecture

**Trained:** 2026-05-04T05:46:30.514951+00:00
**Holdout declaration:** `moneyline-v0-validation-holdout-pre-asb-2024-2026-05-04` (see `models/moneyline/holdout-declaration.json`)

## Choice

Logistic regression. One anchor feature (`market_log_odds_home`) plus 11 standardized
residual features. L2 regularization at C=1.0; intercept fit. The anchor is NOT
standardized — it stays in log-odds space so the coefficient is interpretable
(coefficient near 1 implies the model accepts the market's information; far from 1
implies systematic edge or systematic underweight).

## Source-of-truth invariant

Training source = serving source = CLV-grading source = DK+FD via The Odds API.
Same vendor, same books, same h2h moneyline market, same snapshot pin
(game_time_utc - 60min). No proxy, no kaggle fallback, no Pinnacle archive.

## Why logistic regression

Per CLAUDE.md methodology stance, this is a methodology choice — recorded here,
not in CLAUDE.md. Logistic regression is the simplest model that exposes the
anchor coefficient as a direct, auditable scalar. It's near-natively calibrated
on binary outcomes (isotonic wrap is a one-line fallback if ECE misses target).
LightGBM remains the documented fallback per the rev3 proposal `approach_b_fallback`
if logistic fails the variance-aware ship rule.

## Variance-collapse guard

The model is NOT a passthrough on the market prior. The sum of |residual
coefficients| post-standardization is **0.3400** against a
hard floor of 0.05. Variance-collapse flag:
**False**.

## Calibration

Raw ECE_holdout = **0.0158** against target ≤ 0.04.
Isotonic wrap applied: **False**. Calibrated ECE = **0.0158**.

## Anchor coefficient

Point estimate: **0.9793**
95% CI (Wald): **(0.7543, 1.2044)**

## Log-loss vs market prior

- Holdout log-loss (model raw): **0.6792**
- Market-prior log-loss (anchor-only baseline): **0.6796**
- Delta (positive means model improves over market): **0.0004**

## ROI by EV threshold

See `metrics.json` `ev_threshold_sweep`. Default threshold: +2%.

## Sub-300 variance-aware ship rule

Applies: **False**. Pass: **True**.

## Files

- `model.joblib` — trained logistic regression (sklearn)
- `scaler.joblib` — StandardScaler fit on training residual features
- `calibrator.joblib` — IsotonicRegression (only if isotonic was applied)
- `metrics.json` — full metrics + bootstrap CIs + per-EV-threshold sweep
- `feature-coefficients.json` — coefficients + variance-collapse flag
- `holdout-predictions.parquet` — per-game raw + calibrated predictions
