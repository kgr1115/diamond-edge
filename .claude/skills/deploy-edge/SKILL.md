---
name: deploy-edge
description: Deploy the Supabase Edge Function pick-pipeline. Use after Edge Function code changes. Invoked via /deploy-edge or when Kyle says "deploy the edge function", "push the pipeline".
---

# Deploy Edge Function

Deploys `supabase/functions/pick-pipeline/*` to Supabase.

## Instructions

### Step 1 — Check for unpushed changes

```bash
git status --short supabase/functions/
```

If there are unpushed edits, warn Kyle that deploying from a non-clean tree means the deployed code may differ from what's in git.

### Step 2 — Deploy

Need `SUPABASE_ACCESS_TOKEN` — not the service-role key. Kyle has given tokens in past sessions at `sbp_...` format. Check if one is in `.env` or current session env first; if not, ask Kyle for a fresh one from https://supabase.com/dashboard/account/tokens.

```powershell
$env:SUPABASE_ACCESS_TOKEN = "<the token from Kyle or .env>"
cd C:\Projects\Baseball_Edge
npx -y supabase functions deploy pick-pipeline --project-ref wdxqqoafigbnwfqturmv --no-verify-jwt
```

Expect `Deployed Functions on project wdxqqoafigbnwfqturmv: pick-pipeline`.

### Step 3 — Smoke test

```bash
source /c/Projects/Baseball_Edge/.env
curl -s -X POST "https://wdxqqoafigbnwfqturmv.supabase.co/functions/v1/pick-pipeline" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" -d '{}' \
  -w "\nHTTP:%{http_code}\n"
```

Expect HTTP 200 with a `{picks_written: N}` JSON body.

## Output format

```
Edge Function deploy complete
  Commits deployed: {hash range since last deploy, or note if deploy is from uncommitted working tree}
  Smoke test: HTTP 200, picks_written={N}
```

## Constraints

- If `config.toml` has been touched (experimental.s3_*), the agent in commit earlier in this project removed those — make sure they stay out; Supabase CLI rejects them.
- Remind Kyle to revoke `SUPABASE_ACCESS_TOKEN` when done (short-lived, single use per deploy session is the hygiene pattern)
- If HTTP 500 on smoke test, pull function logs before reporting "failed":
  ```
  npx supabase functions logs pick-pipeline --project-ref wdxqqoafigbnwfqturmv
  ```
