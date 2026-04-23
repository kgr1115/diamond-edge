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

- `mlb-architect` — system design, data models, API contracts, ADRs
- `mlb-data-engineer` — MLB Stats API, Statcast, The Odds API, caching, rate limits
- `mlb-ml-engineer` — features, win-probability/EV model, backtesting, calibration
- `mlb-ai-reasoning` — LLM prompt design, rationale generation, grounding, cost
- `mlb-backend` — Supabase schema, API routes, Stripe, background jobs
- `mlb-frontend` — Next.js UI: slate, pick detail, dashboards, subscription flow
- `mlb-devops` — Vercel/Supabase/Upstash infra, CI/CD, monitoring, cost dashboards
- `mlb-compliance` — state legality matrix, disclaimers, ToS, privacy, responsible gambling
- `mlb-qa` — E2E tests, pick-pipeline validation, regression checks, staging gate

## User

Kyle Rauch (kyle.g.rauch@gmail.com) — founder, product owner, likely primary engineer. Prefers skimmable output (headers, bullets, no prose walls). On escalation, always bring **options + a recommendation**, never an open question. Senior-level technical collaborator; no need to explain basic concepts.

## Session Conventions

- **Task briefs** live in `docs/briefs/` once that folder is scaffolded by the architect.
- **ADRs** live in `docs/adr/`. One ADR per material decision.
- **Project state** and **decision log** are maintained in the orchestrator's agent memory at `.claude/agent-memory/mlb-picks-orchestrator/`.
