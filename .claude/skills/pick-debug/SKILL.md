---
name: pick-debug
description: Stage 5a of the pick-improvement pipeline. Root-causes pick-quality FAILs from `pick-test`. Drills via `/investigate-pick` and `/explain`, routes targeted fixes to specialists, re-invokes `pick-test`. Invokes the `pick-debugger` agent. Distinct from the system pipeline `/debug` (codebase failures, not pick-quality).
argument-hint: [pick-test FAIL identifier — defaults to most recent FAIL]
---

FAIL: `$ARGUMENTS` (or auto-detect most recent)

---

## Triage

Read `pick-test` verdict. Identify the failed gate(s). Common patterns:

| Failed gate | Likely root cause | Drill |
|---|---|---|
| Backtest ROI drop, CLV unchanged | Variance, not regression | `/backtest --sensitivity` to confirm with sample-size analysis |
| Backtest ROI + CLV both drop | Real edge loss | `/investigate-pick` on tail of bad picks; route to `mlb-feature-eng` or `mlb-calibrator` |
| Calibration ECE spike | Calibrator overfit or output distribution shifted | `/calibration-check --diagnostic`; route to `mlb-calibrator` for refit |
| Feature coverage drop | Upstream ingestion gap | Check cron telemetry; route to `mlb-data-engineer` |
| Rationale eval FAIL | Grounding loosened or attribution payload changed | `/rationale-eval --verbose`; route to `mlb-rationale` |
| Pipeline anomaly: tier collapse | EV / tier threshold misalignment | `/explain` on recent picks; route to `mlb-backend` |
| Pipeline anomaly: volume drop | Filter applied too aggressively | Check pick-pipeline logs; route to `pick-implementer` for re-scope |

## Hypothesize

State the root cause in one sentence. If you can't:
- Say "root cause unclear; need <specific data>"
- Escalate to user; do not blind-fix

## Fix

Route the targeted fix to the relevant specialist. Specialist implements; you do not.

## Re-test

Per CLAUDE.md auto-chain rule, invoke `pick-test` after the specialist reports done.

## Pause points

- 2nd FAIL on same change after fix attempt → pause; surface to user with options
- Root cause is in system layer (cron, schema, infra) → kick to system `/debug`
- Root cause is methodology-shaped (the chosen approach is wrong, not buggy) → kick to `mlb-research` + CSO

## Anti-patterns

- Patching the symptom (loosening the gate) instead of the cause.
- Treating variance as regression without sample-size check.
- Looping past 2 retries.
- Declaring fixed without re-running `pick-test`.

## Return

≤200 words: failed gate(s) + root cause sentence + fix routed to + re-test invocation.
