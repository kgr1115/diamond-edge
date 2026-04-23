# Diamond Edge — Infrastructure Cost Projection

**Updated:** 2026-04-22
**Author:** mlb-devops
**Budget envelope:** < $300/mo total at < 500 users

---

## Domain Status

**`diamondedge.ai` — DOMAIN PURCHASE DEFERRED**

Domain is available as of 2026-04-22 but has NOT been purchased.
**Blocker:** USPTO trademark clearance against "Diamond Edge Technology LLC" must complete first.
- Search at: [tmsearch.uspto.gov](https://tmsearch.uspto.gov)
- Estimated clearance timeline: 1–2 weeks manual review

Until clearance is confirmed:
- Vercel project is live on a `*.vercel.app` temporary URL.
- `diamondedge.ai` is NOT in vercel.json — the TODO comment is the placeholder.
- Estimated domain cost: ~$12–15/year (negligible, amortized <$2/mo) — not included in monthly projection until purchased.
- Backup domain `diamondedgepicks.com` should also be registered at the same time.

---

## Per-Service Breakdown

### The Odds API — $79/mo (committed)

- **Plan:** Entry tier (pre-subscribed)
- **Hard cap:** Account-level spending limit set to $100/mo
- **Included quota:** Check Odds API dashboard for exact monthly request count
- **Expected usage:** 48 requests/day (every 30 min, 8am–11pm ET) × 30 days = ~1,440 requests/mo
- **Overage risk:** LOW — usage is far below typical entry tier limits
- **Remaining for all other services:** ~$221/mo

---

### Vercel — $20/mo (Pro required)

- **Plan:** Pro ($20/mo flat fee)
- **Why Pro is required:** Hobby tier limits cron jobs to 2 maximum. Diamond Edge requires 6 cron schedule entries (odds-refresh runs 2x in vercel.json to cover the midnight UTC split), and 4 distinct cron routes. Hobby cannot support this.
- **Pro also unlocks:** 60s function timeouts (vs 10s Hobby). Useful if any cron route nears the 10s limit.
- **Bandwidth included:** 1 TB/mo (vs 100 GB on Hobby) — well above <500 user needs.
- **Cost delta from Hobby:** +$20/mo.
- **Decision:** Pro is budgeted from day 1.
- **Overage risk:** LOW — bandwidth and invocations are unlikely to hit Pro limits at <500 users.

| Hobby vs Pro | Hobby | Pro (budgeted) |
|---|---|---|
| Price | $0 | $20/mo |
| Function timeout | 10s | 60s |
| Cron jobs | 2 max | 40 max |
| Bandwidth | 100 GB | 1 TB |
| Team members | 1 | Unlimited |

---

### Supabase — $50/mo (2 Pro projects)

- **Dev environment:** Local Supabase CLI — $0/mo (free, runs on developer's machine)
- **Staging environment:** Supabase Pro project — $25/mo
- **Production environment:** Supabase Pro project — $25/mo
- **Why Pro for both:** Free tier pauses projects after 1 week of inactivity. Staging must stay alive for CI/CD migration dry-runs. Prod obviously cannot pause.
- **Included per Pro project:** 8 GB database, 100 GB storage, 5 GB egress, unlimited API requests
- **Auth:** Included in Pro (MAU-based, generous limits at <500 users)
- **Overage risk:** LOW at <500 users. DB size is the most likely overage vector — odds snapshots accumulate. Add a data retention cron to prune `odds` table rows older than 7 days once DB approaches 4 GB.

---

### Upstash Redis — $3–5/mo

- **Plan:** Pay-as-you-go (no monthly commitment)
- **Instances:** 
  - Dev/staging: shared instance (acceptable for testing)
  - Prod: dedicated instance
- **Estimated commands:** 15,000–30,000/day at <500 users (see caching-strategy.md)
  - 30,000 commands/day × 30 = 900,000 commands/mo
  - At $0.20 per 100K: 900K ÷ 100K × $0.20 = **$1.80/mo**
- **With overhead and spikes:** Budget $5/mo
- **Hard limit:** $20/mo budget alert configured in Upstash console (see runbooks/cost-spike.md for setup instructions)
- **Overage risk:** LOW. A viral pick could spike reads but not writes. Worst case is $10–15/mo.

---

### Fly.io — $1–3/mo (scale-to-zero)

- **Status:** Config skeleton committed, deployment DEFERRED pending TASK-005 (ML engineer) decision.
- **If TASK-005 confirms Edge Function is sufficient:** Fly.io is not deployed. Cost = $0.
- **If Fly.io is required:** Scale-to-zero means machines shut down when idle.
  - Pick pipeline runs 1×/day, ~3–8 minutes of compute
  - Shared CPU 1x, 256 MB RAM: ~$0.0000049/sec when running
  - 5 min/day × 30 days = 150 min = 9,000 sec × $0.0000049 ≈ **$0.04/mo** (compute only)
  - Memory: 256 MB × ~$0.0000016/sec = negligible
  - Minimum monthly charge (if any machines run at all): ~$1–2/mo due to Fly.io minimums
- **Budgeted at:** $3/mo to be conservative
- **Overage risk:** LOW. Only way to spike is leaving machines running. Scale-to-zero prevents this.

---

### Anthropic Claude — $10–20/mo

- **Models used:** Haiku 4.5 (default, free/pro tier rationale), Sonnet 4.6 (elite tier rationale)
- **Prompt caching:** Enabled on system prompts — reduces input token cost by ~80% on repeated calls
- **Token estimate per pick:** ~500 input + 300 output tokens (with caching: ~100 uncached + 400 cached input)
- **Volume estimate:** 15 games/day × 3 pick types = 45 picks/day with rationale

**Haiku 4.5 cost per pick (rough estimate):**
- Input: 500 tokens × $0.80/M = $0.0004 (mostly cached → $0.00008 effective)
- Output: 300 tokens × $4.00/M = $0.0012
- Per pick: ~$0.0013 after caching
- 45 picks/day × 30 days = 1,350 picks/mo × $0.0013 = **~$1.75/mo** (Haiku, all picks)

**Sonnet 4.6 for elite subscribers (estimate: 20% of picks regenerated with Sonnet):**
- ~270 Sonnet calls/mo
- Input: 500 tokens × $3.00/M = $0.0015 (cached → $0.0003 effective)
- Output: 300 tokens × $15.00/M = $0.0045
- Per pick: ~$0.0048
- 270 × $0.0048 = **~$1.30/mo** (Sonnet premium)

**Total LLM estimate:** ~$3–5/mo at launch. Budget $20/mo to absorb user growth and SHAP attribution calls.

- **Overage risk:** MEDIUM. LLM cost scales with user count if rationale is regenerated per user. Ensure rationale is generated once per pick and cached, NOT per API request.

---

## Total Projection

| Service | <100 users | <500 users | Ceiling |
|---|---|---|---|
| The Odds API | $79 | $79 | $100 |
| Vercel Pro | $20 | $20 | $50 |
| Supabase (2× Pro) | $50 | $50 | $75 |
| Upstash Redis | $3 | $5 | $20 |
| Fly.io | $0–3 | $1–3 | $15 |
| Anthropic Claude | $5 | $15 | $40 |
| **Total** | **$157–160** | **$170–172** | **$300** |

**Budget remaining at <500 users:** $128–130/mo headroom before hitting the $300 ceiling.

---

## Services with Hard Caps or Overage Risk

| Service | Hard cap mechanism | Overage risk | Action if approaching limit |
|---|---|---|---|
| The Odds API | Account spend limit ($100/mo) | LOW | Reduce cron frequency, extend cache TTL |
| Vercel | Soft limits on Pro | LOW | Review function invocations, add caching |
| Supabase | Manual review | LOW | Add data retention job for odds table |
| Upstash | $20/mo budget alert | LOW | Check for cache key explosion or hot path |
| Fly.io | Scale-to-zero | LOW | Check for stuck machines (`fly machines list`) |
| Anthropic | None — requires manual monitoring | MEDIUM | Add daily spend check, circuit breaker |

---

## Cost Review Cadence

- **Weekly:** Check Upstash console for command volume trends.
- **Monthly:** Review all dashboards before the 1st of each month.
- **Growth trigger:** When MAU crosses 250, re-run this projection. LLM and Supabase auth costs are the most user-sensitive.
- **Alert threshold:** If any month projects > $240 total, investigate before the bill closes.
