# Moneyline v0 — Calibration Audit (2026-05-04)

**Verdict: PASS. No isotonic wrap applied.**

## Summary

| Metric | Value | Target | Pass |
|---|---|---|---|
| ECE (raw, holdout, 10 bins) | 0.0304 | <= 0.04 | YES |
| Max calibration deviation (raw) | 0.1873 | n/a (informational) | n/a |
| Isotonic wrap applied | No | — | n/a |
| Holdout n (post-dropna) | 609 | — | — |

Source: `models/moneyline/current/metrics.json` `calibration` block.

## Reliability bins (raw, holdout)

| Bin | Range | n | mean_p | obs_rate | abs(diff) |
|---|---|---|---|---|---|
| 2 | 0.20-0.30 | 9 | 0.274 | 0.222 | 0.052 |
| 3 | 0.30-0.40 | 39 | 0.369 | 0.256 | 0.113 |
| 4 | 0.40-0.50 | 193 | 0.458 | 0.440 | 0.017 |
| 5 | 0.50-0.60 | 257 | 0.547 | 0.521 | 0.026 |
| 6 | 0.60-0.70 | 100 | 0.636 | 0.620 | 0.016 |
| 7 | 0.70-0.80 | 11 | 0.722 | 0.909 | 0.187 |

Bins 0, 1, 8, 9 are empty (no holdout predictions in those probability ranges).

## Why no wrap

ECE_raw = 0.0304 is below the 0.04 target. Per the holdout-declaration's
calibration_isotonic_fallback rule ("If raw sigmoid output misses ECE <= 0.04,
isotonic-wrap"), no wrap is applied.

The max calibration deviation of 0.1873 lives in bin 7 (0.70-0.80) which has
only n=11 samples on the holdout — a thin slice with high observed-rate
variance. The sample-weighted ECE correctly de-weights this bin
(weight = 11/609 = 1.8%) so it does not breach the absolute target.

## Caveat for follow-up

The middle bins (4, 5, 6, accounting for 90% of holdout volume) are well
calibrated (|diff| <= 0.026). The thin tail bins are noisy. Once the post-2024
slate flows and accumulates more observations in the 0.20-0.40 and 0.70-0.80
ranges, the calibration check should be re-run; if those tails worsen with
more data, isotonic-wrap becomes the appropriate response.
