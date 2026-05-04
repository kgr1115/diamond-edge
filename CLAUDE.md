# Diamond Edge — MLB Picks SaaS

This is the source of truth every agent in this project reads. Locked decisions below are non-negotiable unless explicitly reopened by the user (kyle.g.rauch@gmail.com) or the orchestrator.

## Product (v1)

A paid, web-only MLB betting picks SaaS with tiered subscriptions. Users get statistically-grounded, AI-explained picks across moneyline, run line, totals, props, parlays, and futures. Transparent historical pick performance, bankroll tracking, stats deep-dives.

**Non-goals v1:** placing bets, holding user funds, non-MLB sports, native mobile apps.

## Locked Stack (2026-04-22; 2026-04-30 — Vercel-only collapse)

| Layer | Choice | Notes |
|---|---|---|
| Frontend framework | Next.js 15 (App Router) + TypeScript | Server Components for fast initial paint |
| Styling | Tailwind CSS + shadcn/ui | Clean defaults, minimal component-library lock-in |
| Hosting (web + API + jobs) | Vercel (Fluid Compute) | Up to 300s/function, full Node.js runtime; replaces prior Fly.io worker + Supabase Edge Function topology |
| Database + Auth + Storage | Supabase (Postgres, RLS) | Supabase Auth (email + OAuth); Storage available for model artifacts if size demands |
| Cache | Upstash Redis | Aggressive caching for odds data |
| Background jobs | Vercel Cron + Vercel Functions | All compute on Vercel. No Fly.io. No Supabase Edge Functions. |
| Billing | Stripe | Subscriptions + webhooks |
| Odds data | The Odds API ($59/mo 100K-credit tier as of 2026-04) | Tiers: $30 (20K) / $59 (100K) / $119 (5M). Cached pulls, no real-time polling |
| MLB stats | MLB Stats API (free, public) | Authoritative for schedules, rosters, box scores |
| Statcast | Baseball Savant | Free, scrape-friendly pitch/batted-ball data |
| LLM | Anthropic Claude only | Haiku 4.5 default, Sonnet 4.6 for premium picks |

**Topology note:** prior architecture used a Fly.io Python worker for ML inference + a Supabase Edge Function for orchestration. Both were retired in the 2026-04-30 wipe. The replacement collapses everything onto Vercel: pick generation, training-orchestration, rationale generation, and ingestion crons all run as Vercel Functions under Fluid Compute (300s timeout, Node.js or Python runtime). If a future model architecture demands GPU or >300s training, that becomes a `kind: infra` proposal — not a default assumption.

## Brand

