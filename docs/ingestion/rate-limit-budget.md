# Rate-Limit & API Budget Analysis

**Author:** mlb-data-engineer  
**Date:** 2026-04-22  
**Status:** Approved for v1

---

## The Odds API

### Tier and Budget

- **Tier:** Basic (~$79/mo). Hard cap per CLAUDE.md: $100/mo.
- **Monthly request allowance:** ~500 requests/month on the Basic tier (verify exact count at your-account page; this doc uses 500 as a conservative baseline).

### Call Pattern Analysis

One call to `GET /v4/sports/baseball_mlb/odds` with `bookmakers=draftkings,fanduel` and `markets=h2h,spreads,totals` returns **all MLB games** with all three markets for both books in a single HTTP request. No per-game calls needed.

#### Polling cadence (v1 design)

| Scenario | Cadence | Cron expression |
|---|---|---|
| Pre-game window (8am–11pm ET) | Every 30 min | `0,30 12-23 * * *` |
| Late night / overnight games | Every 30 min (midnight–3am ET) | `0,30 0-3 * * *` |
| Off-peak (rest of night) | No polls | (not scheduled) |

#### Call count projections

- Active game hours per day: ~14h (8am–11pm ET) = 28 calls/day  
- Late night window: ~3h = 6 calls/day  
- **Total per day (in-season):** ~34 calls/day  
- **Monthly (peak, 30 days):** 34 × 30 = **1,020 calls/month**

If the Basic tier allows 500 requests, this exceeds the allowance. Mitigation options:

1. **Narrow polling window** — reduce to 8am–10pm ET on weeknights: ~26 calls/day = ~780/month. Still over budget at 500-request tier.
2. **Upgrade to the next tier** (~$199/mo) if the budget allows. This pushes total infra cost toward $300/mo limit — borderline.
3. **Reduce frequency for daytime lulls** — poll every 60 min for games >3h out, every 30 min within 3h. Estimated calls: ~18/day = 540/month. Tight but feasible on Basic if the allowance is 500+.
4. **Verify actual Basic tier limit** — The Odds API pricing page shows request counts at account sign-up. If the limit is 1,000/month (some sources cite this), option 3 is comfortably within budget.

**Recommendation for v1:** Implement option 3 (tiered cadence by game proximity). If the Basic tier limit proves to be 500 and real usage exceeds it, upgrade to the next tier and surface the ~$120/mo delta to the orchestrator.

#### Budget safety rails implemented

- `x-requests-remaining` and `x-requests-used` headers logged after every call.
- Warning threshold: log an error when `requestsRemaining < 50`.
- 429 responses are logged with call-count context and backed off per retry config.

---

## MLB Stats API

- **Cost:** Free, public, no key required.
- **Documented rate limit:** None official. Community convention: stay under 60 req/min.

### Call pattern (v1)

| Job | Calls per run | Runs per day | Daily calls |
|---|---|---|---|
| Schedule sync (today + tomorrow) | 1 (schedule endpoint with hydration) | 2 | 2 |
| Roster sync (all 30 teams) | 30 (one per team) | 1 | 30 |
| Box score sync (up to 15 games) | 1 (schedule with linescore hydration) | 1 | 1 |
| **Total** | | | **~33/day** |

Monthly: 33 × 30 = **~990 calls/month** — well within any reasonable rate limit.

---

## Open-Meteo (Weather)

- **Cost:** Free, no key required.
- **Rate limit:** Not documented. Treat as courtesy API; 1 call per venue per sync run.

### Call pattern

- Called by schedule-sync for games lacking MLB-provided weather (typically next-day games).
- Maximum: 15 games/day × 1 venue call = 15 calls/day = **~450 calls/month**.

---

## Vercel Cron Budget Summary

| Cron job | Schedule | Runs/month | Avg duration |
|---|---|---|---|
| odds-refresh | Every 30 min, ~17h/day | ~1,020 | <3s |
| schedule-sync | 2x/day | 60 | <5s |
| pick-pipeline | 1x/day | 30 | <8s (trigger only; work in Edge Fn) |
| outcome-grader | 1x/day | 30 | <8s (trigger only; work in Edge Fn) |

Vercel Hobby: 2 cron jobs max. Vercel Pro ($20/mo): unlimited cron jobs, 60s max duration.  
**v1 requires Vercel Pro** — 4 cron jobs exceed the Hobby limit. Budget impact: +$20/mo.  
Total projected infra cost (see `docs/infra/cost-projection.md`): within $300/mo at <500 users.

---

## Recommended Vercel Cron Schedules (vercel.json)

```json
{
  "crons": [
    { "path": "/api/cron/odds-refresh",    "schedule": "0,30 12-23 * * *" },
    { "path": "/api/cron/odds-refresh",    "schedule": "0,30 0-3 * * *"   },
    { "path": "/api/cron/schedule-sync",   "schedule": "0 10 * * *"        },
    { "path": "/api/cron/schedule-sync",   "schedule": "0 17 * * *"        },
    { "path": "/api/cron/pick-pipeline",   "schedule": "0 12 * * *"        },
    { "path": "/api/cron/outcome-grader",  "schedule": "0 8 * * *"         }
  ]
}
```

Times are UTC. `0 12 * * *` = 8am ET; `0 17 * * *` = 1pm ET; `0 8 * * *` = 4am ET.
