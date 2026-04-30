---
name: backtest
description: Diagnostic skill — runs holdout backtest, computes ROI and CLV, sweeps EV thresholds, enforces sample-size minima, detects look-ahead. Delegates to the `mlb-backtester` agent. Used as a gate inside `pick-test` and ad-hoc by `pick-research`.
argument-hint: [market — moneyline | run_line | totals | props | all (default) | --sensitivity for EV-threshold sweep verbose]
---

Market scope: `$ARGUMENTS` (default: all live markets)

---

## Inputs

- Current production model artifact for each market in scope.
- Pre-declared holdout slice (immutable; declared at training time, hashed if possible).
- Recommended EV threshold from the model's serving config.

## What to compute

For each market in scope:

1. **ROI** at recommended EV threshold + ≥2 adjacent thresholds (sensitivity).
2. **CLV** mean, median, distribution. Per-market and aggregated.
3. **Sample size** per market and per tier.
4. **Comparison vs prior production** if a prior artifact exists.
5. **Per-tier breakdown** if confidence tiers exist.

## Discipline checks (refuse to evaluate if any fail)

- Holdout slice was pre-declared; not re-used for selection.
- Features in the model passed leakage audit (look-ahead clean).
- Sample size meets the floor for the change shape (≥30 threshold / ≥100 feature / ≥200 methodology per CLAUDE.md).

If any discipline check fails → INSUFFICIENT-EVIDENCE; cite the specific failure; do not produce numbers that look authoritative on shaky ground.

## Output

Write `docs/backtests/<market>-<timestamp>.md` with:
- Holdout description (date range, sample n, hash if available).
- Metrics table.
- Sensitivity table.
- Comparison vs baseline.
- Verdict against pick-pipeline gates (PASS / FAIL / INSUFFICIENT-EVIDENCE).

## Anti-patterns

- Reporting ROI without CLV.
- Sweeping thresholds and reporting only the best.
- Ignoring vig in EV calculation.
- Treating a backtest as proof of forward edge — it's necessary, not sufficient.
- Re-using a holdout slice for selection.

## Return

≤200 words: holdout summary + headline metrics + verdict + path to full report.
