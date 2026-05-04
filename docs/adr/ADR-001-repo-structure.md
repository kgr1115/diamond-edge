# ADR-001 â€” Repository Folder Structure

**Status:** Accepted
**Date:** 2026-04-22
**Author:** mlb-architect

---

## Objective

Define the top-level folder structure that all agents build against, so module boundaries are clear and there is no ambiguity about where code lives.

## Context

- Single Next.js 15 App Router application hosted on Vercel (no separate API server â€” API routes live inside the Next.js app).
- Background jobs: Vercel Cron (light) + Supabase Edge Functions (heavier). ML inference may run on a separate Fly.io worker.
- Supabase manages Postgres, Auth, Storage, and Edge Functions. Migrations are SQL files tracked in the repo.
- ML models are Python-based, potentially deployed separately on Fly.io. They are developed in this repo and deployed as a separate artifact.
- Budget envelope enforces a minimal surface area â€” no polyrepo overhead, no separate service for things Vercel/Supabase can handle.
- This is not a monorepo with multiple publishable packages. It is a single product repo with one deployable Next.js app, one deployable Fly.io worker, and Supabase configuration.

## Decision â€” Folder Structure

```
diamond-edge/
â”œâ”€â”€ CLAUDE.md                          # Locked decisions â€” all agents read this
â”œâ”€â”€ .claude/
â”‚   â”œâ”€â”€ agents/                        # Specialist agent definitions
â”‚   â””â”€â”€ agent-memory/                  # Orchestrator persistent memory
â”‚
â”œâ”€â”€ apps/
â”‚   â””â”€â”€ web/                           # Next.js 15 App Router application
â”‚       â”œâ”€â”€ app/                       # App Router pages and layouts
â”‚       â”‚   â”œâ”€â”€ (auth)/                # Auth group: login, signup, age-gate
â”‚       â”‚   â”œâ”€â”€ (marketing)/           # Public pages: home, pricing, about
â”‚       â”‚   â”œâ”€â”€ (app)/                 # Protected app: picks, bankroll, stats
â”‚       â”‚   â”‚   â”œâ”€â”€ picks/
â”‚       â”‚   â”‚   â”œâ”€â”€ games/
â”‚       â”‚   â”‚   â”œâ”€â”€ stats/
â”‚       â”‚   â”‚   â”œâ”€â”€ bankroll/
â”‚       â”‚   â”‚   â””â”€â”€ history/
â”‚       â”‚   â””â”€â”€ api/                   # Next.js API routes
â”‚       â”‚       â”œâ”€â”€ picks/
â”‚       â”‚       â”œâ”€â”€ games/
â”‚       â”‚       â”œâ”€â”€ odds/
â”‚       â”‚       â”œâ”€â”€ stats/
â”‚       â”‚       â”œâ”€â”€ bankroll/
â”‚       â”‚       â”œâ”€â”€ history/
â”‚       â”‚       â”œâ”€â”€ auth/
â”‚       â”‚       â””â”€â”€ webhooks/
â”‚       â”œâ”€â”€ components/                # Shared React components
â”‚       â”‚   â”œâ”€â”€ ui/                    # shadcn/ui primitives (auto-generated)
â”‚       â”‚   â”œâ”€â”€ picks/                 # Pick-specific components
â”‚       â”‚   â”œâ”€â”€ bankroll/              # Bankroll dashboard components
â”‚       â”‚   â”œâ”€â”€ stats/                 # Stats display components
â”‚       â”‚   â””â”€â”€ layout/               # Header, footer, nav, geo-gate
â”‚       â”œâ”€â”€ lib/                       # Shared utilities, clients, types
â”‚       â”‚   â”œâ”€â”€ supabase/              # Supabase client (server + browser)
â”‚       â”‚   â”œâ”€â”€ redis/                 # Upstash Redis client + cache helpers
â”‚       â”‚   â”œâ”€â”€ stripe/                # Stripe client + webhook helpers
â”‚       â”‚   â”œâ”€â”€ odds/                  # The Odds API client
â”‚       â”‚   â”œâ”€â”€ mlb/                   # MLB Stats API client
â”‚       â”‚   â”œâ”€â”€ statcast/              # Baseball Savant scraper client
â”‚       â”‚   â”œâ”€â”€ geo/                   # Geo-blocking utilities
â”‚       â”‚   â””â”€â”€ types/                 # Shared TypeScript types (DB rows, API shapes)
â”‚       â”œâ”€â”€ public/                    # Static assets
â”‚       â”œâ”€â”€ next.config.ts
â”‚       â”œâ”€â”€ tailwind.config.ts
â”‚       â””â”€â”€ package.json
â”‚
â”œâ”€â”€ worker/                            # Fly.io Python worker (ML inference + heavy LLM)
â”‚   â”œâ”€â”€ models/                        # Statistical model code
â”‚   â”‚   â”œâ”€â”€ moneyline/
â”‚   â”‚   â”œâ”€â”€ run_line/
â”‚   â”‚   â”œâ”€â”€ totals/
â”‚   â”‚   â””â”€â”€ props/
â”‚   â”œâ”€â”€ ingestion/                     # Heavy ingestion jobs (Statcast batch pulls)
â”‚   â”‚   â”œâ”€â”€ statcast/
â”‚   â”‚   â””â”€â”€ mlb_stats/
â”‚   â”œâ”€â”€ reasoning/                     # LLM rationale generation (Anthropic SDK)
â”‚   â”œâ”€â”€ jobs/                          # Job entrypoints (called by Supabase Edge or cron)
â”‚   â”œâ”€â”€ requirements.txt
â”‚   â”œâ”€â”€ Dockerfile
â”‚   â””â”€â”€ fly.toml
â”‚
â”œâ”€â”€ supabase/
â”‚   â”œâ”€â”€ migrations/                    # SQL migration files (numbered, sequential)
â”‚   â”œâ”€â”€ functions/                     # Supabase Edge Functions (TypeScript/Deno)
â”‚   â”‚   â”œâ”€â”€ pick-pipeline/             # Orchestrates ML â†’ rationale â†’ DB write
â”‚   â”‚   â”œâ”€â”€ odds-refresh/              # Pulls fresh odds from The Odds API
â”‚   â”‚   â””â”€â”€ outcome-grader/            # Grades pick outcomes after games complete
â”‚   â””â”€â”€ seed.sql                       # Dev/test seed data
â”‚
â”œâ”€â”€ docs/
â”‚   â”œâ”€â”€ adr/                           # Architecture Decision Records
â”‚   â”œâ”€â”€ schema/                        # Schema specs (source for migrations)
â”‚   â”œâ”€â”€ api/                           # API contracts
â”‚   â”œâ”€â”€ compliance/                    # Legal/compliance artifacts
â”‚   â””â”€â”€ briefs/                        # Orchestrator task briefs (archived)
â”‚
â”œâ”€â”€ .github/
â”‚   â””â”€â”€ workflows/                     # CI/CD (lint, type-check, test, deploy)
â”‚
â”œâ”€â”€ package.json                       # Root: workspace scripts only (no dependencies)
â””â”€â”€ .gitignore
```

