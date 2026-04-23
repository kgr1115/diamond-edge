---
name: deploy-worker
description: Deploy the Diamond Edge Fly.io Python ML worker + verify /health. Use after ML feature changes, model retraining, or Python code edits. Invoked via /deploy-worker or when Kyle says "redeploy the worker", "push the worker", "deploy ML changes".
---

# Deploy Worker

Build + deploy the Fly.io ML worker image from the `worker/` directory.

## Instructions

### Step 1 — Deploy

```powershell
$env:Path = "C:\Users\kgrau\.fly\bin;" + $env:Path
$env:FLY_API_TOKEN = (Get-Content "C:\Projects\Baseball_Edge\.env" | Where-Object {$_ -like "FLY_API_TOKEN=*"}).Substring(14)
cd C:\Projects\Baseball_Edge\worker
flyctl deploy --remote-only
```

Watch for: `Deployed Functions` success line, or build/machine health-check failures.

### Step 2 — Verify health

```bash
curl -s https://diamond-edge-worker.fly.dev/health | python -m json.tool
```

Expected fields:
- `status: "ok"`
- `models_loaded: [moneyline, run_line, totals]` (or subset if some intentionally disabled)
- `models_failed: {}` (empty object)
- `live_feature_count: 90` (target — less means feature fallbacks active)
- `uptime_seconds` > 0

### Step 3 — Smoke test `/predict`

Pick an arbitrary recent game_id from `games` table and run:

```bash
source /c/Projects/Baseball_Edge/.env
GAME_ID=$(node -e "...quick query for today's first game id...")
curl -s -X POST https://diamond-edge-worker.fly.dev/predict \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"game_id\": \"$GAME_ID\", \"markets\": [\"moneyline\", \"run_line\", \"total\"]}"
```

Expect `{candidates: [...]}` with at least one candidate per market that has odds data.

## Output format

```
Worker deploy complete — {build_time}s
  /health: ok, {live_feature_count}/90 features live
  Models: {list loaded}
  Failures: {any errors}
  Smoke test: {N candidates returned from sample game}
```

## Constraints

- Do NOT deploy if `worker/requirements.txt` has uncommitted changes (pip will install from repo copy, which won't match the deployed machine)
- If `/health` returns 503 after deploy, check Fly.io logs: `flyctl logs -a diamond-edge-worker`
- If deploy fails with "Docker not running", use `--remote-only` (already in command above — Fly builds on their infra)
