# ADR-001 — Repository Folder Structure

**Status:** Accepted
**Date:** 2026-04-22
**Author:** mlb-architect

---

## Objective

Define the top-level folder structure that all agents build against, so module boundaries are clear and there is no ambiguity about where code lives.

## Context

- Single Next.js 15 App Router application hosted on Vercel (no separate API server — API routes live inside the Next.js app).
- Background jobs: Vercel Cron (light) + Supabase Edge Functions (heavier). ML inference may run on a separate Fly.io worker.
- Supabase manages Postgres, Auth, Storage, and Edge Functions. Migrations are SQL files tracked in the repo.
- ML models are Python-based, potentially deployed separately on Fly.io. They are developed in this repo and deployed as a separate artifact.
- Budget envelope enforces a minimal surface area — no polyrepo overhead, no separate service for things Vercel/Supabase can handle.
- This is not a monorepo with multiple publishable packages. It is a single product repo with one deployable Next.js app, one deployable Fly.io worker, and Supabase configuration.

## Decision — Folder Structure

```
Baseball_Edge/
├── CLAUDE.md                          # Locked decisions — all agents read this
├── .claude/
│   ├── agents/                        # Specialist agent definitions
│   └── agent-memory/                  # Orchestrator persistent memory
│
├── apps/
│   └── web/                           # Next.js 15 App Router application
│       ├── app/                       # App Router pages and layouts
│       │   ├── (auth)/                # Auth group: login, signup, age-gate
│       │   ├── (marketing)/           # Public pages: home, pricing, about
│       │   ├── (app)/                 # Protected app: picks, bankroll, stats
│       │   │   ├── picks/
│       │   │   ├── games/
│       │   │   ├── stats/
│       │   │   ├── bankroll/
│       │   │   └── history/
│       │   └── api/                   # Next.js API routes
│       │       ├── picks/
│       │       ├── games/
│       │       ├── odds/
│       │       ├── stats/
│       │       ├── bankroll/
│       │       ├── history/
│       │       ├── auth/
│       │       └── webhooks/
│       ├── components/                # Shared React components
│       │   ├── ui/                    # shadcn/ui primitives (auto-generated)
│       │   ├── picks/                 # Pick-specific components
│       │   ├── bankroll/              # Bankroll dashboard components
│       │   ├── stats/                 # Stats display components
│       │   └── layout/               # Header, footer, nav, geo-gate
│       ├── lib/                       # Shared utilities, clients, types
│       │   ├── supabase/              # Supabase client (server + browser)
│       │   ├── redis/                 # Upstash Redis client + cache helpers
│       │   ├── stripe/                # Stripe client + webhook helpers
│       │   ├── odds/                  # The Odds API client
│       │   ├── mlb/                   # MLB Stats API client
│       │   ├── statcast/              # Baseball Savant scraper client
│       │   ├── geo/                   # Geo-blocking utilities
│       │   └── types/                 # Shared TypeScript types (DB rows, API shapes)
│       ├── public/                    # Static assets
│       ├── next.config.ts
│       ├── tailwind.config.ts
│       └── package.json
│
├── worker/                            # Fly.io Python worker (ML inference + heavy LLM)
│   ├── models/                        # Statistical model code
│   │   ├── moneyline/
│   │   ├── run_line/
│   │   ├── totals/
│   │   └── props/
│   ├── ingestion/                     # Heavy ingestion jobs (Statcast batch pulls)
│   │   ├── statcast/
│   │   └── mlb_stats/
│   ├── reasoning/                     # LLM rationale generation (Anthropic SDK)
│   ├── jobs/                          # Job entrypoints (called by Supabase Edge or cron)
│   ├── requirements.txt
│   ├── Dockerfile
│   └── fly.toml
│
├── supabase/
│   ├── migrations/                    # SQL migration files (numbered, sequential)
│   ├── functions/                     # Supabase Edge Functions (TypeScript/Deno)
│   │   ├── pick-pipeline/             # Orchestrates ML → rationale → DB write
│   │   ├── odds-refresh/              # Pulls fresh odds from The Odds API
│   │   └── outcome-grader/            # Grades pick outcomes after games complete
│   └── seed.sql                       # Dev/test seed data
│
├── docs/
│   ├── adr/                           # Architecture Decision Records
│   ├── schema/                        # Schema specs (source for migrations)
│   ├── api/                           # API contracts
│   ├── compliance/                    # Legal/compliance artifacts
│   └── briefs/                        # Orchestrator task briefs (archived)
│
├── .github/
│   └── workflows/                     # CI/CD (lint, type-check, test, deploy)
│
├── package.json                       # Root: workspace scripts only (no dependencies)
└── .gitignore
```

## Key Boundary Decisions

| Concern | Where it lives | Why |
|---|---|---|
| API routes | `apps/web/app/api/` | Co-located with Next.js, no separate Express server |
| Light cron jobs | Vercel Cron + `apps/web/app/api/cron/` | Fits within 10s/60s, no extra infra |
| Heavy jobs (ML inference, LLM, batch Statcast) | `worker/` deployed on Fly.io | Exceeds Vercel timeout; Python for ML |
| Edge Functions | `supabase/functions/` | Deno, ~50ms cold start, 150s limit — pick pipeline orchestration |
| Supabase migrations | `supabase/migrations/` | SQL source of truth; backend agent writes these |
| Shared types | `apps/web/lib/types/` | Single source of typed DB rows and API shapes |
| shadcn/ui components | `apps/web/components/ui/` | Auto-generated by shadcn CLI; do not hand-edit |

## Consequences

**Enables:**
- All agents have unambiguous paths for their deliverables.
- Fly.io worker can be developed and deployed independently of Vercel.
- Supabase functions own the stateful pick pipeline without hitting Vercel timeouts.
- Adding a second app (e.g., mobile API in future) is an `apps/mobile-api/` addition with no structural change.

**Closes off:**
- Separate microservices per concern (unnecessary overhead at <500 users).
- Non-Python ML (the worker is Python; if TypeScript inference is sufficient, it could move to Edge Functions — but default assumption is Python for ML ecosystem access).

## Open Questions for Orchestrator

1. **Fly.io worker scope:** If the ML model is simple enough (logistic regression, no heavy dependencies), inference could run in a Supabase Edge Function and eliminate Fly.io entirely for v1. ML agent should evaluate and confirm. Fly.io adds ~$5-10/mo minimum. Recommend ML agent assess before DevOps provisions it.
2. **Monorepo tooling:** No monorepo tooling (Turborepo, nx) is proposed — the single `apps/web` + `worker/` split doesn't warrant it. If a second app is added in v1.1, reconsider. No action needed now.
3. **TypeScript path aliases:** `apps/web/lib/types/` must be aliased as `@/lib/types` in `next.config.ts` — backend agent sets this up when scaffolding.
