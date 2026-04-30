---
name: pick-scope-gate-review
description: Stage 2 of the pick-improvement pipeline. Binary APPROVED/DENIED gate against locked pick constraints (EV/tier floors, sample-size minima, feature-leakage rules, rationale grounding, calibration invariants, ROI non-degradation, methodology agnosticism). Invokes the `pick-scope-gate` agent. Auto-invokes `pick-implement` on any APPROVED.
argument-hint: [path to proposal set — defaults to `docs/proposals/` newest batch]
---

Proposal set: `$ARGUMENTS` (or auto-detect newest batch in `docs/proposals/`)

---

## Mechanical rule check

For each proposal, run:

| Rule | Source | Action on fail |
|---|---|---|
| EV / tier floor respected | CLAUDE.md pick-pipeline section | DENIED |
| Sample-size minimum met (≥30 threshold / ≥100 feature / ≥200 methodology) | CLAUDE.md | DENIED |
| Feature-leakage check + parity fixture present | CLAUDE.md Methodology Stance | DENIED |
| Rationale grounding constraint preserved | mlb-rationale anti-patterns | DENIED |
| Calibration ECE deviation budget ≤ +0.02 | CLAUDE.md pick-pipeline | DENIED |
| ROI non-degradation vs current | CLAUDE.md pick-pipeline | DENIED |
| No architecture lock at agent layer | CLAUDE.md Methodology Stance | DENIED |
| Cost / rate-limit envelope respected | CLAUDE.md Budget Envelope + sub-budgets | DENIED |

Any rule fail → DENIED with specific rule cited.

## Lens-holder consultation (judgment-shaped criteria)

If mechanical checks pass but the proposal touches:

- **Methodology direction shift** → consult `chief-strategy-officer`
- **Empirical gate loosening** → consult `chief-engineering-officer`
- **Sub-budget breach or rate-limit increase** → consult `chief-operations-officer`
- **Cross-lens** (touches more than one of the above) → consult all relevant lens-holders; consensus required per CLAUDE.md disagreement protocol.

Persist lens-holder verdicts to `docs/proposals/<id>-verdict-<lens>.md`.

## Decision

For each proposal:
- All rules pass + no judgment criteria → APPROVED
- All rules pass + judgment criteria → APPROVED only if all consulted lens-holders approve
- Any rule fail → DENIED-WITH-REVISION-GUIDANCE
- 2nd DENIED on same proposal → escalate to user

## Hand off

Per CLAUDE.md auto-chain rule:
- ≥1 APPROVED → invoke `pick-implement` on the approved set
- All DENIED → pause, surface to user

## Return

Per-proposal table (proposal_id, verdict, 1-line rationale, lens-holder consulted) + handoff note.