- **Name:** Diamond Edge
- **Primary domain:** `diamond-edge.co` (purchased 2026-04-23 — replaces the earlier plan to use `diamondedge.ai`; superseded by this commit)
- **Pre-launch blocker:** USPTO clearance check at [tmsearch.uspto.gov](https://tmsearch.uspto.gov) against "Diamond Edge Technology LLC"

## Sportsbooks & Compliance

- **v1 sportsbook coverage:** DraftKings + FanDuel only. Data model must extend to more books without schema churn.
- **v1 geography:** states where BOTH DK and FD are fully legal and operational. Geo-block everywhere else. Compliance agent produces the authoritative list.
- **Hard requirements:** 21+ age gate, responsible-gambling disclaimers on every pick surface, no bet placement, no fund custody.

## Budget Envelope

**<$300/month total infra + data cost at <500 users.** Odds data hard-capped at $100/mo. Any recommendation that risks breaking this must surface the cost explicitly and offer mitigations.

### Per-component sub-budgets (COO maintains; review monthly)

| Component | Target | Hard cap |
|---|---|---|
| The Odds API | $119/mo (5M-credit tier as of 2026-04-30) | $130/mo |
| Vercel (Pro + Fluid Compute functions) | $30/mo | $60/mo |
| Supabase | $25/mo | $50/mo |
| Upstash Redis | $10/mo | $25/mo |
| Anthropic (rationale) | ARCHIVED 2026-04-30 — $0 effective ($30/$80 spec preserved for un-archive) | n/a |
| Stripe (fees, not infra) | passthrough | n/a |
| Misc / overhead | $15/mo | $30/mo |
| Headroom | remainder | — |

A sub-budget breach for two months in a row is an automatic COO review item. Sub-budgets are owner-set; COO updates this table when the user adjusts, with the conversation cited in the commit message.

**2026-04-30 changes:**
- The Odds API tier upgraded from $59/100K to $119/5M monthly. ~50× credit headroom; affordable historical backfills now within scope.
- Anthropic line archived per Kyle's directive — `mlb-rationale` work paused for the personal-tool / portfolio phase. Spec preserved; un-archive when rationale reactivates.
- Fly.io line was retired in the prior Vercel-only collapse. Re-introducing is a `kind: infra` proposal.

The Fly.io worker line was removed 2026-04-30 with the Vercel-only collapse; the $30/mo target is reallocated to Vercel (now hosting all compute). If a future model architecture demands GPU or >300s training (CPU-only Fluid Compute is the current ceiling), re-introducing a separate worker becomes a `kind: infra` proposal — not a default.

## Methodology Stance (locked 2026-04-30)

The framework is **methodology-agnostic on modeling**. Nothing in this file or the agent roster pre-picks a model architecture, calibration method, or feature framing. `mlb-research` surveys options and proposes experiments; `mlb-model` implements; `mlb-calibrator` and `mlb-backtester` gate empirically; CEng decides what ships.

What is NOT methodology-agnostic (locked):
- Calibrated probabilities (every model surface a calibrated `p` regardless of architecture).
- Backtest discipline (pre-declared holdout, no re-use for selection, look-ahead audit on every feature change).
- CLV-aware ROI reporting (positive ROI with negative CLV is variance, not edge — escalate, don't ship).
- Comparison-against-current as the bar for promotion (no methodology change ships without head-to-head numbers on the same holdout).
- Market-prior awareness (the line is information; approaches that ignore it must justify why).

Memory should not encode "we always use LightGBM" or any equivalent — that contradicts this stance. Architecture choices live in `models/<market>/` (artifact directory at repo root) and the `metrics.json` + `architecture.md` for the artifact, not in the CLAUDE / agent layer.

### Cold-Start Lane (added 2026-04-30)

The pick-improvement pipeline assumes a current production artifact to compare against. On a fresh build, none exists — every diagnostic skill returns INSUFFICIENT-EVIDENCE on day one. The cold-start lane is the path the FIRST artifact takes into production.

**v0 promotion criteria (no comparison baseline; one-time):**

1. **Holdout discipline preserved.** Pre-declared holdout slice; no re-use for selection. (Same as steady-state.)
2. **Sample-size floor met.** ≥200 graded picks per market on the holdout — same floor as a methodology change. v0 is a methodology change against "no model."
3. **Backtest viable.** ROI ≥ 0% AND CLV ≥ 0% on the holdout (positive, not "non-degraded"). v0 has no negative-degradation budget because there's nothing to degrade against.
4. **Calibration to spec.** ECE ≤ 0.04 on the holdout (absolute, not relative to baseline). Max calibration deviation reported.
5. **Look-ahead audit clean.** Every feature snapshot-pinned; `mlb-feature-eng` signs off.
6. **Variance-collapse guard clean.** Model is not a passthrough on the market prior — confirmed by `mlb-model`.
7. **Rationale eval PASS.** Factuality, RG presence, banned-keyword absence, depth — same gate as steady-state.
8. **CEng explicit sign-off.** v0 is the single artifact that promotes without a `pick-tester` PASS, because `pick-tester` requires a baseline. CEng reads the bundled report and either approves or sends back.

After v0 lands as `current/`, every subsequent promotion runs through the normal `pick-tester` gates. The cold-start lane is single-use per market.

**What this means in practice:** the first pick-improvement cycle on a fresh model ships the model itself. `pick-research` is skipped (nothing to audit); `pick-implementer` triggers `mlb-feature-eng` + `mlb-model` + `mlb-calibrator` + `mlb-backtester` directly; the bundled v0 report goes to CEng instead of `pick-tester`. Once `current/` exists, the pipeline operates as documented.

## Engineering Principles

- **Ship over polish.** v1 must be launchable. Polish is v1.1+.
- **Extensibility without over-engineering.** Data models and API shapes should survive adding a 3rd sportsbook or a new market without schema churn, but don't design for hypothetical 2028 use cases.
- **No half-finished implementations.** If a feature isn't complete behind its flag, it doesn't merge.
- **No premature abstractions.** Three similar lines beats a speculative helper.
- **No comments explaining *what*.** Identifier names do that. Comments only for non-obvious *why*.
- **Fail at the boundary.** Validate user input and external API responses; trust internal code.
- **Cost-aware by default.** LLM cost, odds API request count, Vercel function duration — all go in the engineering decision criteria, not just "correctness."

## Agent Roster

All agents live in `.claude/agents/`. Orchestration is owned by `mlb-picks-orchestrator`. Domain specialists do not delegate to each other directly — they return to the orchestrator, which routes. Lens-holders are invoked by the orchestrator (or directly by the user) for judgment calls per the Three-Lens Governance section below.

### Lens-holders (3)

- `chief-strategy-officer` (CSO) — roadmap, methodology direction, scope, market expansion
- `chief-engineering-officer` (CEng) — build quality, gate enforcement, ship/no-ship on technical merit
- `chief-operations-officer` (COO) — cost envelope, data rate limits, infra reliability

### Domain specialists (13)

- `mlb-architect` — schemas, cross-service contracts, ADRs (design artifacts, not code)
- `mlb-data-engineer` — ingestion pipelines, cron schedules, Upstash cache (Odds API, MLB Stats, Statcast, weather)
- `mlb-research` — methodology survey, literature watch, experiment proposals; carrier of the agnostic mandate
- `mlb-feature-eng` — pre-game feature construction, leakage prevention, snapshot-pinned joins, training/serving parity
- `mlb-model` — methodology-agnostic train + serve, artifact lifecycle, retrain cadence, train/serve contract
- `mlb-calibrator` — calibration method selection per market, reliability audits, refusal-to-ship on poor calibration
- `mlb-backtester` — holdout discipline, ROI/CLV computation, EV-threshold sweeps, look-ahead detection
- `mlb-rationale` — LLM rationale generation with grounding, architecture-keyword scrub, programmatic RG disclaimer
- `mlb-backend` — Next.js API routes (Vercel Fluid Compute), Supabase migrations + RLS, Stripe, Auth
- `mlb-frontend` — Next.js UI: slate, pick detail, dashboards, subscription flow
- `mlb-devops` — runtime config, CI/CD, secrets, monitoring, cost dashboard, DNS/SSL
- `mlb-compliance` — state legality matrix, disclaimers, ToS, privacy, responsible gambling
- `mlb-qa` — E2E tests, pick-pipeline validation, regression checks, staging gate

The 6 ML/analysis specialists (`mlb-research`, `mlb-feature-eng`, `mlb-model`, `mlb-calibrator`, `mlb-backtester`, `mlb-rationale`) replace the prior 2-agent shape (`mlb-ml-engineer` + `mlb-ai-reasoning`). The split is intentional: each carries deep current context for one substack and proposes within it. Lens-holders synthesize across them.

### Two improvement pipelines (layered on top of the domain agents — adopted 2026-04-24)

**System-improvement pipeline** (codebase / infra / UX): `researcher → scope-gate → implementer → tester → publisher`, with `debugger` on tester FAIL, plus `skill-writer`.

- `researcher` — audits the repo + external research; returns ≤10 prioritized proposals
- `scope-gate` — binary APPROVED/DENIED against locked stack + budget + compliance. Distinct from `mlb-architect` (design); scope-gate applies fixed rules
- `implementer` — writes the diff; may delegate to `mlb-*` specialists
- `tester` — lightweight static + dynamic + edge-case gate; escalates to `mlb-qa` for heavyweight E2E
- `debugger` — root-cause on FAIL; distinct from `/investigate-pick` (single pick)
- `publisher` — commit recipe + secret guard; push per Kyle's standing authorization (2026-04-24)
- `skill-writer` — produces new skills

Skills: `research-improvement`, `scope-gate-review`, `implement-change`, `test-change`, `publish-change`, `debug`.

**Pick-improvement pipeline** (model / ROI / calibration / rationale): `pick-researcher → pick-scope-gate → pick-implementer → pick-tester → pick-publisher`, with `pick-debugger` on FAIL.

- `pick-researcher` — audits ROI, calibration, feature coverage, rationale quality, threshold sensitivity via existing diagnostic skills; returns ≤10 evidence-backed proposals
- `pick-scope-gate` — binary gate against locked pick constraints (EV/tier floors, sample-size minimums, feature-leakage rules, rationale grounding, ROI non-degradation). Distinct from `mlb-ml-engineer` (design)
- `pick-implementer` — writes model/feature/prompt/threshold diff; delegates to `mlb-model` / `mlb-feature-eng` / `mlb-calibrator` / `mlb-rationale` / `mlb-backend` / `mlb-data-engineer`
- `pick-tester` — EMPIRICAL gate: backtest (ROI ≥ −0.5%, CLV ≥ −0.1%, ECE ≤ +0.02), calibration check, rationale eval. Invokes `mlb-backtester` and `mlb-calibrator` for the deep checks. Two additional gates — feature coverage (`/check-feature-gap`) and pipeline anomaly scan (`/pipeline-anomaly-scan`) — are planned but not yet written; they enter the required list as `kind: skill` proposals once the first picks are flowing.
- `pick-debugger` — root-cause on pick-quality FAIL; uses `/investigate-pick` / `/explain` for drills (those skills land as proposals when first picks flow)
- `pick-publisher` — commit + push recipe with model-artifact size guard; deploy remains user-invoked (`vercel:deploy prod`)

Skills: `pick-research`, `pick-scope-gate-review`, `pick-implement`, `pick-test`, `pick-publish`, `pick-debug`. Plus `calibration-check` (per-tier reliability + ECE vs backtest) and `rationale-eval` (factuality + disclaimer + architecture-keyword audit).

All pipeline agents live in `.claude/agents/`; skills in `.claude/skills/<name>/SKILL.md`.

### Pipeline auto-chain rule (locked 2026-04-28; tightened 2026-04-30)

When a pipeline stage completes successfully, **auto-invoke the next stage**. Do not stop and ask the user "want me to kick off the next stage?" — that adds friction without adding decision value, since the next stage is deterministic from the pipeline definition.

- `research → scope-gate`: as soon as the research doc is written, invoke `scope-gate-review` (or `pick-scope-gate-review`) on it.
- `scope-gate → implement`: if any proposal is APPROVED, invoke `implement-change` (or `pick-implement`) immediately on the approved set.
- `implement → test`: as soon as the implementer hands off, invoke `test-change` (or `pick-test`).
- `test → publish` (PASS): on PASS, invoke `publish-change` (or `pick-publish`).
- `test → debug` (FAIL): on FAIL, invoke `debug` (or `pick-debug`); after fix, re-test.
- **Cold-start lane:** when a v0 proposal is approved-with-conditions by all three lens-holders, auto-dispatch the named specialists (`mlb-data-engineer` → `mlb-feature-eng` → `mlb-model` → `mlb-calibrator` → `mlb-backtester`) per the proposal's `specialist_routing`. Bundled report goes to CEng for v0 sign-off without a stop-and-ask in between. Open questions surfaced by specialists (e.g., schema choice, feature-spec correction, ingester format) are routed to the relevant downstream specialist for sign-off, not to the user.
- **Lens-holder consultation auto-dispatch:** when a proposal touches a lens-holder's locked criteria — or when a revised proposal needs re-circulation after material findings — invoke CSO + CEng + COO in parallel without asking the user first. The user enters only on disagreement.
- **Cross-specialist coordination questions** (e.g., "the architect's view assumes X, but mlb-feature-eng's spec says Y") get routed between specialists directly without a stop-and-ask. The user enters only when no specialist owns the call.

**Pause points** (the ONLY places the chain stops for user approval):
1. **Lens-holder disagreement.** Two-vs-one or three-way split with no clean veto → escalate per the disagreement protocol.
2. **All proposals DENIED at scope-gate** (no approved work to implement).
3. **Tester returns FAIL twice on the same change** (escalate to user, don't loop forever).
4. **Pre-deploy invocation.** `vercel:deploy prod` is user-invoked.
5. **Paid-spend approval** that would breach a sub-budget or that the user previously declined. Re-asking is allowed when the cost picture changes; second-guessing the user's prior "no" without a change in cost is not.
6. **Compliance weakening.** Any change that touches the 21+ gate, geo-block, or RG disclaimer surfaces.
7. **Production data mutation.** Migrations against live rows, real-subscriber row writes, force-push to `main`.
8. **User explicitly requests pause** mid-pipeline.

**Things that are NOT pause points** (do NOT ask the user — just do it):
- Kicking off the next pipeline stage when the current stage completed cleanly.
- Re-circulating a revised proposal to lens-holders after material findings.
- Dispatching specialists for design/audit work that costs nothing (no paid API calls, no production mutations).
- Asking specialists to resolve cross-specialist coordination questions.
- Choosing between two near-equivalent design options where the lens-holders haven't disagreed.

This rule applies to BOTH the system-improvement pipeline and the pick-improvement pipeline, and to the cold-start lane.

## Three-Lens Governance (added 2026-04-30)

The orchestrator routes; the scope-gates apply rules; **the lens-holders own judgment** for calls that exceed mechanical rule-checking. Three lens-holders sit alongside the pipelines — not above the orchestrator, not replacing the gates, but enriching both with explicit category-of-judgment ownership.

| Lens-holder | Owns | Vetoes |
|---|---|---|
| **`chief-strategy-officer`** (CSO) | Roadmap, methodology direction, scope decisions, market expansion, product surface direction | Proposals that drift from v1 goal or success criteria; methodology shifts not justified by comparison evidence |
| **`chief-engineering-officer`** (CEng) | Build quality, gate enforcement, calibration / CLV / ROI invariants, ship/no-ship on technical merit | Proposals that fail empirical gates (`pick-tester`), backtest discipline, or calibration spec |
| **`chief-operations-officer`** (COO) | Cost envelope, data rate limits, infra reliability, cron health, scope-of-budget | Proposals that breach a sub-budget, hit rate limits, or compromise pipeline reliability |

The Chief Executive is **the user (Kyle)**. There is no `chief-executive` agent. Escalations to the Chief Executive surface as questions to the user.

### When the lens-holders are invoked

1. **Inside the pipeline.** `scope-gate` and `pick-scope-gate` consult the relevant lens-holder when a proposal touches that lens's locked criteria *and* the call is judgment-shaped (not pure rule-application). Pure rule violations get DENIED at the gate without lens-holder consultation.
2. **Direct invocation by the user.** "Should we add props to scope?" is a CSO call. "Is the budget headroom enough to add a paid Stuff+ feed?" is a COO call. "Is the new totals model actually better than the current one?" is a CEng call.
3. **Cross-lens decisions.** Stack changes, methodology shifts, scope expansion to a new market, anything that crosses category boundaries — CSO + CEng + COO consensus required.
4. **Specialist self-direction bypass.** Routine, reversible, in-substack work does NOT require lens-holder review. Specialists self-direct; the orchestrator logs.

### Disagreement protocol

- All three lens-holders agree → ship.
- One lens-holder vetoes inside their lens (e.g., COO says cost breach) → does not ship; vetoing lens-holder writes a one-paragraph rationale.
- Two-vs-one or three-way split with no clean veto → **escalate to the user**, with options + a recommendation per the orchestrator's escalation pattern. Do not let one AI authority override another. The escalation itself is the signal that the call needs the user's judgment.

The lens-holders are well-read across their domain but **are not the deepest expert in any single sub-area**. Specialists hold depth; lens-holders hold synthesis and authority.

## Proposal Schema (added 2026-04-30)

`scope-gate`, `pick-scope-gate`, and the lens-holders consume proposals in this shape. Free-form pitches get rejected for shape, not merit. `researcher` and `pick-researcher` produce in this shape.

```yaml
proposal_id: <short-slug-yyyy-mm-dd>
proposer: <agent-name>
kind: <model-change | feature-change | calibration | rationale | skill | infra | scope-expansion | compliance | other>
lens: <CSO | CEng | COO | cross-lens>
claim: <one sentence — what should change>
evidence:
  - <backtest result, sample size, metric delta vs current>
  - <calibration audit result if model-touching>
  - <cost / latency / rate-limit impact if relevant>
comparison:
  - approach_a: <current production>
  - approach_b: <proposed>
  - delta_metrics: <ROI, CLV, ECE, log-loss, sample n — or "n/a" for skill/infra proposals>
risks:
  - <what could go wrong>
  - <how it would be detected>
rollback:
  - <exact steps to revert>
  - <max time-to-detect for regression>
scope:
  - markets_affected: [moneyline, run_line, totals, props, parlays, futures]
  - user_facing: <yes | no>
  - irreversible: <yes | no>
attachments:
  - <e.g., draft SKILL.md path for kind: skill; backtest report path for kind: model-change>
```

**`kind` controls which scope-gate criteria apply.** A `kind: skill` proposal does not need backtest evidence; it needs a draft SKILL.md attachment, a naming-collision check, and a routing-friendly description. A `kind: model-change` proposal needs the full empirical evidence stack. The scope-gate skills route per-kind.

Lens-holder verdicts respond in this shape:

```yaml
proposal_id: <same>
verdict: <approve | approve-with-conditions | reject | escalate>
lens: <which lens reviewed>
reasoning: <one paragraph>
conditions: <if approve-with-conditions>
escalation_target: <if escalate, name another lens-holder or "user">
```

Both proposals and verdicts persist to `docs/proposals/` for the audit trail.

## User

Kyle Rauch (kyle.g.rauch@gmail.com) — founder, product owner, likely primary engineer. Prefers skimmable output (headers, bullets, no prose walls). On escalation, always bring **options + a recommendation**, never an open question. Senior-level technical collaborator; no need to explain basic concepts.

## Session Conventions

- **Task briefs** live in `docs/briefs/` once that folder is scaffolded by the architect.
- **ADRs** live in `docs/adr/`. One ADR per material decision.
- **Project state** and **decision log** are maintained in the orchestrator's agent memory at `.claude/agent-memory/mlb-picks-orchestrator/`.
