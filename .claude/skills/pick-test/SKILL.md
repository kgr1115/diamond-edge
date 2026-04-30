---
name: pick-test
description: Stage 4 of the pick-improvement pipeline. EMPIRICAL PASS/FAIL gate on the implemented change. Runs `/backtest`, `/calibration-check`, `/rationale-eval`, `/check-feature-gap`, `/pipeline-anomaly-scan` in parallel. Binary verdict. Invokes the `pick-tester` agent. Auto-invokes `pick-publish` on PASS or `pick-debug` on FAIL.
argument-hint: [change-set identifier — defaults to most recent post-implement state]
---

Change-set: `$ARGUMENTS` (or auto-detect)

---

## Run all gates in parallel

| Gate | Skill / Agent | PASS bar |
|---|---|---|
| Backtest ROI | `/backtest` (delegates to `mlb-backtester`) | ≥ −0.5% vs current at recommended EV threshold |
| Backtest CLV | `/backtest` | ≥ −0.1% on the same sample |
| Calibration | `/calibration-check` (delegates to `mlb-calibrator`) | ECE deviation ≤ +0.02 from baseline |
| Feature coverage | `/check-feature-gap` | ≥ current (no regression) |
| Rationale | `/rationale-eval` (delegates to `mlb-rationale`) | factuality + RG + banned-keyword + depth all PASS |
| Pipeline anomaly | `/pipeline-anomaly-scan` | clean (no new tier collapse, no volume drop, no staleness) |

## Aggregate

ALL gates must PASS for the change-set to PASS. Any single FAIL → overall FAIL.

If a gate returns INSUFFICIENT-EVIDENCE, treat as FAIL on that gate. Cite the specific data needed.

## Hand off

Per CLAUDE.md auto-chain rule:
- PASS → invoke `pick-publish`
- FAIL (1st) → invoke `pick-debug` on the failed gates
- FAIL (2nd, after debug + retry) → pause; orchestrator surfaces to user

## Anti-patterns (refuse the verdict)

- "1 of 6 gates failed but the change is small" → FAIL means FAIL.
- Reporting verdict without the specific gate(s) that failed.
- Re-running tests yourself instead of trusting specialist verdicts.
- Auto-publishing without all gates having reported back.

## Return

Per-gate table (gate, status, number, vs baseline) + verdict + handoff note.
