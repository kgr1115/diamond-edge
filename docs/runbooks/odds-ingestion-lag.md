# Runbook: Odds Ingestion Lag

**Alert condition:** Odds data has not refreshed in more than 1 hour during game hours (8am–11pm ET).
**Severity:** High — stale odds degrade pick quality and user trust.
**Owner:** On-call engineer (notify via alert channel)

---

## What this alert means

The `/api/cron/odds-refresh` Vercel Cron fires every 30 minutes between 8am–11pm ET. If the `odds` table's most recent `snapshotted_at` is more than 60 minutes old during this window, something broke in the pipeline.

---

## Step 1 — Confirm the alert is real

```sql
-- Run in Supabase SQL editor (prod project)
SELECT MAX(snapshotted_at) AS latest_snapshot,
       NOW() - MAX(snapshotted_at) AS lag
FROM odds;
```

If `lag < 60 minutes`, the alert was a false positive or the monitoring check was stale. Stand down.

---

## Step 2 — Check Vercel Cron execution logs

1. Go to [Vercel Dashboard](https://vercel.com) → Diamond Edge project → Logs
2. Filter by Function: `api/cron/odds-refresh`
3. Look for:
   - **No recent invocations** → Cron scheduling issue (Step 3)
   - **Invocations present but erroring** → Route handler failure (Step 4)
   - **Invocations succeeding but DB not updating** → DB write failure (Step 5)

---

## Step 3 — Cron scheduling issue (no recent invocations)

Check the Vercel Cron configuration:

```bash
# Verify vercel.json cron entries are correct
cat vercel.json | grep -A4 "odds-refresh"
```

**Common causes:**
- Vercel deployment rolled back to a version without the cron config
- Vercel Pro subscription lapsed (Hobby tier limits to 2 cron jobs — odds-refresh needs Pro)
- Vercel platform incident: check [vercel.com/status](https://vercel.com/status)

**Fix:** If Vercel platform is healthy, re-deploy main branch:
```bash
git commit --allow-empty -m "chore: force redeploy to restore cron config"
git push origin main
```

---

## Step 4 — Route handler is erroring

Pull the full error from Vercel logs. Common failure modes:

### The Odds API returned an error
- Check [The Odds API status](https://theoddsapi.com)
- Check remaining API quota: `GET https://api.the-odds-api.com/v4/sports?apiKey=$ODDS_API_KEY`
  - Response header `x-requests-remaining` — if 0, quota exhausted
  - **Quota exhausted fix:** Wait for next quota reset (daily), OR reduce polling frequency temporarily
  - If this is a recurring issue: reduce cron to 1x/hour until quota restores, then fix cadence

### ODDS_API_KEY is invalid / missing
```bash
# Check that the secret is set in Vercel (cannot view value, only verify presence)
# Go to Vercel → Project → Settings → Environment Variables
# Confirm ODDS_API_KEY is present for Production environment
```

### Network timeout calling The Odds API
- Usually transient. Wait for the next cron fire (30 min).
- If persistent: check for IP allow-list issues on The Odds API account.

---

## Step 5 — Handler succeeds but DB not updated

The route ran but the Supabase upsert silently failed or wrote zero rows.

```sql
-- Check for recent errors in Supabase logs (Supabase dashboard → Logs → Postgres)
-- Look for upsert errors on the 'odds' table

-- Verify RLS isn't blocking the service role write
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'odds';
-- Service role bypasses RLS, so this should not be an issue.
-- If odds table has no rows at all, something is wrong with the upsert logic.
```

Also check: is `SUPABASE_SERVICE_ROLE_KEY` set correctly in Vercel env vars?
- A key mismatch causes silent 401s on the Supabase client.
- Verify in Vercel → Project → Settings → Environment Variables (confirm key is present and non-empty).

---

## Step 6 — Manual odds refresh (emergency)

If automated refresh is broken and the next scheduled fire is too far away:

```bash
# Trigger the cron route manually (requires CRON_SECRET)
curl -X POST https://your-app.vercel.app/api/cron/odds-refresh \
  -H "Authorization: Bearer $CRON_SECRET"
```

Or trigger via Vercel's cron dashboard: Project → Functions → Trigger manually.

---

## Step 7 — Notify users (if lag > 2 hours)

If odds lag exceeds 2 hours during peak hours, add a banner to the UI:
- In Supabase, upsert a row in the `system_notices` table (if it exists) or toggle a feature flag.
- Message: "Odds data is being refreshed. Displayed lines may be slightly delayed."

---

## Post-incident

After resolving:
1. Confirm `MAX(snapshotted_at)` is within 30 minutes of now.
2. Check Redis cache was invalidated (`de:odds:game:*` keys should be fresh).
3. Document root cause in this runbook if a new failure mode was discovered.
4. If quota exhaustion: file a task to review polling cadence and quota headroom.

---

**Escalation:** If unresolved after 30 minutes, page Kyle (kyle.g.rauch@gmail.com).
