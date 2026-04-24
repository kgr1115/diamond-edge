---
name: pick-implement
description: "Execute a pick-scope-gate-approved pick-quality change — edit model/feature/prompt/threshold code, run local syntax + dry-run checks, produce pick-tester handoff. Invoked after pick-scope-gate-review returns an APPROVED verdict. Does NOT run the backtest gate and does NOT commit."
argument-hint: <proposal title or "next" for next approved proposal>
---

Proposal: `$ARGUMENTS`

---

## Inputs required before starting

1. Researcher's proposal (from `docs/improvement-pipeline/pick-research-{date}.md`).
2. Pick-scope-gate's APPROVED verdict (from `docs/improvement-pipeline/pick-scope-gate-{date}.md`) — scope annotations, testing requirements, non-negotiables.
3. Current state: `git status`, `worker/models/<market>/feature-spec.md`, `supabase/functions/pick-pipeline/index.ts`, relevant worker code.

Missing any → stop, ask orchestrator.

---

## Phase 1 — Restate the contract

One paragraph in plain English: what you're changing, why, which metric improves. Compare to pick-scope-gate's approval verbatim.

Drift → stop. Re-sync with pick-scope-gate.

---

## Phase 1.5 — Subscriber-visibility triage

Pick-quality changes nearly always affect subscribers (win rate, which picks appear, rationale style). Triage:

- **Tier label / rationale format change** → update `worker/models/calibration-spec.md` (if tier semantics moved) + TASK-007 (if rationale style) + TASK-008 (if UI implication).
- **EV / tier threshold change** → update `supabase/functions/pick-pipeline/index.ts` comments with date + rationale; update TASK-010-pre if it describes filter logic.
- **Feature addition** → update `worker/models/<market>/feature-spec.md` AND the relevant TASK brief describing feature coverage.
- **Calibration re-map** → update `worker/models/calibration-spec.md`.
- **Retrain policy change** → update `worker/models/retrain/monthly.py` docstring AND the CLAUDE.md or brief describing auto-promote.

Docs update in the same diff. Pick-tester and pick-publisher will fail the commit if they catch a subscriber-visible change with missing docs.

---

## Phase 2 — Plan the diff

Every file, one sentence. If > ~5 source files (excluding retrain reports, model artifacts), hand back to pick-scope-gate for decomposition.

### Typical file shapes

| Change | Files |
|---|---|
| Threshold | `supabase/functions/pick-pipeline/index.ts` (EV/tier constants) + comment with date |
| Rationale prompt | `worker/app/prompts/rationale-*.txt` + `worker/app/rationale.py` + cache-version bump if structural |
| Feature add | `worker/models/<market>/feature-spec.md` + ingester code + worker feature-assembly + training code + feature-vector assembly in Edge Function |
| Calibration re-map | `worker/models/calibration-spec.md` + `worker/app/predict.py` wrapper |
| Retrain config | `worker/models/retrain/monthly.py` |
| Tier relabeling | `apps/web/components/picks/confidence-badge.tsx` + `apps/web/components/picks/slate-filters.tsx` |

---

## Phase 3 — Implement

### Style rules

- Python worker: match existing formatting (ruff-compatible; 4-space indent; type hints where already present).
- TypeScript Edge Function: match existing style; use Deno's standard library imports.
- Threshold constants: put the change behind a named constant with a one-line comment citing the date + rationale doc.
- Don't refactor beyond scope. Surgical.

### Delegate to domain specialists when depth warrants

- **mlb-ml-engineer** — feature engineering, model/calibration, training code, backtest interpretation.
- **mlb-ai-reasoning** — rationale prompts, Claude routing (Haiku vs Sonnet 4.6), prompt-caching structure, grounding rules.
- **mlb-backend** — Edge Function, schema, RLS, threshold constants, API routes.
- **mlb-data-engineer** — ingester gaps (umpire / weather / pitcher splits / travel).

Small obvious edits in these surfaces → do yourself. Novel design → spawn specialist, pass through.

---

## Phase 4 — Pick-pipeline landmines

| Check | Rule |
|---|---|
| Feature leakage | No feature may reference post-first-pitch data. Check update timestamps of the source column. |
| Training-serving skew | Features added to training must also be computed at inference time (serving-side feature-vector assembly matches training). |
| Rationale cache version | Structural prompt changes MUST bump a cache-version constant, or old hits serve stale text. |
| Edge Function timeout | ~150s hard cap. Parallelize rationale generation; don't blow the budget. |
| Worker `/predict` contract | PickCandidate schema change → ship worker + Edge Function together. |
| `required_tier` | Always `'pro'` or `'elite'`. Never `'free'`. |
| Model artifact bloat | `worker/models/*/artifacts/v{timestamp}/` directories are large; don't auto-commit. Only `current_version.json` pointer + `metrics.json` should land in the repo when promoting. |
| Permissions | No `--dangerously-skip-permissions`. |

---

## Phase 5 — Local verification

- **Python syntax** on changed worker files: `python -m py_compile <file>` or `ruff check <file>`. Clean.
- **TypeScript**: `cd apps/web && npx tsc --noEmit --skipLibCheck`. Clean.
- **Feature-gap sanity**: if you changed feature code, run `/check-feature-gap` (read-only). Confirm coverage didn't drop.
- **Prompt dry-run**: if you changed the rationale prompt, hit worker `/rationale` locally with 2–3 fixture PickCandidates. Verify output shape + grounding.
- **Retrain dry-run**: if you changed training code, run `/retrain --dry-run` (read-only; doesn't promote). Confirm the report is generated.
- **DO NOT deploy** anything. `/deploy-edge` and `/deploy-worker` are user-invoked, later.

---

## Phase 6 — Pick-tester handoff

```markdown
### Implementation for: {proposal title}
**Files changed:**
  - `path/to/file` — {purpose}
**Domain specialists consulted:** {list or "none"}
**Subscriber-visible impact:** {volume change, rationale style, tier label, etc.}
**Compliance surfaces touched:** age gate | geo-block | responsible-gambling | none
**Retrain required?** yes | no (if yes: `/retrain --dry-run` summary pasted)
**Prompt cache invalidated?** yes | no
**Local verification:**
  - syntax: PASS
  - dry-run: PASS
  - feature-gap: before N% / after M%
  - {other}
**How to test (for pick-tester):**
  - Mandatory gates: {per pick-scope-gate annotations}
  - Backtest window: 60d / 90d / full 2024
  - Rationale-eval sample size: N picks
**Known risks:**
  - {non-obvious failure modes}
**Cost impact:** {$/mo}
```

---

## Hard stops

- Ambiguous approval → ask pick-scope-gate.
- Proposal needs more files than scoped → hand back.
- Change requires mutating historical rows → STOP, escalate with SQL drafted, not executed.
- Worker + Edge Function must ship together → flag for pick-publisher to coordinate the two deploys.
- Feature leakage detected mid-implementation → STOP, escalate.

---

## Non-negotiables

- Never commit. Never push. Never deploy.
- Never touch production `picks` / `pick_outcomes` / `pick_clv` rows.
- Never weaken LIVE floor.
- Never skip docs update on subscriber-visible change.
- No `--dangerously-skip-permissions`.
