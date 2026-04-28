---
name: deploy-edge
description: Deploy the Supabase Edge Function pick-pipeline. Use after Edge Function code changes. Invoked via /deploy-edge or when Kyle says "deploy the edge function", "push the pipeline".
---

# Deploy Edge Function

Deploys `supabase/functions/pick-pipeline/*` to Supabase.

## Instructions

### Step 1 — Check for unpushed changes

```bash
git -C C:/AI/Public/diamond-edge status --short supabase/functions/
```

If there are unpushed edits, warn Kyle that deploying from a non-clean tree means the deployed code may differ from what's in git.

### Step 2 — Deploy

Need `SUPABASE_ACCESS_TOKEN` (the `sbp_...` personal access token, NOT the service-role JWT). Lookup order:

1. `apps/web/.env.local`
2. Repo-root `.env.local`
3. Current shell session env
4. If still missing, ask Kyle for a fresh one from https://supabase.com/dashboard/account/tokens.

Per Kyle's standing authorization (2026-04-28), the token persists in `.env.local`. Do NOT prompt to revoke after deploy unless Kyle explicitly asks.

```bash
TOKEN=$(grep -E "^SUPABASE_ACCESS_TOKEN=" /c/AI/Public/diamond-edge/.env.local | head -1 | sed -E 's/^SUPABASE_ACCESS_TOKEN="?([^"]*)"?/\1/')
cd /c/AI/Public/diamond-edge
SUPABASE_ACCESS_TOKEN="$TOKEN" npx -y supabase functions deploy pick-pipeline --project-ref wdxqqoafigbnwfqturmv --no-verify-jwt
```

Expect `Deployed Functions on project wdxqqoafigbnwfqturmv: pick-pipeline`.

### Step 3 — Smoke test

```bash
KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" /c/AI/Public/diamond-edge/.env.local | head -1 | sed -E 's/^SUPABASE_SERVICE_ROLE_KEY="?([^"]*)"?/\1/')
curl -sS --max-time 240 -X POST \
  "https://wdxqqoafigbnwfqturmv.supabase.co/functions/v1/pick-pipeline" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{}' \
  -w "\nHTTP:%{http_code}\n"
```

Expect HTTP 200 with a JSON body shaped like:
```json
{"picks_written": N, "live": L, "shadow": S, "by_date": [...]}
```

The smoke-test invoke can run for 30–90s (multi-day lookahead). Use `--max-time 240`.

## Output format

```
Edge Function deploy complete
  Commits deployed: {hash range since last deploy, or note if deploy is from uncommitted working tree}
  Smoke test: HTTP 200, picks_written={N}, by_date count={M}
```

## Constraints

- If `config.toml` has been touched (experimental.s3_*), keep those out — Supabase CLI rejects them.
- Per Kyle 2026-04-28: `SUPABASE_ACCESS_TOKEN` is persistent in `.env.local`. Don't prompt to revoke.
- If HTTP 500 on smoke test, pull function logs before reporting "failed":
  ```bash
  TOKEN=$(grep -E "^SUPABASE_ACCESS_TOKEN=" /c/AI/Public/diamond-edge/.env.local | head -1 | sed -E 's/^SUPABASE_ACCESS_TOKEN="?([^"]*)"?/\1/')
  SUPABASE_ACCESS_TOKEN="$TOKEN" npx supabase functions logs pick-pipeline --project-ref wdxqqoafigbnwfqturmv
  ```
