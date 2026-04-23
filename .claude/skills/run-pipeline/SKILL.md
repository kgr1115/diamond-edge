---
name: run-pipeline
description: Diamond Edge pipeline test cycle — delete today's picks, trigger the Edge Function pick-pipeline, show raw pick values, flag anomalies. Use after ANY model/pipeline/feature change to verify output. Invoked manually via /run-pipeline or when Kyle says "rerun the pipeline", "regenerate picks", "test the pipeline".
---

# Run Pipeline

Force-rerun of today's pick generation. Standard verification cycle after worker/Edge Function/model updates.

## Instructions

### Step 1 — Clean slate

```bash
node /c/Projects/Baseball_Edge/scripts/run-migrations/del-today.mjs
```

Expect: `deleted: N` for today's existing picks.

### Step 2 — Trigger Edge Function

```bash
source /c/Projects/Baseball_Edge/.env
curl -s -X POST "https://wdxqqoafigbnwfqturmv.supabase.co/functions/v1/pick-pipeline" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' -w "\nHTTP:%{http_code}\n"
```

Expect HTTP 200 + `{picks_written: N, live: M, shadow: K}`.

### Step 3 — Show raw pick values

```bash
node /c/Projects/Baseball_Edge/scripts/run-migrations/pick-raw.mjs
```

### Step 4 — Anomaly detection

Scan the output for:

- **Duplicate (game, market) tuples** — should be zero after dedup fix (commit `ed80889`). If present, the Edge Function dedup broke.
- **Identical model_probability across games** — flags degenerate model (like the 0.6947 issue from earlier today). Acceptable if market priors happen to cluster; suspicious if > 80% of a market's picks share a value.
- **EV > 50%** — unrealistic; flag as suspect (even the best MLB edges are 2–8%).
- **Zero picks** — expected on lighter slates or if 12 PM ET cron already ran the threshold against zero candidates. If games+odds are both populated and picks=0, something's wrong.

## Output format

```
Pipeline rerun on YYYY-MM-DD ET
  Deleted: N existing picks
  Generated: M picks (L live, S shadow)
  Markets: N ML, N RL, N Total
  Anomalies: {none | list them with context}
  Distinct model_probabilities per market: {moneyline: 3, run_line: 7, total: 4}
```

## Constraints

- Do NOT run this in rapid succession; Edge Function cold starts add cost
- If Kyle runs this right after `/deploy-worker` or `/deploy-edge`, skip Step 1 (let accumulation happen)
- If HTTP 500 on the Edge Function, fetch `npx supabase functions logs pick-pipeline --project-ref wdxqqoafigbnwfqturmv` and report the error
