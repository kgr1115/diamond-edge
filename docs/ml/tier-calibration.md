# Confidence Tier Auto-Calibration

**Status:** spec / queued for implementation
**Related:** `worker/app/main.py` → `assign_confidence_tier()`

## Problem

Confidence tiers (1–5) are currently assigned by fixed EV thresholds. Because our model is still maturing and may output suspect EVs (either too-high when miscalibrated or too-low when underconfident), a fixed mapping produces two failure modes:

1. **Label inflation**: every pick shows as "strong" (T5) because the model's EV scale is shifted high
2. **Label compression**: all picks cluster at T3 during periods when the model is conservative

Both mislead the user.

## Goal

Tier boundaries should be **auto-calibrated daily** against observed performance so that:

- **T5 picks win at a materially higher rate than T3 picks**
- **T5 picks are actually rare** (~5–10% of all picks), not the default
- **Fresh tiers reflect the current model's behavior**, not last month's

## Proposed mechanism

### Daily cron job (runs after outcome-grader + CLV compute)

1. Pull picks from the last 30 days with `result IN ('win', 'loss', 'push')`
2. Compute win rate per EV decile per market (moneyline / run_line / total)
3. Fit tier boundaries:
   - **T5**: top 10% of EV bucket by win rate — but require a minimum sample (N ≥ 15)
   - **T4**: next 20%
   - **T3**: next 30%
   - **T2**: next 25%
   - **T1**: bottom 15%
4. Apply a **realism cap** separately:
   - If an EV bucket shows win rate < 50% (implies model was wrong despite positive EV), cap that bucket at T3 regardless of rank
5. Write boundaries to `tier_calibration` table (one row per market, with `updated_at`)
6. Worker reads this table on a 10-minute refresh cycle (cached) and uses the current boundaries in `assign_confidence_tier`

### Schema

```sql
CREATE TABLE tier_calibration (
  market text NOT NULL,          -- 'moneyline' | 'run_line' | 'total'
  version timestamptz NOT NULL DEFAULT now(),
  t1_max_ev real NOT NULL,
  t2_max_ev real NOT NULL,
  t3_max_ev real NOT NULL,
  t4_max_ev real NOT NULL,
  realism_cap_ev real NOT NULL,  -- EV above this gets capped at T3
  sample_size int NOT NULL,      -- number of picks used to fit
  PRIMARY KEY (market, version)
);
```

Worker queries: `SELECT * FROM tier_calibration WHERE market = $1 ORDER BY version DESC LIMIT 1`.

### Fallback

If `sample_size < 30` for a market, the worker falls back to the hardcoded thresholds in `assign_confidence_tier`. We don't fit a calibration on too little data.

## Open questions for Kyle

1. **Uncertainty input** — the current function takes an `uncertainty` parameter that is always 0.0 in production. Should we wire up actual uncertainty (SHAP variance across trees? delta model residual?), or drop the parameter entirely?
2. **Per-market vs global tiers** — should T5 on moneyline mean the same thing as T5 on totals? Probably no (different base rates), but the UI currently shows one tier number. Consider per-market or keep global.
3. **Timing** — run the auto-calibration daily, weekly, or after every N new graded picks?

## Implementation estimate

~4 hours: migration, cron route, worker cache, worker read logic, unit tests, deploy both sides.
