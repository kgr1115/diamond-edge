# Runbook: Cost Spike

**Alert condition:** Any single service monthly spend projects to exceed its budgeted ceiling,
OR total projected monthly spend exceeds $280 (warning) / $300 (critical).
**Severity:** High — a runaway bill terminates the company.
**Owner:** Kyle (this is a business-level alert, not just a technical one)

---

## Budget Envelope (v1, <500 users)

| Service | Budget ceiling | Hard cap | Notes |
|---|---|---|---|
| The Odds API | $79/mo | $100/mo | Hard cap in API account settings |
| Vercel | $20/mo | $50/mo | Pro plan flat fee; overage unlikely |
| Supabase | $50/mo | $75/mo | 2× Pro projects ($25/mo each) |
| Upstash Redis | $20/mo | $20/mo | Budget alert configured in Upstash console |
| Fly.io | $5/mo | $15/mo | Scale-to-zero; overage = someone left machines running |
| Anthropic LLM | $20/mo | $40/mo | Rate-limited; prompt caching reduces cost |
| **Total** | **$194/mo** | **$300/mo** | |

---

## Step 1 — Identify the spiking service

Check each dashboard:

- **Vercel:** [vercel.com/dashboard](https://vercel.com/dashboard) → Usage tab → Function invocations, bandwidth
- **Supabase:** [app.supabase.com](https://app.supabase.com) → Project → Settings → Usage
- **Upstash:** [console.upstash.com](https://console.upstash.com) → Redis → Usage (also sends email alerts at $20)
- **Fly.io:** `fly billing` or [fly.io/dashboard](https://fly.io/dashboard) → Billing
- **Anthropic:** [console.anthropic.com](https://console.anthropic.com) → Usage
- **The Odds API:** Check account dashboard for request count vs quota

---

## Step 2 — Triage by service

### Vercel spike

**Bandwidth spike:**
- Check for a traffic spike (legitimate growth vs. bot/scraper).
- Look at Vercel Analytics for unusual request patterns.
- If scrapers: add rate limiting or `robots.txt` / Cloudflare bot protection.
- If legitimate: this is a good problem. Review if Vercel Pro bandwidth is within new user volume.

**Function invocation spike:**
- Check which functions are being hit: Vercel → Analytics → Functions.
- Most likely causes: cron running too frequently, a route with no cache being hammered.
- Check odds-refresh cron is not firing more than 48×/day.
- Add or repair Redis cache for the affected route.

### Supabase spike

**Database egress spike:**
- Check pg_stat_statements for expensive queries: Supabase → Database → Query Performance.
- A missing index on a high-traffic query can cause massive read amplification.
- Immediate mitigation: add LIMIT clauses or improve indexes.

**Auth spike:**
- Unusual signup volume (bots?). Check `auth.users` creation rate.
- If bot signups: enable Supabase CAPTCHA or restrict sign-up flow.

### Upstash spike

Upstash sends an email alert when spend reaches $20/mo budget. If that fires:

**High command volume:**
```bash
# Check via Upstash REST API
curl https://your-upstash-endpoint.upstash.io/dbsize \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

- Most common cause: a cache helper calling Redis in a loop, or wildcard scan running too frequently.
- Check `outcome-grader` and `pick-pipeline` invalidation code — SCAN-based deletion should be bounded.
- Temporary mitigation: increase TTLs to reduce write frequency.

**Key explosion:**
- Check if cache keys are being generated with unbounded variables (e.g., user IDs accidentally in a shared key).
- Per design, no user-specific data goes in Redis. Audit cache key patterns.

### Fly.io spike

Fly.io should be near-zero cost with scale-to-zero enabled.

**Machines left running:**
```bash
fly machines list -a diamond-edge-worker
# Look for any machine in 'started' state that should be stopped
fly machines stop <machine-id> -a diamond-edge-worker
```

**High memory causing larger instance:**
- If the ML model is OOM-killed, Fly.io may have auto-scaled up.
- Check: `fly logs -a diamond-edge-worker | grep -i "memory\|oom\|killed"`
- Fix: optimize model loading or increase `memory_mb` in fly.toml intentionally.

### Anthropic spike

**Token count spike:**
```
# Check Anthropic usage dashboard for token counts by model
# Haiku 4.5: $0.80/$4.00 per M input/output tokens
# Sonnet 4.6: $3.00/$15.00 per M input/output tokens
```

**Common causes:**
- Pick pipeline is calling the LLM more than once per pick (check for retry logic without backoff).
- System prompt is very large and not cached (prompt caching should reduce input cost by ~90%).
- Elite tier SHAP attributions are running for free users due to a tier gate bug.

**Mitigation:**
- Enable Anthropic prompt caching for system prompts (should already be on — verify).
- Add a circuit breaker: if Anthropic API cost > $1/day, pause LLM rationale generation and serve cached rationales only.
- Verify tier gates in the LLM reasoning code: free users should not receive Sonnet responses.

### The Odds API spike

The Odds API charges per request. Hard cap is $100/mo.

**Check remaining quota:**
```bash
curl "https://api.the-odds-api.com/v4/sports?apiKey=$ODDS_API_KEY" \
  -I | grep -i x-requests-remaining
```

**If quota is nearly exhausted:**
1. Immediately pause the odds-refresh cron (comment it out of vercel.json, deploy).
2. Extend the TTL on cached odds data (bump from 10 min to 30 min in the cache helper).
3. Calculate actual usage vs expected: `48 requests/day × 30 days = 1,440 requests/mo`.
   - If usage is much higher: check for cron double-firing or the cron secret not protecting the route (allowing external calls).

---

## Step 3 — Emergency cost controls

If spend is spiking and you cannot identify the cause immediately:

```bash
# 1. Disable all Vercel Crons immediately (edit vercel.json, clear crons array, deploy)
# 2. This stops: odds-refresh, schedule-sync, pick-pipeline, outcome-grader
# 3. Picks will go stale but the site remains up
# 4. Investigate root cause, fix, re-enable

# Fastest way: update vercel.json to empty crons, commit, push
git add vercel.json
git commit -m "emergency: disable all crons during cost investigation"
git push origin main
```

For Fly.io:
```bash
fly scale count 0 -a diamond-edge-worker  # kill all machines immediately
```

For Upstash: Set spending limit to $0.01/day in the Upstash console to prevent further spend.

---

## Step 4 — Restore service

After identifying and fixing the root cause:

1. Re-enable disabled services one at a time.
2. Monitor spend for 24 hours after re-enabling.
3. Update budget alert thresholds if a new usage pattern was identified.
4. Document the incident and root cause in this runbook.

---

## Upstash $20/mo Budget Alert Setup

This must be configured manually in the Upstash console (cannot be automated via config):

1. Go to [console.upstash.com](https://console.upstash.com)
2. Select the Redis database (prod instance)
3. Navigate to **Settings** → **Budget Alert**
4. Set monthly budget alert to **$20**
5. Enter alert email: kyle.g.rauch@gmail.com
6. Save. Upstash will email when projected spend hits $20.

---

## Monitoring / Alerting Setup (TODO when monitoring is configured)

When Sentry or equivalent is set up, add these custom alerts:
- Vercel: function invocation count >200/min (abnormal traffic)
- Supabase: DB egress >500MB/day
- Anthropic: token spend >$1/day (via Anthropic usage API webhook if available)
- Custom: `/api/admin/health` endpoint that aggregates quota/spend and exposes to a monitoring check

---

**Escalation:** Cost spikes are not a "wait and see" situation. Page Kyle immediately if projected monthly spend > $280.
