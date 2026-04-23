---
name: backtest
description: Run a Diamond Edge full 2024-holdout backtest on the current model artifacts. Reports honest ROI + CLV per market. Use after model retrains, feature changes, or when Kyle asks "what's the real edge?", "run a backtest", /backtest.
---

# Backtest

Runs the vig-removed backtest simulator against the 2024 holdout on whatever model artifacts are currently pointed to by `worker/models/<market>/artifacts/current_version.json`.

## Instructions

### Step 1 — Verify current version

Read `worker/models/moneyline/artifacts/current_version.json` (and run_line, totals). Report the model version stamps in use.

### Step 2 — Run the backtest

```bash
cd C:\Projects\Baseball_Edge\worker
python -m models.backtest.run_backtest_v3
```

(If `run_backtest_v3` was renamed/replaced, use the latest runner. Check `worker/models/backtest/` for the highest-numbered script.)

### Step 3 — Read the summary

```bash
cat worker/models/backtest/reports/backtest_*_summary.json | python -m json.tool
```

The report includes, per market:
- Pick count at 4%/6%/8% EV thresholds
- Flat-staking ROI at each threshold
- Kelly ROI at each threshold
- Mean CLV
- Calibration metrics (ECE, Brier, log-loss)

### Step 4 — Compare against prior

If `worker/models/retrain/reports/<timestamp>/summary.json` contains a prior-version snapshot, diff the deltas:

- Honest ROI delta per market at the 8% EV threshold
- CLV delta per market
- Log-loss delta (regression is bad)

## Output format

```
Backtest on current artifacts — {timestamp}

Current models:
  Moneyline: v{version}
  Run line:  v{version}
  Totals:    v{version}

Honest ROI (2024 holdout, vig-removed, flat staking):
  Moneyline @ 8% EV: +{x}% ({n} picks)
  Run line  @ 8% EV: +{x}% ({n} picks)
  Totals    @ 8% EV: +{x}% ({n} picks)

Mean CLV (minimum viable bar: +0.5%):
  Moneyline: {x}% {✅/⚠️/❌}
  Run line:  {x}% {✅/⚠️/❌}
  Totals:    {x}% {✅/⚠️/❌}

Calibration (ECE < 0.025 target):
  Moneyline: {ece} {✅/❌}
  Run line:  {ece} {✅/❌}
  Totals:    {ece} {✅/❌}

Verdict: {ALPHA FOUND | NO ALPHA | MIXED — per market}

vs prior artifacts (if available):
  Δ ROI: ...
  Δ CLV: ...
  Δ log-loss: ...
```

## Constraints

- **Honest by default.** If ROI > 20% at 8% EV, flag as likely artifact — real MLB edges are 2–8%.
- Mean CLV near zero = no real alpha regardless of ROI numbers (the "payout asymmetry" pattern).
- If the backtest harness itself errors (data parquet missing, model artifact mismatch), don't shortcut — report the failure and stop.
- Don't auto-promote models — that's the monthly retrain's job with its own auto-promote threshold.
