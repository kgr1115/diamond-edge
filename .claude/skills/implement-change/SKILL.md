---
name: implement-change
description: Execute a scope-gate-approved improvement to Diamond Edge — write or edit the code, syntax-check, lint, dry-run fixtures, and produce a tester handoff report. Invoked after scope-gate-review returns an APPROVED verdict. Does NOT run the full test battery and does NOT commit.
argument-hint: <proposal title or "next" to pick the next approved proposal>
---

Proposal: `$ARGUMENTS`

---

## Inputs required before starting

1. Researcher's original proposal (what, why, which files).
2. Scope-gate's APPROVED verdict + scope annotations (constraints, compliance flags, testing requirements).
3. Current `git status` of the repo.

If any are missing, stop and ask the orchestrator.

---

## Phase 1 — Restate the contract

One paragraph, plain English: what you're about to change and why. Confirm it matches scope-gate's approval word-for-word.

If drift → stop. Sync with scope-gate before proceeding.

---

## Phase 1.5 — User-facing docs discipline

If scope-gate flagged this change as subscriber-facing (new pick-slate feature, changed tier gate, new compliance copy, changed billing flow, new marketing-surface copy), the diff MUST include docs updates in the same commit.

Relevant docs surfaces:
- `README.md` (public-facing)
- `CLAUDE.md` (agent standing brief)
- `docs/briefs/**`, `docs/adr/**`
- In-app help/copy files

Internal refactors, log cleanup, typo fixes → no docs update required. Flag as non-subscriber-facing in handoff.

If docs update is required and missing, tester will catch it and publisher will refuse. Save the round-trip — include in the original diff.

---

## Phase 2 — Plan the diff

List every file you'll touch. One sentence per file. If >~5 files, hand back to scope-gate for decomposition.

---

## Phase 3 — Implement

**Style rules:**
- Edit surgically. Match existing code style (Tailwind class ordering, TS import ordering, Supabase function patterns, ruff config for Python worker).
- Don't refactor beyond what the proposal requires.
- Don't add comments unless WHY is non-obvious.
- Don't add backwards-compat shims or dead code.
- Fail at the boundary — validate external API responses and user input; trust internal code.

**When to delegate to a Diamond Edge domain specialist:**

| Domain | Specialist | When |
|---|---|---|
| Supabase migrations, API routes, RLS, Stripe, auth | `mlb-backend` | New schema, new API surface, auth-flow changes |
| Next.js pages, Server Components, tier-gate UX, shadcn | `mlb-frontend` | New user-facing surface, complex RSC architecture |
| The Odds API, MLB Stats, Statcast, Upstash cache | `mlb-data-engineer` | New ingestion, new cache key scheme, odds rate-limit tuning |
| Features / training / serving / calibration / backtesting / methodology | `mlb-feature-eng`, `mlb-model`, `mlb-calibrator`, `mlb-backtester`, `mlb-research` | The 5-way analysis substack — pick the agent matching the change |
| Claude prompt design, rationale gen, token budgeting | `mlb-rationale` | Rationale prompts, cache-hit optimization |
| Vercel config, Supabase config, GitHub Actions, DNS | `mlb-devops` | Infra, CI, secrets, monitoring |
| State legality, disclaimers, ToS, responsible gambling | `mlb-compliance` | Any legal/compliance copy change |

For small, obvious edits inside these surfaces, just do it yourself. For new design decisions in the surface, spawn the specialist. You remain accountable for the final diff.

---

## Phase 4 — Diamond Edge landmines

Populate this table as real incidents compound. Seed entries reflect the locked stack.

| Check | Rule |
|---|---|
| `--dangerously-skip-permissions` | Never. Use scoped `permissions.allow` in `.claude/settings.local.json`. |
| Vercel function timeout | 60s default; opt in to longer with `export const maxDuration = N` up to 300 (Fluid Compute). >300s is a `kind: infra` proposal. |
| Supabase RLS | Every new user-scoped table ships RLS policies in the same migration. No exceptions. |
| Odds-API credit burn | Any code hitting The Odds API routes through `lib/odds/` cache wrapper. Never cold-fetch in a render path. |
| Stripe webhook | Always verify `Stripe-Signature` first; idempotency key on every DB write. |
| Anthropic model routing | Haiku 4.5 default; Sonnet 4.6 only on premium-tier picks. Always enable prompt caching on system prompt + tool schemas. |
| Age gate / geo-block | New subscriber-facing pages sit behind existing middleware. No bypass routes. |
| Cross-platform paths | Windows dev + Linux prod. Use `path.join` / `pathlib`. Never string-concat paths. |
| Migration destructive SQL against prod | STOP. Escalate with SQL drafted but not executed. |

---

## Phase 5 — Local verification

- `npx tsc --noEmit` on affected TS/TSX.
- Project lint (`npm run lint` or equivalent) on the diff.
- `python -m py_compile` or `ruff check` on affected Python (Vercel Function routes that run Python).
- JSON/YAML files: parse with the appropriate loader.
- Supabase migration: dry-run on a local branch/dev project. NEVER run against prod from this step.
- Vercel API route: `next dev` (or `vercel dev`) + fixture body, confirm response shape. DO NOT deploy — `vercel:deploy` is user-invoked.
- Agent profile or skill: frontmatter parses, `name` matches filename/dir, description ≤3 sentences / ≤500 chars / routing-specific.
- Stripe change: signature-verification still first check, idempotency keys still present.
- Compliance copy: grep the diff for deleted disclaimer wording — flag any shrinkage.

---

## Phase 6 — Tester handoff report

```markdown
### Implementation for: {proposal title}
**Files changed:**
  - `path/to/file` — {one-line purpose}
**Subscriber-facing?** yes | no  — {if yes, docs updated?}
**Compliance surfaces touched:** age gate | geo-block | responsible-gambling | none
**Local verification:**
  - tsc: PASS | FAIL
  - lint: PASS | FAIL
  - python syntax (if applicable): PASS | N/A
  - migration dry-run (if applicable): PASS | N/A
  - Edge Function fixture test (if applicable): PASS | N/A
  - Worker local test (if applicable): PASS | N/A
**How to test (for the tester):**
  - {specific end-to-end scenario}
  - {edge cases from scope-gate's testing requirements}
**Known risks:**
  - {non-obvious failure modes}
**Cost impact:** {$/mo incremental, or zero}
```

---

## Hard stops — escalate instead of proceeding

- Scope-gate annotation is ambiguous → ask scope-gate; don't guess.
- Implementation reveals >~5 files → hand back to scope-gate.
- Change would touch an interface other modules depend on → pause; confirm blast radius was considered.
- Proposal requires a dependency/service scope-gate would deny → flag; don't silently substitute.
- Supabase migration would require destructive SQL against prod → STOP. Escalate with SQL drafted but not executed.

---

## Non-negotiables

- Never commit or push. Work ends at working diff + handoff.
- Never deploy. No `supabase functions deploy`, no `fly deploy`, no `vercel deploy --prod`.
- Never touch production user data. Dev/local only.
- Never weaken compliance surfaces.
- Never add `--dangerously-skip-permissions`.
- Never expand scope silently.
