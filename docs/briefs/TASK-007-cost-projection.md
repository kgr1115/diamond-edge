# Diamond Edge — AI Rationale Cost Projection

**Author:** mlb-ai-reasoning (TASK-007)
**Date:** 2026-04-22
**Status:** Reference artifact — update when pick volume or pricing changes

---

## Assumptions

| Parameter | Value | Source |
|---|---|---|
| Tier mix | 60% Pro / 40% Elite | Planning assumption |
| Cache hit rate | 70% | Conservative steady-state estimate |
| System prompt tokens | ~600 | Measured from RATIONALE_SYSTEM_PROMPT |
| User prompt tokens (Pro) | ~350 | Estimated from buildUserPrompt() output |
| User prompt tokens (Elite) | ~500 | Estimated (more attributions + context) |
| Output tokens (Pro) | ~200 | 3–5 sentences |
| Output tokens (Elite) | ~450 | Paragraph + 5 bullets |
| Days per month | 30 | Planning constant |

### Pricing (Anthropic, as of 2026-04-22)

| Model | Input | Output | Cache Read | Cache Write |
|---|---|---|---|---|
| claude-haiku-4-5 | $0.80/M | $4.00/M | $0.08/M | $1.00/M |
| claude-sonnet-4-6 | $3.00/M | $15.00/M | $0.30/M | $3.75/M |

---

## Cost per Call (at 70% cache hit rate)

### Pro pick (Haiku 4.5)

```
User prompt:   350 tokens × $0.80/M   = $0.000280
System (hit):  600 × 0.70 × $0.08/M  = $0.0000336
System (miss): 600 × 0.30 × ($0.80 + $1.00)/M = $0.000324
Output:        200 tokens × $4.00/M   = $0.000800
               ─────────────────────────────────
Total/call:    ≈ $0.001438
```

### Elite pick (Sonnet 4.6)

```
User prompt:   500 tokens × $3.00/M   = $0.001500
System (hit):  600 × 0.70 × $0.30/M  = $0.000126
System (miss): 600 × 0.30 × ($3.00 + $3.75)/M = $0.001215
Output:        450 tokens × $15.00/M  = $0.006750
               ─────────────────────────────────
Total/call:    ≈ $0.009591
```

---

## Monthly Cost Projections

### 3 picks/day (conservative — light slate days)

| Component | Value |
|---|---|
| Pro calls/month | 3 × 0.60 × 30 = 54 calls |
| Elite calls/month | 3 × 0.40 × 30 = 36 calls |
| Pro monthly cost | 54 × $0.001438 = **$0.078** |
| Elite monthly cost | 36 × $0.009591 = **$0.345** |
| **Total monthly** | **$0.42** |
| Per-pick average | $0.42 / 90 = $0.005 |
| Budget headroom | $299.58 of $300.00 (99.9% remaining) |

### 5 picks/day (expected — typical slate)

| Component | Value |
|---|---|
| Pro calls/month | 5 × 0.60 × 30 = 90 calls |
| Elite calls/month | 5 × 0.40 × 30 = 60 calls |
| Pro monthly cost | 90 × $0.001438 = **$0.129** |
| Elite monthly cost | 60 × $0.009591 = **$0.575** |
| **Total monthly** | **$0.70** |
| Per-pick average | $0.70 / 150 = $0.005 |
| Budget headroom | $299.30 of $300.00 (99.8% remaining) |

### 6 picks/day (ceiling — heavy slate days)

| Component | Value |
|---|---|
| Pro calls/month | 6 × 0.60 × 30 = 108 calls |
| Elite calls/month | 6 × 0.40 × 30 = 72 calls |
| Pro monthly cost | 108 × $0.001438 = **$0.155** |
| Elite monthly cost | 72 × $0.009591 = **$0.691** |
| **Total monthly** | **$0.85** |
| Per-pick average | $0.85 / 180 = $0.0047 |
| Budget headroom | $299.15 of $300.00 (99.7% remaining) |

---

## Trip-Wire Analysis

**Trip-wire threshold: $50/mo** (10% of $300/mo budget envelope)

At the cost rates above, the LLM rationale layer would reach $50/month at:

```
$50 / $0.009591 per Elite call = 5,213 Elite picks/month
5,213 / 30 days / 0.40 elite fraction = 434 picks/day
```

**At 6 picks/day, the LLM cost is $0.85/month — far below the $50 trip-wire.**

The trip-wire would only trigger if pick volume scaled to ~70× the projected ceiling.
At that scale, the paid subscription revenue would dwarf the LLM cost.

---

## Key Finding

At expected pick volumes (3–6 picks/day), the AI rationale layer costs under $1.00/month.
The budget envelope is not a constraint on this component at all.

The dominant cost drivers for the $300/mo budget are:
1. The Odds API subscription (~$79/mo)
2. Supabase + Vercel hosting
3. Upstash Redis

LLM inference cost is negligible at v1 scale.

---

## Sensitivity: Worst-Case at 100% Cache Miss Rate

If prompt caching fails entirely (0% cache hit rate):

| Scenario | Monthly Cost |
|---|---|
| 3 picks/day | $0.63 |
| 5 picks/day | $1.05 |
| 6 picks/day | $1.26 |

Still negligible. Prompt caching is a latency and cost optimization but not
a budget-critical dependency at these volumes.

---

## Sensitivity: All Elite Picks (100% Elite Tier)

Worst-case tier scenario: all picks routed through Sonnet 4.6:

| Scenario | Monthly Cost |
|---|---|
| 3 picks/day | $0.86 |
| 5 picks/day | $1.44 |
| 6 picks/day | $1.73 |

Still within budget. No risk.
