# ML Inference Runtime Decision

**Date:** 2026-04-22
**Author:** mlb-ml-engineer
**Decision status:** COMMITTED — DevOps must provision per this spec

---

## Decision: Fly.io Python Worker

**All ML inference runs on a Fly.io Python worker. Supabase Edge Functions are not used for ML inference.**

This is not a preference — it is a hard technical constraint.

---

## Why Not Supabase Edge Functions

Supabase Edge Functions run on **Deno** (TypeScript/JavaScript runtime). They cannot execute:
- `lightgbm` (C++ extension, Python bindings only)
- `numpy` / `scipy` (C extensions)
- `shap` (Python, requires numpy)
- `scikit-learn` (Python)

There is no JavaScript port of LightGBM suitable for production use. Even if a port existed, SHAP values would require re-implementation. **Edge Functions are ruled out unconditionally.**

The Supabase Edge Function `pick-pipeline` (per the seam diagram in `ml-output-contract.md`) remains responsible for orchestration: fetching games, fetching odds, calling the Fly.io worker, filtering candidates, calling the rationale endpoint, and writing to the database. It does **not** run the model itself.

---

## Fly.io Worker Spec

### Instance Type

| Attribute | Value |
|---|---|
| Machine type | `shared-cpu-1x` |
| RAM | `512 MB` |
| CPU | 1 shared vCPU |
| Region | `iad` (Washington DC — closest to Supabase default US region) |
| Scale-to-zero | **Yes** — machine stops between pick pipeline runs |
| Min machines | 0 (fully scale to zero) |
| Max machines | 1 (no horizontal scaling needed at v1 volumes) |

**Why 512 MB RAM (not 256 MB):**
- LightGBM model artifact: ~5–20 MB per market model
- 3 models loaded simultaneously: ~50 MB
- Bootstrap ensemble (50 models × 3 markets × ~5 MB): ~750 MB uncompressed

**Wait** — 50 bootstrap models × 3 markets × 5 MB = 750 MB. This exceeds 512 MB RAM.

**Revised approach:** Do not load all 50 bootstrap models simultaneously. Instead:
1. At inference time, load the **single best calibrated model** per market (~50 MB total for 3 markets)
2. **Uncertainty estimation** uses a lightweight alternative: LightGBM's built-in `predict_contrib` variance or conformal prediction intervals derived from validation residuals
3. The 50-model bootstrap ensemble is used only during backtest/training, not at inference time

This keeps RAM at <200 MB for model artifacts, comfortable within 512 MB including Python overhead (~150 MB) and numpy/shap (~50 MB).

| Component | RAM estimate |
|---|---|
| Python + runtime | ~150 MB |
| numpy + scipy | ~40 MB |
| lightgbm | ~30 MB |
| shap | ~20 MB |
| 3 model artifacts (calibrated) | ~50 MB |
| Feature vectors + SHAP computation | ~30 MB |
| **Total** | **~320 MB** |

512 MB provides 192 MB headroom. Comfortable.

### Container

```dockerfile
# worker/Dockerfile (skeleton — DevOps finalizes)
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker/ .

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

**Requirements (pinned):**
```
lightgbm==4.3.0
numpy==1.26.4
scikit-learn==1.4.2
shap==0.45.0
fastapi==0.111.0
uvicorn==0.29.0
```

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /predict` | POST | Accepts feature vector → returns `PickCandidate[]` |
| `POST /rationale` | POST | (AI Reasoning) Proxies to Claude API → returns `RationaleOutput` |
| `GET /health` | GET | Liveness check for Fly.io health monitoring |

**Note:** The `/rationale` endpoint is scoped to AI Reasoning agent (TASK-007). The ML engineer only owns `/predict` and `/health`.

### `/predict` API Contract

```
POST /predict
Content-Type: application/json

{
  "game_id": "uuid",
  "markets": ["moneyline", "run_line", "total"],
  "features": {
    "home_sp_era_season": 3.42,
    "home_sp_era_last_30d": 2.87,
    ...all 87 moneyline features...
  }
}
```

Response (array of `PickCandidate` objects — one per market with positive EV):

```json
[
  {
    "game_id": "...",
    "market": "moneyline",
    "pick_side": "home",
    "model_probability": 0.587,
    "implied_probability": 0.524,
    "expected_value": 0.0512,
    "confidence_tier": 3,
    "best_line": {
      "price": -110,
      "sportsbook_key": "draftkings",
      "snapshotted_at": "2026-04-22T12:34:56Z"
    },
    "feature_attributions": [...],
    "features": {...},
    "model_version": "moneyline-v1.0.0",
    "generated_at": "2026-04-22T14:00:01Z"
  }
]
```

---

## Inference Latency Estimate

| Phase | Estimate |
|---|---|
| Cold start (scale from zero, Python startup, model load) | 3–6 seconds |
| Warm start (model already loaded) | <100 ms |
| Feature computation per game (Python, no DB) | ~10 ms |
| LightGBM inference (3 markets) | ~5 ms |
| SHAP computation (top 7 features) | ~30 ms |
| JSON serialization + HTTP overhead | ~5 ms |
| **Total warm per game** | **~50 ms** |
| **Total warm for 15-game slate (all markets)** | **~750 ms** |

