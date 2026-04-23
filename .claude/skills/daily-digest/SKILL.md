---
name: daily-digest
description: Diamond Edge morning briefing — today's games, odds, picks, news, yesterday's outcomes, CLV trend. Use when Kyle asks "what's today?", "how did yesterday go?", "morning status", or explicitly invokes /daily-digest.
---

# Daily Digest

One-shot morning briefing for Diamond Edge. Pulls everything Kyle needs to check in on the product before the 12 PM ET pipeline fires.

## Instructions

Run this sequence silently, then summarize the results to Kyle in a skimmable table.

### Step 1 — Run diagnostics

```bash
node /c/Projects/Baseball_Edge/scripts/run-migrations/check-pipeline-state.mjs
```

This shows: today's games, odds rows, picks by visibility, news events (last 1h), news signals.

### Step 2 — Yesterday's outcomes

Query Supabase for outcomes graded in the last 24h (the outcome-grader cron fires at 3 AM ET):

```sql
SELECT
  result, COUNT(*)::int AS n,
  ROUND(AVG(pnl_units)::numeric, 3) AS avg_units_pnl,
  ROUND(SUM(pnl_units)::numeric, 2) AS total_units
FROM pick_outcomes
WHERE graded_at >= NOW() - interval '28 hours'
GROUP BY result
ORDER BY result;
```

### Step 3 — CLV trend

```sql
SELECT
  COUNT(*)::int AS sample,
  ROUND(AVG(clv_edge)::numeric * 100, 2) AS mean_clv_pct,
  ROUND(STDDEV(clv_edge)::numeric * 100, 2) AS stddev_clv_pct
FROM pick_clv
WHERE computed_at >= NOW() - interval '7 days'
  AND closing_novig_prob IS NOT NULL;
```

### Step 4 — Worker health

```bash
curl -s https://diamond-edge-worker.fly.dev/health | python -m json.tool
```

### Step 5 — Most recent pipeline run

Check `cron.job_run_details` for pick-pipeline status via `scripts/run-migrations/check-cron-runs.mjs`.

## Output format

Summarize as a 5-section table:

| Section | Fields |
|---|---|
| **Today** | Games, odds rows, picks (live/shadow), news events last 1h |
| **Yesterday (graded)** | W/L/Push/Void counts, total units P&L |
| **CLV (7d)** | Sample size, mean CLV %, stddev |
| **Infra** | Worker health, models loaded, feature count |
| **Most recent cron** | pick-pipeline last run time + success/fail |

End with: "Open slate at https://diamond-edge.co/picks/today".

## Constraints

- Skip running the scripts if Kyle already has a recent digest in this session
- If any query returns zero rows, show "no data yet — {reason}" instead of an empty table
- Total output under 400 words
