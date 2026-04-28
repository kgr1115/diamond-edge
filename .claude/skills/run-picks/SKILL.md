---
name: run-picks
description: Non-destructive trigger of the pick-pipeline Edge Function. Generates today's picks if absent, or regenerates them if the pipeline is rerun. Distinct from /run-pipeline (which DELETES today's picks first as a smoke test). Use when the daily noon-ET cron hasn't fired yet, when the slate is empty and you need picks now for review, or when ingestion data has been corrected and picks need to be re-derived. Direct invoke — bypasses the Vercel /api/cron/pick-pipeline route (which times out at 10s before the Edge Function returns).
---

# /run-picks

Generate today's picks on demand by invoking the Supabase Edge Function `pick-pipeline` directly. Returns `{picks_written, live, shadow}`.

## When to use this skill

- The daily 12:00 PM ET / 16:00 UTC pg_cron / Vercel-cron has not fired yet and Kyle wants to preview today's slate now.
- The slate page renders the empty state ("No qualifying picks today") and `pipeline_ran: false` in the diagnostic.
- An upstream data fix (odds backfill, schedule resync, lineup correction) requires re-deriving picks for a date already populated.
- Visual verification of slate-page layout / UI changes against real data.

## When NOT to use this skill

- For smoke-testing model output → use `/run-pipeline` instead (it deletes first, so you compare against a known-empty starting state and inspect raw values).
- For deploying changes to the Edge Function code → use `/deploy-edge` first, THEN this skill.
- During the daily 12:00 PM ET cron window — let the scheduled run handle it; manual invokes within ±10 min create duplicate-write hazards.

## Why direct invoke (not /api/cron/pick-pipeline)

The Vercel route at `apps/web/app/api/cron/pick-pipeline/route.ts` calls `supabase.functions.invoke('pick-pipeline')`, which AWAITS the Edge Function's HTTP response. The Edge Function typically runs 30–90s. Vercel's `maxDuration = 10` truncates the route long before the invoke returns — Kyle sees `FUNCTION_INVOCATION_TIMEOUT 504` and the Edge Function may or may not actually run. The direct curl invocation here uses Supabase's own 150s timeout and reports the real `picks_written` count.

## Procedure

```bash
# Service-role key from apps/web/.env.local (or repo-root .env.local)
key=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" apps/web/.env.local | head -1 | sed -E 's/^SUPABASE_SERVICE_ROLE_KEY="?([^"]*)"?/\1/')

curl -sS --max-time 180 -w "\nHTTP %{http_code}  time=%{time_total}s\n" \
  -X POST \
  -H "Authorization: Bearer $key" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://wdxqqoafigbnwfqturmv.supabase.co/functions/v1/pick-pipeline
```

Expected response shape on success:

```json
{"picks_written": <int>, "live": <int>, "shadow": <int>}
```

## Verification

After a successful invoke, query Supabase via MCP to confirm:

```sql
SELECT visibility, COUNT(*) AS picks, COUNT(DISTINCT game_id) AS games
FROM picks
WHERE pick_date = (now() AT TIME ZONE 'America/New_York')::date
GROUP BY visibility;
```

Counts should match the JSON response exactly. If `live = 0` and `shadow > 0`, the slate cleared the candidate threshold but no candidate cleared the EV publish gate — that's normal on thin slates and the slate page will only render shadow picks for Pro/Elite viewers.

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| HTTP 401 from invoke | Service-role key wrong / missing | `vercel env pull` from `apps/web/`, retry |
| HTTP 404 | Edge Function not deployed | `/deploy-edge` first |
| `picks_written: 0` | No games on schedule, or all games already started | Check `games` table for today's games + `status` |
| Returns `picks_written` but slate page still empty | Dev server hasn't been restarted since `.env.local` change | restart `npm run dev` |
| Same pick_date, repeated invokes write duplicates | Pipeline isn't idempotent for `live` visibility flips | Use `/run-pipeline` (which deletes first) instead |

## Related

- `/run-pipeline` — destructive smoke-test variant (deletes today's picks first).
- `/deploy-edge` — deploy Edge Function code changes before invoking.
- `/daily-digest` — what to run AFTER picks land to summarize the slate.
