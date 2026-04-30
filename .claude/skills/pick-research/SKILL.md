---
name: pick-research
description: Stage 1 of the pick-improvement pipeline. Audit pick quality (ROI, CLV, calibration, feature coverage, rationale quality, EV/tier sensitivity) using the diagnostic skills, then return ≤10 evidence-backed proposals in the schema from CLAUDE.md. Invokes the `pick-researcher` agent.
argument-hint: [focus area — e.g. "calibration" or "totals market" or "rationale grounding" — or omit for full audit]
---

Focus area (if any): `$ARGUMENTS`

---

## Phase 1 — Diagnostics

Run the diagnostic skills in parallel; collect outputs.

| Diagnostic | Skill | What it answers |
|---|---|---|
| Backtest summary | `/backtest` | ROI, CLV, sample n on the rolling holdout per market |
| Calibration audit | `/calibration-check` | Per-tier ECE, max deviation, reliability shape |
| Rationale eval | `/rationale-eval` | Factuality, RG presence, banned-keyword absence, depth |
| Feature coverage | `/check-feature-gap` | % of games with full feature payload |
| Pipeline anomaly scan | `/pipeline-anomaly-scan` | Tier collapses, pick-volume drops, staleness |

If a diagnostic skill is missing or returns INSUFFICIENT-EVIDENCE, note it; do not block on it for unrelated proposals.

## Phase 2 — Cluster

Group symptoms by likely root cause:
- Calibration drift (ECE up, model output distribution shifted)
- Feature staleness (coverage drop, ingestion gap)
- Rationale grounding violation (eval flags, banned keywords)
- EV / tier threshold misalignment (volume spike or collapse)
- Methodology mismatch (CLV negative + ROI variance, model can't be calibrated to spec)

## Phase 3 — Propose

Write up to 10 proposals in `docs/proposals/<id>.md`. Each follows the schema in CLAUDE.md:

```yaml
proposal_id: <slug>
proposer: pick-researcher
lens: <CSO | CEng | COO | cross-lens>
claim: <one sentence>
evidence:
  - <diagnostic finding with numbers>
comparison:
  - approach_a: current
  - approach_b: proposed
  - delta_metrics: <what we expect to move>
risks: ...
rollback: ...
scope: ...
```

Hard cap: 10. If you have more, prioritize and cite the trade-down rationale at the bottom.

## Phase 4 — Hand off

Per the auto-chain rule in CLAUDE.md, immediately invoke `pick-scope-gate-review` on the proposal set.

## Anti-patterns (refuse to ship)

- Proposals without evidence numbers.
- Proposals that pre-pick a model architecture (CLAUDE.md Methodology Stance).
- Proposals proposing implementation specifics. You propose direction.
- Proposals with no rollback path.

## Return

≤200 word summary + count of proposals + auto-invoke note.
