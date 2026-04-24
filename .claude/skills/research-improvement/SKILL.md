---
name: research-improvement
description: Audit the Diamond Edge codebase end-to-end and research external precedent to produce a prioritized list of concrete improvement proposals. Invoked at the start of an improvement cycle, before scope-gate-review runs. Returns a structured proposal set (max 10) ready for scope-gate gating.
argument-hint: [focus area — e.g. "pick-pipeline" or "billing" or "picks UI" — or omit for full audit]
---

Focus area (if any): `$ARGUMENTS`

---

## Phase 1 — Audit (read-only pass through the live codebase)

Trace Diamond Edge's core subscriber flow in order. Identify friction at each step.

### Where to look

| Surface | Files to read |
|---|---|
| Picks UI | `app/picks/**`, pick-card components, tier-gate logic |
| Pick detail | Pick detail pages, rationale render, confidence/EV display |
| Pick pipeline | `supabase/functions/pick-pipeline/**`, `worker/models/**`, `worker/api/**`, `worker/ingest/**` |
| Schema | `supabase/migrations/**` |
| Cron coverage | **`supabase/migrations/**` for `cron.schedule(...)` calls** (pg_cron catalog) **AND** `vercel.json` **AND** `apps/web/app/api/cron/**` route handlers. A handler without a schedule in EITHER catalog is unscheduled; a schedule without a handler is dead. A handler scheduled in BOTH catalogs double-invokes. Always inspect all three together before proposing cron-related changes. |
| Cache / odds | `lib/odds/**`, Upstash Redis wrappers |
| Bankroll UI | Bankroll dashboard, bet rows, delete-bet flow, ROI analytics |
| Subscription / billing | Stripe webhook handlers, tier-gate middleware, checkout flow |
| Auth | Supabase Auth flows, RLS policies |
| Compliance surface | 21+ age gate, geo-block middleware, responsible-gambling disclaimers |
| Agent profiles / skills | `.claude/agents/*.md`, `.claude/skills/**/SKILL.md` — descriptions specific enough for routing? |
| Onboarding | `README.md`, `CLAUDE.md`, `docs/briefs/**`, `docs/adr/**` |
| Docs vs behavior | Compare CLAUDE.md workflow descriptions to actual code |

### Friction checklist

- Silent failures in the pipeline (no subscriber-visible error state when pipeline stalls)
- Loading states without ETA / progress signal
- Missing empty-state UI (0 games today, non-subscriber, pipeline-in-progress)
- Stale cache that subscribers don't know is stale
- Tier gates that aren't obvious before the user hits one
- Agent profiles with overlapping or vague descriptions
- Skills with placeholder text or imprecise `description` fields
- Onboarding steps requiring out-of-band knowledge
- Compliance copy that's easy to miss or dismissed without reading

---

## Phase 2 — External research

Use WebSearch/WebFetch to study adjacent tools and UX conventions. Filter everything against Diamond Edge's hard constraints before including it.

Good search angles:
- How do paid betting-picks products (Action Network, Sharp App, Pickswise, BetQL) structure pick confidence, bankroll advice, and tier gates?
- What UX conventions exist for responsible-gambling disclosure that actually get read?
- What pick-pipeline patterns reduce silent-failure rates at the ML→LLM boundary?
- What Next.js App Router patterns keep subscriber pages fast under Vercel's 10s cap?
- What Supabase Edge Function patterns handle long-running ML work without hitting Vercel's 60s function cap?
- What calibration/backtesting techniques catch model-drift before subscribers notice?

**Hard constraints — never recommend anything that:**
- Pushes monthly infra over $300/mo or odds API over $100/mo.
- Adds a non-Anthropic LLM (OpenAI, Google, local models).
- Adds hosting beyond Vercel / Supabase / Upstash / Fly.io.
- Adds a sportsbook beyond DK+FD in v1 UX.
- Expands state coverage beyond DK+FD overlap.
- Adds bet placement, fund custody, non-MLB sports, or a mobile app.
- Removes or weakens 21+ age gate / geo-block / responsible-gambling disclaimers.
- Touches real subscriber bet/bankroll data without a migration plan + user approval.

---

## Phase 3 — Synthesize into proposals

Up to 10 proposals. One finding → one proposal. Specific: file, behavior change, subscriber-facing impact.

### Output format (submit to scope-gate)

```markdown
# Research — {YYYY-MM-DD}

## Proposal N: {short title}
**Category:** reliability | UX | pick-pipeline | data | ML-quality | LLM-rationale | compliance | billing | onboarding | docs | other
**Why it matters for the user:** {paragraph — subscriber-facing impact}
**Concrete change:** {1-2 paragraphs — which files, what behavior change, no hand-waving}
**Sources / precedent:** {cite if drawn from external research}
**Estimated scope:** single file | multi-file | schema | dependency | new-feature-flag
**Risk:** {what could break — especially in pipeline, billing, or compliance surfaces}
**Cost impact:** {incremental $/mo, or zero}
**Priority:** P0 reliability/compliance blocker | P1 high subscriber value | P2 polish | P3 nice-to-have
```

---

## Common failure modes for this role

- **Scope creep** — full rewrites, new hosted services, non-MLB features, bet-placement. Cut.
- **Vague proposals** — scope-gate returns vague proposals for revision, costing a round trip. Name the file; name the behavior.
- **Forbidden dependencies** — re-read CLAUDE.md's locked-stack section before proposing anything that adds a dependency.
- **Cost blindness** — every proposal must state monthly cost impact, even zero.
- **Compliance-weakening** — any proposal that removes a disclaimer, shrinks a gate, or bypasses geo-block is auto-denied. Don't propose.
- **Missing the docs-vs-behavior gap** — CLAUDE.md often describes workflows that diverged from code. High-value P1 proposals.

---

## When you find nothing high-leverage

Valid output: "Found no high-leverage improvements this cycle. Highest-priority findings are P3/nice-to-have. Recommend pausing the pipeline for N cycles or revisiting after next feature ship reveals new friction."
