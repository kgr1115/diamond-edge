---
name: tune-thresholds
description: EV / confidence-tier threshold sensitivity analysis for Diamond Edge's pick pipeline. Shows what happens to pick volume and projected ROI at various cutoffs. Use when Kyle wants to tune the LIVE_EV_MIN/LIVE_TIER_MIN gates, or asks "what if I raised the threshold to 6%?".
---

# Tune Thresholds

Produces a sensitivity table for the pipeline's EV/tier gates without actually changing them. Kyle can eyeball the tradeoff and decide whether to update the constants in `supabase/functions/pick-pipeline/index.ts`.

## Instructions

### Step 1 — Pull historical picks (including shadow)

From the `picks` table, grab all picks from the last 60 days (or since first pick was written if project is young). Include `result` from `pick_outcomes` where available.

```sql
SELECT
  p.id, p.market, p.pick_side, p.confidence_tier,
  p.expected_value, p.best_line_price, p.visibility,
  po.result, po.pnl_units
FROM picks p
LEFT JOIN pick_outcomes po ON po.pick_id = p.id
JOIN games g ON g.id = p.game_id
WHERE g.game_date >= CURRENT_DATE - interval '60 days';
```

### Step 2 — Sweep thresholds

For each combination:
- EV threshold: 2%, 4%, 6%, 8%, 10%, 12%
- Tier threshold: 3, 4, 5

Compute (for picks with graded outcomes):
- N picks passing the threshold
- Hit rate (wins / (wins + losses))
- Mean EV of passing picks
- Total P&L in units (flat stake)
- Mean CLV (requires join to pick_clv)

### Step 3 — Present matrix

A 6×3 matrix per market (moneyline, run_line, total):

```
Market: moneyline
                      Tier 3+   Tier 4+   Tier 5+
EV >= 2%:    N=120    ROI+1.2%  ...       ...
EV >= 4%:    N=85     ROI+2.8%  ...       ...
EV >= 6%:    ...
```

### Step 4 — Recommend

Identify sweet spots:
- Highest ROI combination with N > 50 (sample size matters)
- Combination with best positive CLV (if CLV data is available)
- "Honest" combo — where ROI is 2–8% and sample is decent

Avoid picking tiny-sample combinations that show 80% ROI on 3 picks.

### Step 5 — Report current

Fetch current thresholds from `supabase/functions/pick-pipeline/index.ts`:
- `SHADOW_EV_MIN`, `SHADOW_TIER_MIN`
- `LIVE_EV_MIN`, `LIVE_TIER_MIN`

Show current vs. recommended.

## Output format

```
Threshold sensitivity — {N picks analyzed, {graded} with outcomes}

### Moneyline
[6x3 table as above]

### Run line
[6x3 table]

### Totals
[6x3 table]

Current gates:
  Shadow: EV >= {X}%, Tier >= {Y}
  Live:   EV >= {X}%, Tier >= {Y}

Recommended (based on 60-day backtest):
  Shadow: EV >= {X}%, Tier >= {Y} — {rationale}
  Live:   EV >= {X}%, Tier >= {Y} — {rationale}

To apply: edit `supabase/functions/pick-pipeline/index.ts` constants
          SHADOW_EV_MIN, SHADOW_TIER_MIN, LIVE_EV_MIN, LIVE_TIER_MIN
Then: /deploy-edge
```

## Constraints

- Require at least 30 graded picks total before recommending threshold changes (Kyle's sample is too small otherwise)
- Never recommend EV threshold below 2% (unrealistic) or above 15% (will produce zero picks)
- Flag if CLV data is sparse (< 20 picks with CLV) — statements about edge need that signal