## Key Boundary Decisions

| Concern | Where it lives | Why |
|---|---|---|
| API routes | `apps/web/app/api/` | Co-located with Next.js, no separate Express server |
| Light cron jobs | Vercel Cron + `apps/web/app/api/cron/` | Fits within 10s/60s, no extra infra |
| Heavy jobs (ML inference, LLM, batch Statcast) | `worker/` deployed on Fly.io | Exceeds Vercel timeout; Python for ML |
| Edge Functions | `supabase/functions/` | Deno, ~50ms cold start, 150s limit â€” pick pipeline orchestration |
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
- Non-Python ML (the worker is Python; if TypeScript inference is sufficient, it could move to Edge Functions â€” but default assumption is Python for ML ecosystem access).

## Open Questions for Orchestrator

1. **Fly.io worker scope:** If the ML model is simple enough (logistic regression, no heavy dependencies), inference could run in a Supabase Edge Function and eliminate Fly.io entirely for v1. ML agent should evaluate and confirm. Fly.io adds ~$5-10/mo minimum. Recommend ML agent assess before DevOps provisions it.
2. **Monorepo tooling:** No monorepo tooling (Turborepo, nx) is proposed â€” the single `apps/web` + `worker/` split doesn't warrant it. If a second app is added in v1.1, reconsider. No action needed now.
3. **TypeScript path aliases:** `apps/web/lib/types/` must be aliased as `@/lib/types` in `next.config.ts` â€” backend agent sets this up when scaffolding.
