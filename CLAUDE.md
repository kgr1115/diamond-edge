# Diamond Edge — MLB Picks SaaS

This is the source of truth every agent in this project reads. Locked decisions below are non-negotiable unless explicitly reopened by the user (kyle.g.rauch@gmail.com) or the orchestrator.

## Product (v1)

A paid, web-only MLB betting picks SaaS with tiered subscriptions. Users get statistically-grounded, AI-explained picks across moneyline, run line, totals, props, parlays, and futures. Transparent historical pick performance, bankroll tracking, stats deep-dives.

**Non-goals v1:** placing bets, holding user funds, non-MLB sports, native mobile apps.

## Locked Stack (2026-04-22)

| Layer | Choice | Notes |
|---|---|---|
| Frontend framework | Next.js 15 (App Router) + TypeScript | Server Components for fast initial paint |
| Styling | Tailwind CSS + shadcn/ui | Clean defaults, minimal component-library lock-in |
| Hosting (web + API) | Vercel | 10s/60s function timeouts — long jobs offload |
| Database + Auth + Storage | Supabase (Postgres, RLS) | Supabase Auth (email + OAuth) |
| Cache | Upstash Redis | Aggressive caching for odds data |
| Background jobs | Vercel Cron (light) + Supabase Edge Functions (>10s) | Fly.io worker as overflow for ML/LLM |
| Billing | Stripe | Subscriptions + webhooks |
| Odds data | The Odds API ($59/mo 100K-credit tier as of 2026-04) | Tiers: $30 (20K) / $59 (100K) / $119 (5M). Cached pulls, no real-time polling |
| MLB stats | MLB Stats API (free, public) | Authoritative for schedules, rosters, box scores |
| Statcast | Baseball Savant | Free, scrape-friendly pitch/batted-ball data |
| LLM | Anthropic Claude only | Haiku 4.5 default, Sonnet 4.6 for premium picks |

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

## Engineering Principles

- **Ship over polish.** v1 must be launchable. Polish is v1.1+.
- **Extensibility without over-engineering.** Data models and API shapes should survive adding a 3rd sportsbook or a new market without schema churn, but don't design for hypothetical 2028 use cases.
- **No half-finished implementations.** If a feature isn't complete behind its flag, it doesn't merge.
- **No premature abstractions.** Three similar lines beats a speculative helper.
- **No comments explaining *what*.** Identifier names do that. Comments only for non-obvious *why*.
- **Fail at the boundary.** Validate user input and external API responses; trust internal code.
- **Cost-aware by default.** LLM cost, odds API request count, Vercel function duration — all go in the engineering decision criteria, not just "correctness."

## Agent Roster

All specialist agents live in `.claude/agents/`. Orchestration is owned by `mlb-picks-orchestrator`. Specialists do not delegate to each other directly — they return to the orchestrator, which routes.

- `mlb-architect` — schemas, cross-service contracts, ADRs (design artifacts, not code)
- `mlb-data-engineer` — ingestion pipelines, cron schedules, Upstash cache (Odds API, MLB Stats, Statcast, weather)
- `mlb-ml-engineer` — features, win-probability/EV model, backtesting, calibration
- `mlb-ai-reasoning` — LLM prompt design, rationale generation, grounding, cost
- `mlb-backend` — Next.js API routes, Supabase migrations + RLS, Edge Functions, Stripe, Auth
- `mlb-frontend` — Next.js UI: slate, pick detail, dashboards, subscription flow
- `mlb-devops` — runtime config, CI/CD, secrets, monitoring, cost dashboard, DNS/SSL
- `mlb-compliance` — state legality matrix, disclaimers, ToS, privacy, responsible gambling
- `mlb-qa` — E2E tests, pick-pipeline validation, regression checks, staging gate

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
- `pick-implementer` — writes model/feature/prompt/threshold diff; delegates to `mlb-ml-engineer` / `mlb-ai-reasoning` / `mlb-backend` / `mlb-data-engineer`
- `pick-tester` — EMPIRICAL gate: backtest (ROI ≥ −0.5%, CLV ≥ −0.1%, ECE ≤ +0.02), feature coverage, pipeline anomaly scan, calibration check, rationale eval
- `pick-debugger` — root-cause on pick-quality FAIL; uses `/investigate-pick` / `/explain` for drills
- `pick-publisher` — commit + push recipe with model-artifact size guard; deploys remain user-invoked (`/deploy-edge`, `/deploy-worker`)

Skills: `pick-research`, `pick-scope-gate-review`, `pick-implement`, `pick-test`, `pick-publish`, `pick-debug`. Plus `calibration-check` (per-tier reliability + ECE vs backtest) and `rationale-eval` (factuality + disclaimer + architecture-keyword audit).

All pipeline agents live in `.claude/agents/`; skills in `.claude/skills/<name>/SKILL.md`.

### Pipeline auto-chain rule (locked 2026-04-28)

When a pipeline stage completes successfully, **auto-invoke the next stage**. Do not stop and ask the user "want me to kick off the next stage?" — that adds friction without adding decision value, since the next stage is deterministic from the pipeline definition.

- `research → scope-gate`: as soon as the research doc is written, invoke `scope-gate-review` (or `pick-scope-gate-review`) on it.
- `scope-gate → implement`: if any proposal is APPROVED, invoke `implement-change` (or `pick-implement`) immediately on the approved set.
- `implement → test`: as soon as the implementer hands off, invoke `test-change` (or `pick-test`).
- `test → publish` (PASS): on PASS, invoke `publish-change` (or `pick-publish`).
- `test → debug` (FAIL): on FAIL, invoke `debug` (or `pick-debug`); after fix, re-test.

**Pause points** (where the chain stops and waits for the user):
- All proposals DENIED at scope-gate (no approved work to implement).
- Tester returns FAIL twice on the same change (escalate to user, don't loop forever).
- Pre-deploy steps that require explicit user invocation per CLAUDE.md (`/deploy-edge`, `/deploy-worker`).
- User explicitly requests review / pause between stages.

This rule applies to BOTH the system-improvement pipeline and the pick-improvement pipeline.

## User

Kyle Rauch (kyle.g.rauch@gmail.com) — founder, product owner, likely primary engineer. Prefers skimmable output (headers, bullets, no prose walls). On escalation, always bring **options + a recommendation**, never an open question. Senior-level technical collaborator; no need to explain basic concepts.

## Session Conventions

- **Task briefs** live in `docs/briefs/` once that folder is scaffolded by the architect.
- **ADRs** live in `docs/adr/`. One ADR per material decision.
- **Project state** and **decision log** are maintained in the orchestrator's agent memory at `.claude/agent-memory/mlb-picks-orchestrator/`.
