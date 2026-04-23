# Retrain Operations Runbook

## What this directory contains

```
worker/models/retrain/
  monthly.py              — monthly retrain pipeline (the main script)
  reports/<timestamp>/
    summary.json          — per-retrain comparison report
  README.md               — this file
```

## What the monthly retrain does

1. Pulls latest data from Supabase: `games`, `odds`, `news_signals`, `pick_outcomes`.
2. Rebuilds training parquet, merging historical backfill (2022-2024 parquet) with any
   accumulated news_signal features.
3. Trains B2 delta models for moneyline, run_line, totals using the same walk-forward
   protocol as `train_b2_delta.py` (2022+H1-2023 train, H2-2023 cal check, 2024 holdout).
4. Evaluates the 2024 holdout PLUS a "last 90 days live picks" window using `pick_outcomes`.
5. Writes new artifacts to `worker/models/<market>/artifacts/v<timestamp>/`.
6. Auto-promotes if: `delta_CLV > +0.1%` AND `log_loss did not regress`.
7. Writes `summary.json` to `worker/models/retrain/reports/<timestamp>/`.

## How to trigger

### Manual (from Fly.io worker shell or local dev)

```bash
# Dry run — trains and evaluates, does NOT promote
python -m worker.models.retrain.monthly --dry-run

# Full run — trains, evaluates, promotes if thresholds met
python -m worker.models.retrain.monthly
```

Required environment variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Automated via Fly.io scheduled machines (recommended)

The task spec recommends Fly.io scheduled machines over Supabase Edge Functions for
the Python retrain job. This avoids a 150s Edge Function timeout and keeps the
compute on the existing worker (no new infra cost).

**Option A: Fly.io scheduled machine (recommended)**

Add a second machine to the Fly.io app that runs on a cron-style schedule:

```bash
# Provision a scheduled machine for the 1st of each month at 03:00 UTC
fly machine run . \
  --app diamond-edge-worker \
  --schedule monthly \
  --env SUPABASE_URL=... \
  --env SUPABASE_SERVICE_ROLE_KEY=... \
  --command "python -m worker.models.retrain.monthly"
```

Fly.io scheduled machines: https://fly.io/docs/machines/run/
This is a Fly.io Machines API feature; no additional cost beyond machine runtime.
Monthly retrain takes ~20-30 min on shared-cpu-1x. At ~$0.02/hr that is < $0.02/run.

**Option B: Supabase pg_cron calling a worker POST endpoint**

Add `POST /retrain` to `worker/app/main.py` that calls `monthly.run_retrain()` as a
background subprocess. Then register in pg_cron:

```sql
SELECT cron.schedule(
  'monthly-retrain',
  '0 3 1 * *',
  $$ SELECT net.http_post(
    url := 'https://<worker-host>/retrain',
    headers := '{"Authorization": "Bearer <WORKER_API_KEY>"}'::jsonb
  ) $$
);
```

Downside: Supabase net.http_post has a 5s response timeout. The worker must return
immediately and run the retrain as a subprocess. Adds complexity.

**Recommendation: Option A (Fly.io scheduled machine).** Simpler, self-contained,
no architectural coupling between Supabase pg_cron and the Python worker.

## Artifact versioning

Each retrain writes artifacts to a versioned subdirectory:

```
worker/models/<market>/artifacts/
  v20260501T030000/
    model_b2.pkl        — LightGBM model artifact (pickle protocol 5)
    metrics.json        — holdout + CLV + ROI metrics for this version
    calibration_<market>.png
  current_version.json  — pointer to the promoted version
```

`current_version.json` schema:
```json
{
  "version": "20260501T030000",
  "promoted_at": "2026-05-01T03:28:00Z",
  "artifact_dir": "worker/models/moneyline/artifacts/v20260501T030000",
  "clv_pct": 0.72,
  "log_loss": 0.6821,
  "best_roi_pct": 3.1
}
```

The worker (`worker/app/main.py`) reads `current_version.json` at startup to load
the correct artifact. To update the production model without a full worker redeploy,
update `current_version.json` and send a SIGHUP or restart the worker process.

## Auto-promote thresholds

| Threshold | Value | Rationale |
|---|---|---|
| Min CLV delta | +0.1% | Conservative — 1/5 of the B2 viability threshold (+0.5%) |
| Max log-loss regression | 0.0 | New model must not degrade calibration |

If NEITHER threshold is met, the prior model stays in production. The retrain report
is still written to `reports/<timestamp>/summary.json` for visibility.

If you want to manually promote a version:

```bash
# Write current_version.json manually
python -c "
import json; from pathlib import Path
pointer = {
  'version': '20260501T030000',
  'promoted_at': '2026-05-01T04:00:00Z',
  'artifact_dir': 'worker/models/moneyline/artifacts/v20260501T030000',
  'clv_pct': None, 'log_loss': None, 'best_roi_pct': None
}
Path('worker/models/moneyline/artifacts/current_version.json').write_text(json.dumps(pointer, indent=2))
"
```

## CLV Tracking

CLV is computed nightly by the Vercel Cron at `/api/cron/clv-compute`:
- Finds graded picks without a `pick_clv` row.
- Fetches closing odds from `market_priors` (most recent snapshot before `games.commence_time`).
- Computes `clv_edge = closing_novig_prob - pick_time_novig_prob`.
- Positive CLV = market moved toward our pick = genuine edge signal.

CLV data accumulates in `pick_clv` and is consumed by the monthly retrain's
"last 90 days live picks" evaluation.

## Wall time budget

Target: under 30 minutes on Fly.io shared-cpu-1x.

B2 training benchmark (from initial training run):
- Moneyline: ~8 min
- Run line: ~6 min (if coverage >= 1000)
- Totals: ~6 min (if coverage >= 1000)
- Data pull + parquet rebuild: ~3 min
- SHAP + calibration plots: ~3 min
- Total: ~26 min

If wall time exceeds 30 min, check:
1. Supabase pull latency (network to Fly.io region).
2. LightGBM `n_estimators` — reduce to 600 if needed.
3. SHAP computation on large holdout sets — already capped at 500 rows.

## Known limitations

- New seasons beyond 2024 require a full feature engineering run (pull_mlb_stats.py +
  feature_engineering.py) before they appear in training data. The monthly retrain
  script logs a warning when new seasons are detected in Supabase but not in the parquet.
- News signal features are zero for the first months until `news_signals` accumulates.
  The model trains with zero news features initially and gains signal over time — this
  is expected behavior, not a bug.
- CLV computation requires `market_novig_prior` in picks (written by B2 pipeline).
  Pre-B2 picks (before market_novig_prior column was added) are silently skipped.
