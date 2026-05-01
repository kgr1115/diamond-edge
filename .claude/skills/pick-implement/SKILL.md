---
name: pick-implement
description: Stage 3 of the pick-improvement pipeline. Translates APPROVED proposals into per-specialist task briefs and orchestrates implementation across `mlb-model`, `mlb-feature-eng`, `mlb-calibrator`, `mlb-rationale`, `mlb-backend`, `mlb-data-engineer`. Invokes the `pick-implementer` agent. Auto-invokes `pick-test` on completion.
argument-hint: [path to approved proposal set — defaults to newest APPROVED batch in `docs/proposals/`]
---

Approved proposal set: `$ARGUMENTS` (or auto-detect)

---

## Per-proposal decomposition

For each APPROVED proposal:

1. **Read the proposal in full** — claim, evidence, comparison, scope.
2. **Identify the touched substacks.** Use the routing cheat sheet in `pick-implementer.md`:

| Touches | Route to |
|---|---|
| Model architecture / training / serving (Vercel Function) | `mlb-model` |
| Feature definition / parity / leakage | `mlb-feature-eng` |
| Calibration method / per-tier audit | `mlb-calibrator` |
| Rationale prompt / grounding / scrub | `mlb-rationale` |
| EV / tier threshold (in API route) | `mlb-backend` |
| Ingestion cadence / cache TTL | `mlb-data-engineer` |
| Frontend pick attributes | `mlb-frontend` |

3. **Write per-specialist task briefs.** Each brief: objective (1 sentence), inputs, deliverable shape, definition of done.
4. **Dispatch in parallel** where the changes are independent. Sequential where there's a dependency (e.g., feature must land before model can consume it).

## Aggregate

When all delegations report:
- Verify cross-specialist contracts (new feature → model knows to consume it; new tier threshold → frontend renders it).
- Resolve conflicts before handing off.

## Hand off

Per CLAUDE.md auto-chain rule:
- All delegations done + contracts verified → invoke `pick-test`
- Any delegation blocked → pause; surface to orchestrator with the specific blocker

## Hard refusals

- Do not ship a partial proposal. All pieces or none.
- Do not let a feature land without `mlb-feature-eng`'s parity fixture.
- Do not let a model land without `mlb-calibrator`'s audit.
- Do not auto-invoke `pick-test` until cross-specialist contracts verify.

## Return

≤200 word summary: proposals implemented, delegations made (one line each), aggregate status, handoff note.
