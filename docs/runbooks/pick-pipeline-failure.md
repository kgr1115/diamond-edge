# Runbook: Pick Pipeline Failure

**Alert condition:** No picks exist in the `picks` table with `pick_date = today` by 10am ET (2pm UTC).
**Severity:** Critical — users cannot see picks; core product value is broken.
**Owner:** On-call engineer (immediate response required)

---

## What this alert means

The `/api/cron/pick-pipeline` Vercel Cron fires daily at 8am ET (noon UTC). This triggers the Supabase Edge Function `pick-pipeline`, which orchestrates: ML model inference → rationale generation (LLM) → DB write. If no picks appear by 10am ET, the pipeline failed somewhere.

---

## Step 1 — Confirm picks are actually missing

```sql
-- Run in Supabase SQL editor (prod project)
SELECT COUNT(*) AS pick_count,
       MIN(generated_at) AS first_pick,
       MAX(generated_at) AS last_pick
FROM picks
WHERE pick_date = CURRENT_DATE;
```

- `pick_count = 0` → Pipeline did not write picks. Continue to Step 2.
- `pick_count > 0` → Picks exist. Check if alert is misconfigured or user-facing issue is different.

---

## Step 2 — Check the cron route invocation

1. Vercel Dashboard → Diamond Edge project → Logs
2. Filter by: `api/cron/pick-pipeline`
3. Look for today's 8am ET invocation (noon UTC)

**No invocation found:** Cron scheduling issue.
- Check if today is a no-game day (check MLB schedule) — pipeline should still run but may write 0 picks, which is correct.
- Check Vercel cron health (see odds-ingestion-lag.md Step 3 for cron recovery).

**Invocation found with error:**
```
4xx → CRON_SECRET mismatch or middleware blocking the request
5xx → Unhandled exception in the route handler (check stack trace)
```

---

## Step 3 — Check the Supabase Edge Function logs

The cron route calls the `pick-pipeline` Edge Function. Even if the cron route returned 200, the Edge Function may have failed asynchronously.

1. Supabase Dashboard → Edge Functions → `pick-pipeline` → Logs
2. Filter by today's date and look for errors.

**Common Edge Function failures:**

### ANTHROPIC_API_KEY missing or invalid
```
Error: AuthenticationError from Anthropic API
```
- Verify `ANTHROPIC_API_KEY` is set in Supabase → Settings → Edge Functions → Secrets
- Verify the key is valid at [console.anthropic.com](https://console.anthropic.com)
- Test the key: `curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" ...`

### Fly.io worker timeout (if ML inference is on Fly.io)
```
Error: Request to https://diamond-edge-worker.fly.dev/infer timed out
```
- Check Fly.io: `fly status -a diamond-edge-worker`
- Check if machine scaled to zero and failed to start: `fly logs -a diamond-edge-worker`
- Manual restart: `fly machines start -a diamond-edge-worker`
- Trigger inference directly for today to generate picks (see Step 5)

### ML model returned no predictions
This is a logic issue, not an infra issue. Check if:
- Today's schedule is populated: `SELECT COUNT(*) FROM games WHERE game_date = CURRENT_DATE`
- If games table is empty → schedule-sync hasn't run. Trigger it manually (see Step 4a).

### Supabase DB write failed
```
Error: relation "picks" does not exist
```
- Most likely a migration was not applied to prod.
- Check `supabase/migrations/` for any unapplied files: compare with what's in Supabase → Database → Migrations.
- If missing, apply manually via `workflow_dispatch` in migrations.yml (prod environment).

---

## Step 4a — Manual schedule-sync (if games table is empty)

```bash
curl -X POST https://your-app.vercel.app/api/cron/schedule-sync \
  -H "Authorization: Bearer $CRON_SECRET"
```

Wait 10–15 seconds, then verify:
```sql
SELECT COUNT(*) FROM games WHERE game_date = CURRENT_DATE;
```

---

## Step 4b — Manual pick-pipeline trigger

After resolving the root cause, trigger the pipeline manually:

```bash
# Trigger the cron route directly
curl -X POST https://your-app.vercel.app/api/cron/pick-pipeline \
  -H "Authorization: Bearer $CRON_SECRET"
```

This should fire the Edge Function. Monitor Edge Function logs for completion.
Pipeline typically takes 3–8 minutes end-to-end (ML inference + LLM rationale for 10–15 games).

---

## Step 5 — Emergency: Manual pick data entry

If the pipeline cannot be fixed before noon ET and subscribers are waiting:

1. Determine which games have enough data for manual picks.
2. Insert placeholder picks directly (requires service role):
   ```sql
   -- Emergency placeholder pick (no rationale, visible to free tier only)
   INSERT INTO picks (game_id, market, pick_side, confidence_tier, required_tier, result, generated_at, pick_date)
   VALUES ($game_id, 'moneyline', 'home', 3, 'free', 'pending', NOW(), CURRENT_DATE);
   ```
3. This is a last resort. Notify Kyle before doing this.

---

## Step 6 — Redis cache invalidation

After picks are written, ensure the cache is cleared so users see fresh data:

```bash
# Via Upstash console or REST API
# Pattern: de:picks:today:{today}:*
# Flush all tier variants for today:
curl -X POST https://your-upstash-endpoint.upstash.io/scan \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  # ... (use Upstash REST API pattern deletion)
```

Or simply wait for the 15-minute TTL to expire — users will see picks within 15 minutes.

---

## Post-incident

1. Confirm picks are visible in prod (`/api/picks/today` returns picks).
2. Document root cause and time to resolution.
3. If pipeline consistently fails at 8am due to game data not being ready, consider shifting cron to 9am ET.
4. If Fly.io cold start caused the timeout, evaluate moving ML inference to Supabase Edge Functions.

---

**SLA target:** Picks available by 10am ET on game days.
**Escalation:** If not resolved by 10:30am ET, page Kyle (kyle.g.rauch@gmail.com).