**P50 latency (warm):** 50 ms per game, 750 ms for a full slate
**P99 latency (cold start + full slate):** 6 seconds + 750 ms ≈ **7 seconds**

The pick pipeline runs on a schedule (not user-triggered), so cold start latency is acceptable. The Supabase Edge Function `pick-pipeline` calls the Fly.io worker and waits up to 30 seconds — well within the 60s Edge Function timeout.

**Vercel function timeout concern:** The Vercel cron route `/api/cron/pick-pipeline` merely *triggers* the Supabase Edge Function, which in turn calls Fly.io. The Vercel route itself returns immediately (< 1 second). The heavy work happens in the Edge Function (60s timeout) and the Fly.io worker (no timeout — it owns the process). No Vercel timeout is threatened.

---

## Monthly Cost Estimate

### Fly.io Pricing (Machines, pay-as-you-go)

```
shared-cpu-1x, 512 MB RAM:
  CPU:  $0.0000080 / vCPU / second
  RAM:  $0.0000062 / MB / second
  
  Per second cost = (1 × $0.0000080) + (512 × $0.0000062)
                  = $0.0000080 + $0.0031744
                  = $0.0031824 / second
```

### Scenario 1: Steady State — 10 predictions/day

- Pick pipeline runs once per day, processing ~15 games × 3 markets = 45 candidates
- Cold start per run: 5 seconds
- Inference: 45 × 50ms = 2.25 seconds
- Total active seconds per run: ~8 seconds
- Monthly: 30 days × 8 seconds = 240 seconds

```
Monthly cost = 240 × $0.0031824 = $0.76 / month
```

**Steady state: ~$1/month** (including rounding up for overhead)

### Scenario 2: Peak — 100 predictions/day (multiple pipeline runs)

- 4 pipeline runs/day (morning, updated lineups, afternoon, final)
- Each run: ~8 seconds active
- Monthly: 30 × 4 × 8 = 960 seconds

```
Monthly cost = 960 × $0.0031824 = $3.06 / month
```

**Peak: ~$4/month** (including overhead)

### Fly.io Free Allowance

Fly.io includes a free tier:
- 3 shared-cpu-1x VMs with 256 MB RAM — 160 GB outbound data / month

At v1 volumes, the ML worker likely falls within the free allowance entirely. Budget assumes paid to be conservative.

### Total Cost Within Budget

| Component | Monthly Cost |
|---|---|
| Fly.io worker (ML inference) | $1–$4 |
| Fly.io static IP (recommended) | $2/month |
| **Total Fly.io** | **$3–$6/month** |

This leaves $294–$297 of the $300/month budget for Vercel, Supabase, Upstash, The Odds API, and Claude API. **Well within the $300 envelope.**

---

## Secrets / Env Vars to Surface to DevOps (TASK-006)

| Secret | Value | Where Set |
|---|---|---|
| `FLY_APP_NAME` | `diamond-edge-worker` | Fly.io app name; used in deploy scripts |
| `MODEL_ENDPOINT_URL` | `https://diamond-edge-worker.fly.dev` | Set in Supabase Edge Function env + Vercel env |
| `WORKER_API_KEY` | Generated 32-byte random secret | Shared secret for worker authentication (prevent public access) |
| `ANTHROPIC_API_KEY` | From existing secrets | Required by `/rationale` endpoint |

**DevOps action:** Set `WORKER_API_KEY` as a Fly.io secret (`fly secrets set WORKER_API_KEY=...`) and as a Supabase Edge Function secret. The Edge Function must send `Authorization: Bearer {WORKER_API_KEY}` on all requests to the Fly.io worker.

---

## Scale-to-Zero Configuration

The Fly.io Machine must be configured to scale to zero between runs:

```toml
# fly.toml (skeleton)
[http_service]
  internal_port = 8080
  auto_stop_machines = true    # scale to zero when idle
  auto_start_machines = true   # wake on request
  min_machines_running = 0     # fully scale to zero
  [http_service.concurrency]
    type = "requests"
    hard_limit = 10
    soft_limit = 5
```

**Cold start implication:** First request after idle period takes 3–6 seconds. This is acceptable for a scheduled pick pipeline. It is not acceptable for a user-triggered API endpoint — confirm with DevOps that the `/predict` endpoint is never called directly by user-facing API routes.

---

## Monitoring Spec (for DevOps)

| Metric | Alert Threshold | Action |
|---|---|---|
| `/predict` P99 latency | > 15 seconds | Page on-call; check Fly.io machine status |
| `/predict` error rate | > 5% over 5-minute window | Alert; check logs for model loading failures |
| Machine cold starts per day | > 10 | Consider raising `min_machines_running = 1` (adds ~$4/month) |
| RAM usage | > 400 MB | Alert; check for memory leak in SHAP computation |
| Pick pipeline no picks generated | 0 picks 2 days in a row | Alert; model may be failing silently |
