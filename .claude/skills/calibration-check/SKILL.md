---
name: calibration-check
description: Diagnostic skill — audits per-tier calibration on live graded picks. Computes ECE, max calibration deviation, reliability diagram. Delegates to the `mlb-calibrator` agent. Used as a gate inside `pick-test` and ad-hoc by `pick-research`.
argument-hint: [market — moneyline | run_line | totals | props | all (default) | --diagnostic for verbose tail-bin detail]
---

Market scope: `$ARGUMENTS` (default: all live markets)

---

## Inputs

- Current production model artifact + calibrator for each market in scope.
- Recent graded picks (typically rolling 90 days) with `calibrated_p`, `outcome`, `tier`.
- Baseline calibration metrics (prior ECE / max-deviation for delta computation).

## What to compute

For each market in scope:

1. **ECE** on the rolling sample.
2. **Max calibration deviation** across probability bins.
3. **Reliability diagram** (PNG/SVG saved to `docs/audits/calibration-<market>-<timestamp>.png`).
4. **Per-tier audit** if confidence tiers exist.
5. **Delta vs baseline** — is calibration drifting?

## Pass/fail (per CLAUDE.md gates)

- ECE deviation ≤ +0.02 from baseline → PASS this gate
- Otherwise → FAIL with the specific deviation

For tail bins:
- If a sparse tail bin shows max deviation > 0.1, flag for `mlb-calibrator` review even if overall ECE PASSes.

## Output

Write `docs/audits/calibration-<market>-<timestamp>.md` with:
- Summary table (market, ECE, max dev, vs baseline).
- Per-tier breakdown.
- Reliability diagram path.
- Verdict (PASS / FAIL).
- One-line recommendation if FAIL (refit / methodology review / data gap).

## Anti-patterns

- Reporting only ECE without max calibration deviation.
- Approving a sparse-tail-overfit pattern.
- Auditing without comparing to baseline.

## Return

≤150 words: per-market verdict table + one-line recommendation if any FAIL.
