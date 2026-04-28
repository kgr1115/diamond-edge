# Confidence Tier Auto-Calibration

**Status:** v1 shipping 2026-04-28 (per `docs/improvement-pipeline/pick-scope-gate-2026-04-28.md`)
**Related:** `worker/app/main.py` → `assign_confidence_tier()`, `worker/app/calibration_fit.py`, `worker/models/calibration-spec.md`

## Problem

Confidence tiers (1–5) are derived from a model-output → tier function. Two failure modes have been observed:

1. **Label inflation**: every pick shows as Strong (T5) because the model's EV scale is shifted high.
2. **Label compression**: all picks cluster at T3 during periods when the model is conservative — including a specific bug surfaced 2026-04-28 where the global "realism cap" at EV > 20% routed all RL high-EV picks into T3, polluting the cohort.

Both mislead the user.

## Goal

Tier boundaries reflect:

- **T5 picks win at a materially higher rate than T3 picks** (currently inverted on RL: T3 wins 54.9% on N=51, T5 wins 50% on N=2).
- **T5 picks are actually rare** (~5–10% of all picks), not the default.
- **Tiers reflect the current model's behavior**, not last month's.

---

## v1 — what shipped 2026-04-28

This cycle implements two of the three layers described below: per-market EV ceilings (immediate fix) and the isotonic recalibration pipeline (gated promotion). The auto-calibrated tier-boundary fit (the original v0 spec below) is **deferred** until per-(market × tier) sample sizes hit N≥30.

### Layer 1 — Per-market rejection ceiling (Proposal 1, P0)

The model occasionally emits absurdly high EVs (run-line picks scoring >50% EV at a 29% win rate — N=17). These are model artifacts, not signal. The fix:

```python
# worker/app/main.py
EV_REJECT_CEILING_BY_MARKET = {
    'run_line':  0.50,
    'total':     0.30,
    'moneyline': 0.25,
}
```

Picks scoring above the per-market ceiling are routed to **Tier 1**, which is below the Edge Function's `SHADOW_TIER_MIN = 3` threshold and is therefore filtered out entirely — neither LIVE nor shadow. They never pollute any user-visible cohort.

The ceilings are set per market because EV scales differ:

| Market | Median EV | p90 EV | max EV | over 50% |
|---|---|---|---|---|
| run_line | 39.1% | 72.5% | 85.6% | 36 of 90 picks |
| total | 22.1% | 26.5% | 41.6% | 0 of 72 |
| moneyline | 11.5% | 19.5% | 32.6% | 0 of 32 |

### Layer 2 — Per-market visibility blocklist (Proposal 3, P0)

Until the moneyline model retrain ships and validates, the moneyline market is gated to `visibility = 'shadow'` regardless of EV/tier. Rationale: ML 50–55% predicted band actuals 16.7% on N=12 — a 33-percentage-point miss is far outside variance bounds and indicates the model is broken on this market, not just under-calibrated.

```typescript
// supabase/functions/pick-pipeline/index.ts
const LIVE_MARKET_BLOCKLIST = new Set(['moneyline']);
```

**Auto-revert trigger** (codified for the next retrain): remove `'moneyline'` from the blocklist when the next monthly retrain produces a candidate where ML 60-day backtest log-loss improves by ≥10% AND ML shadow-run win rate hits 50% on N≥30.

### Layer 3 — Isotonic recalibration pipeline (Proposal 4, P1)

The model is overconfident on RL (predicted 65–70% band actuals 54.3%, N=46) and on totals (61.1% actuals at 65–70%, N=18). An isotonic regression fit per market on `picks JOIN pick_outcomes` over the trailing 60 days closes this gap.

`worker/app/calibration_fit.py` runs the fit and writes candidate calibrators. Promotion to live use is **gated**:

- per-market log-loss on a held-out 20% slice must improve vs the unfitted baseline
- per-market N≥150 graded outcomes in the fit window
- post-promotion `/calibration-check` shows ECE ≤ 0.05 and per-tier reliability deviation ≤ 10pp

Cadence: **monthly**, not nightly. Nightly fitting on a small sample overfits.

Auto-rollback: if a promoted calibrator fails the post-promotion check, the live artifact reverts to the prior version (or to identity / no calibrator, if no prior exists).

---

## Sample-size rules (locked 2026-04-28 by pick-scope-gate)

| Change type | Sample minimum |
|---|---|
| Per-market EV ceiling adjustment (Layer 1) | N≥30 graded in the affected EV band |
| Per-market visibility blocklist (Layer 2) | N≥12 in the worst predicted-prob band, with magnitude ≥3σ from expected (waiver applies — tightening only) |
| Isotonic calibrator promotion (Layer 3) | N≥150 graded per market in the fit window |
| Per-(market × tier) tier remap (deferred Layer 0 below) | N≥30 graded per (market × tier) cell with reliability-diagram evidence |

---

## Deferred — Layer 0: Auto-calibrated tier boundaries from win-rate deciles

The original spec from 2026-04 proposed fitting per-market T5/T4/T3 boundaries from observed win rates. **Deferred** because the per-cell N=30 floor is currently met in only 1 of 9 cells (RL × T3, N=51). Resubmit when ≥6 of 9 cells qualify (~3–6 weeks at current pick volume).

Original mechanism (preserved for reference):

```sql
CREATE TABLE tier_calibration (
  market text NOT NULL,
  version timestamptz NOT NULL DEFAULT now(),
  t1_max_ev real NOT NULL,
  t2_max_ev real NOT NULL,
  t3_max_ev real NOT NULL,
  t4_max_ev real NOT NULL,
  realism_cap_ev real NOT NULL,
  sample_size int NOT NULL,
  PRIMARY KEY (market, version)
);
```

Worker queries `SELECT * FROM tier_calibration WHERE market = $1 ORDER BY version DESC LIMIT 1` and falls back to the hardcoded per-market ceilings (Layer 1 above) when sample size is insufficient.

---

## Open questions

1. **Uncertainty input** — `assign_confidence_tier(ev, market, uncertainty)` takes a third parameter that is currently always 0.0 in production. Drop or wire up to (a) SHAP variance across trees, (b) delta-model residual, (c) cross-validation prediction stddev?
2. **Per-market vs global tiers in the UI** — T5 on moneyline doesn't currently mean the same thing as T5 on totals (different base rates). The UI shows one tier number. Consider per-market badges, or accept global as a calibrated abstraction.

---

## File map

| File | Role |
|---|---|
| `worker/app/main.py` | `assign_confidence_tier(ev, market, uncertainty)` + `EV_REJECT_CEILING_BY_MARKET` |
| `worker/app/calibration_fit.py` | Monthly isotonic fit + promotion gate |
| `worker/models/calibration/<market>_isotonic.pkl` | Live calibrator artifact (per market) |
| `worker/models/calibration/candidates/<market>_isotonic.pkl` | Pre-promotion candidate |
| `supabase/functions/pick-pipeline/index.ts` | `LIVE_MARKET_BLOCKLIST`, EV/tier filter |
| `supabase/migrations/0020_calibration_history.sql` | Daily snapshot table |
| `apps/web/app/api/cron/calibration-snapshot/route.ts` | Daily snapshot cron |
