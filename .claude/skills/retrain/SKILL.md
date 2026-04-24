---
name: retrain
description: "TRAIN new model artifacts on fresh data + evaluate via 2024 holdout + auto-promote if deterministic thresholds pass (CLV delta > +0.1% AND log-loss non-regression). Distinct from /backtest (which only reports metrics on already-trained artifacts). Use after large data backfills, feature changes, or on monthly cadence. Callable on demand; always `--dry-run` first inside pick-implement to avoid accidental promotion."
---

# Retrain

The monthly retrain job is designed to run automatically (1st of month), but it's callable on demand when Kyle wants fresh artifacts now — e.g. after a major data backfill, feature change, or architecture edit.

## Instructions

### Step 1 — Dry run first

Always dry-run before a real retrain. The script at `worker/models/retrain/monthly.py` supports `--dry-run`:

```powershell
cd C:\Projects\Baseball_Edge\worker
python -m models.retrain.monthly --dry-run
```

Expect output with backtest metrics + a promotion decision. Auto-promote threshold is `delta_CLV > +0.1% AND log_loss no regression`.

### Step 2 — Decide

Read `worker/models/retrain/reports/<timestamp>/summary.json`. Compare:
- `new_model.backtest.*` vs `prior_model.backtest.*`

If all markets improve on both log-loss AND CLV, green-light. If any regresses significantly, investigate before promoting.

### Step 3 — Real run

```powershell
cd C:\Projects\Baseball_Edge\worker
python -m models.retrain.monthly
```

This:
1. Pulls fresh data from Supabase
2. Rebuilds parquet
3. Trains + calibrates all 3 markets
4. Runs 2024 holdout backtest
5. Runs "last N days live" evaluation using `pick_outcomes`
6. Writes new artifacts to `worker/models/<market>/artifacts/v<timestamp>/`
7. Auto-promotes if thresholds pass: updates `current_version.json`

### Step 4 — Deploy

If artifacts were promoted, follow up with `/deploy-worker` to push them to Fly.io.

### Step 5 — Verify

After deploy:
- `curl https://diamond-edge-worker.fly.dev/health` — confirm new model loads
- `/run-pipeline` — regenerate picks and verify variance

## Output format

```
Retrain {timestamp} — {wall_time}s

Markets trained: moneyline, run_line, totals

Per-market deltas (new vs current):
  Moneyline: log_loss {Δ}, CLV {Δ%}, ROI {Δ%} — {promoted | blocked | no change}
  Run line:  log_loss {Δ}, CLV {Δ%}, ROI {Δ%} — {promoted | blocked | no change}
  Totals:    log_loss {Δ}, CLV {Δ%}, ROI {Δ%} — {promoted | blocked | no change}

Promotion decision: {N of 3 markets promoted}
Artifacts: worker/models/<market>/artifacts/v{timestamp}/
Next step: {run /deploy-worker | no deploy needed}
```

## Constraints

- If dry-run shows ANY regression in log-loss, require Kyle's explicit go-ahead before running for real
- Respect the auto-promote conservatism — don't override thresholds just because numbers look better on a surface read
- Full retrain takes ~15–30 min; warn Kyle before starting
