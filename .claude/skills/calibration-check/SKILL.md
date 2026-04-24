---
name: calibration-check
description: "Post-grader pick-model calibration health check. Computes per-tier reliability (actual vs calibrated win rate), ECE, Brier score, log-loss on last 30–60 days of graded picks and compares to 2024 backtest baseline. Use when picks look miscalibrated, as part of /pick-research or /pick-test, or on a scheduled cadence after the outcome-grader runs. Read-only."
argument-hint: [days — default 30, or "backtest" for backtest-only baseline]
---

Lookback: `$ARGUMENTS` (default: 30 days)

---

## What this skill does

Computes live-calibration health metrics on graded picks and compares them to the current model's backtest baseline. Flags when the model is drifting off-calibration in production.

Read-only on Supabase. Does NOT mutate `pick_outcomes`, `pick_clv`, or the calibration spec. Use `/retrain` to respond to drift, not this skill.

---

## Phase 1 — Pull graded picks

Read-only SQL via `scripts/run-migrations/` pattern (or a similar ad-hoc script):

```sql
SELECT
  p.id, p.market, p.confidence_tier, p.model_probability, p.expected_value,
  p.visibility, p.best_line_price, p.created_at,
  po.result, po.graded_at,
  pc.pick_time_novig_prob, pc.closing_novig_prob, pc.clv_edge
FROM picks p
LEFT JOIN pick_outcomes po ON po.pick_id = p.id
LEFT JOIN pick_clv pc ON pc.pick_id = p.id
WHERE p.created_at >= NOW() - INTERVAL '{lookback_days} days'
  AND po.result IS NOT NULL
ORDER BY p.created_at DESC;
```

Group by `(market, confidence_tier, visibility)`.

---

## Phase 2 — Metrics per slice

For each `(market, confidence_tier)` slice with `N ≥ 10`:

| Metric | Computation |
|---|---|
| **Actual win rate** | `mean(result ∈ {'W'})` excluding pushes |
| **Calibrated midpoint** | from `worker/models/calibration-spec.md` for this tier |
| **Reliability gap** | `actual - calibrated` (target: within ±5 pp) |
| **Brier** | `mean((model_probability - result_bit)²)` |
| **Log-loss** | `-mean(result_bit·log(p) + (1-result_bit)·log(1-p))` |
| **Empirical ROI** | `mean(pnl_units_from_result)` |
| **CLV mean** | `mean(pick_time_novig_prob - closing_novig_prob)` |

Also compute an overall ECE (expected calibration error):

```
ECE = Σ (|actual_i - calibrated_i| · n_i) / N_total
```

---

## Phase 3 — Compare to backtest baseline

Read `worker/models/retrain/reports/<latest>/summary.json` (or `worker/models/backtest/reports/<latest>.json`) for the same metrics measured on 2024 holdout.

| Comparison | Threshold |
|---|---|
| Live Brier vs backtest Brier | Live ≤ backtest × 1.10 (≤10% regression) |
| Live log-loss vs backtest log-loss | Live ≤ backtest × 1.10 |
| Live ECE vs backtest ECE | Live ECE ≤ 0.05 regardless of backtest |
| Per-tier reliability gap | All tiers within ±5 pp of calibrated midpoint |
| Live CLV mean | ≥ -0.1% (not losing against the close) |

---

## Phase 4 — Report

```markdown
## Calibration check — {YYYY-MM-DD}

### Sample
- Lookback: {N} days
- Total graded picks: {M}
- By slice: {table (market, tier, N)}

### Per-tier reliability
| Market | Tier | N | Actual win% | Calibrated | Gap (pp) | Verdict |
| moneyline | 5 | 42 | 0.571 | 0.585 | -1.4 | OK |
| moneyline | 4 | 28 | 0.542 | 0.550 | -0.8 | OK |
| moneyline | 3 | 31 | 0.506 | 0.515 | -0.9 | OK |
| run_line  | 5 | 18 | 0.500 | 0.580 | -8.0 | **DRIFT** |
| ...       |   |    |       |       |      |         |

### Aggregate metrics (live vs backtest)
- ECE live: {X} — backtest: {Y} — target ≤ 0.05 — {PASS|DRIFT}
- Brier live: {X} — backtest: {Y} — threshold ≤ 1.1× — {PASS|DRIFT}
- Log-loss live: {X} — backtest: {Y} — threshold ≤ 1.1× — {PASS|DRIFT}
- CLV mean live: {X}% — threshold ≥ -0.1% — {PASS|WARN|FAIL}

### Interpretation
- {Which slices are healthy, which are drifting}
- {Small-sample disclaimers for slices with N<10 — flagged but not counted against the verdict}

### Recommended action
- Healthy → no action, re-check in M days
- DRIFT flagged → {propose retrain, propose tier remap, propose feature audit}
- FAIL on CLV → P0, trigger `/retrain` and `/check-feature-gap` ASAP
```

Write full output to `worker/models/calibration-checks/{YYYY-MM-DD}.json` (or equivalent) if a prior entry exists for historical tracking.

---

## Non-negotiables

1. **Read-only.** No writes to `picks`, `pick_outcomes`, `pick_clv`, calibration spec.
2. **Respect sample sizes.** Slices with N<10 are flagged "insufficient sample"; don't use them to declare DRIFT.
3. **Never auto-retrigger a retrain.** Recommend only. `/retrain` is separately invoked.
4. **Never deploy.** This skill runs local / staging; not a deploy path.
5. **Never touch compliance surfaces** even if copy-adjacent metrics look odd.

---

## When to call this

- Morning: after outcome-grader + clv-compute crons complete (~04:30 ET).
- As a gate inside `/pick-test` when pick-scope-gate's approval requires calibration verification.
- As a phase inside `/pick-research` to establish baseline before proposing.
- When Kyle asks "are the picks well-calibrated?" / "is the model drifting?"
