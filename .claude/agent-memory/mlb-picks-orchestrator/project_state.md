---
name: Project State — Live
description: Current backlog, in-progress work, blockers, critical path, and open questions
type: project
---

Last updated: 2026-04-22 (Phase 2 tasks spawned — session 3)

## Status: Phase 2 active. Four agents running in parallel.

## Done

- 8 kickoff Q&A decisions locked
- Memory system initialized
- CLAUDE.md written (project source of truth)
- 9 specialist agent definitions created (.claude/agents/)
- Git repo initialized at C:\Projects\Baseball_Edge (commit d3255d2)
- Phase 0 artifacts committed (commit 285091e): architecture, schema, API contracts, compliance
- Phase 1 COMPLETE (commit d17d720, 84 files):
  - TASK-001 (Architect): ADR-001, schema-v1.md, api-contracts-v1.md, caching-strategy.md, ml-output-contract.md
  - TASK-002 (Compliance): state-matrix.md (25 ALLOW states), geo-block-spec.md, responsible-gambling.md, age-gate-spec.md, launch-checklist.md
  - TASK-003 (Backend): Next.js 15 scaffold, 7 Supabase migrations, middleware, age-gate route, picks/today route, Stripe webhook route, Redis cache lib, TypeScript types
  - TASK-004 (Data Engineer): Odds API client/transform/poll, MLB Stats API (schedule/rosters/box-scores), Open-Meteo weather, cron handlers, rate-limit budget
  - TASK-005 (ML Engineer): Feature specs (moneyline/run-line/totals), backtest harness, calibration spec, Fly.io runtime decision, PickCandidate Python schema
  - TASK-006 (DevOps): vercel.json (4 crons), GitHub Actions CI + migrations workflows, fly.toml, 3 runbooks, cost projection, secrets manifest
- 5 user product decisions locked (2026-04-22):
  - Free tier: NO LLM call (side + confidence only)
  - Minimum confidence: Tier 3+ (EV > 4%), ~3-6 picks/day
  - Pricing: Free / Pro $19/mo / Elite $39/mo
  - Parlays: deferred to v1.1
  - Soft launch: UNCONFIRMED — working assumption 2026-06-03

## In Progress (Phase 2)

- TASK-007 (mlb-ai-reasoning): Prompt design, cost model, eval harness — brief at docs/briefs/TASK-007-ai-reasoning.md
- TASK-008 (mlb-frontend): Slate view, pick detail, bankroll dashboard, subscription paywall — brief at docs/briefs/TASK-008-frontend.md
- TASK-009 (mlb-backend focused): Stripe checkout + portal routes, product seeding — brief at docs/briefs/TASK-009-stripe-billing.md
- TASK-010-pre (mlb-backend + ml-engineer coordination): Pick pipeline Edge Function — brief at docs/briefs/TASK-010-pre-pick-pipeline.md

## Blocked

- USPTO trademark clearance — HARD PRE-LAUNCH BLOCKER (not a build blocker)
- LLC formation — HARD PRE-LAUNCH BLOCKER (not a build blocker)
- Attorney review of all compliance docs — HARD PRE-LAUNCH BLOCKER
- Soft launch date — UNCONFIRMED (working assumption: 2026-06-03)
- Full Statcast feature integration — Pick pipeline Phase 2 uses simplified features; full Statcast requires TASK-004 data pipeline to be fully operational with real API keys
- ML model training — No trained model artifact yet; Fly.io worker will return empty candidates until training completes (staging blocker, not a code blocker)

## Phase 3 (not yet spawned — after Phase 2 completes)

- TASK-011 (QA): E2E tests, pick pipeline validation, golden-path tests, staging gate
- TASK-012 (DevOps): Real Vercel/Supabase/Upstash/Fly projects provisioned, secrets wired, monitoring live

## Critical Path (ordered)

1. [DONE] Architect: data model, API contracts, folder structure
2. [DONE] Compliance: legal launch states (25 ALLOW states)
3. [DONE] TASK-003: Backend scaffold + Supabase migrations + auth middleware
4. [DONE] TASK-004: Data ingestion layer (odds + MLB stats)
5. [DONE] TASK-005: ML feature scope + model selection + runtime decision (Fly.io confirmed)
6. [DONE] TASK-006: DevOps provisioning + CI/CD
7. [IN PROGRESS] TASK-007 — AI Reasoning
8. [IN PROGRESS] TASK-008 — Frontend slate + pick detail + billing UI
9. [IN PROGRESS] TASK-009 — Stripe billing routes
10. [IN PROGRESS] TASK-010-pre — Pick pipeline Edge Function
11. [NEXT PHASE] TASK-011 — QA end-to-end + pick pipeline validation
12. [NEXT PHASE] TASK-012 — DevOps: real infra provisioned
13. Launch — after attorney review, trademark clearance, LLC formation

## Open Questions for User (decisions needed)

1. **Soft launch date:** Working assumption is 2026-06-03 (~6 weeks from 2026-04-22). Confirm or adjust.
2. **LLC formation timing:** Forming in parallel with build? Hard blocker before first paid subscription.
3. **Trademark clearance:** USPTO check against "Diamond Edge Technology LLC" — status unknown. Must complete before launch.
4. **Marketing plan:** No marketing strategy defined yet. Not a build blocker but a launch blocker.

## Key Architecture / Product Decisions (locked)

- Repo structure: single Next.js app + separate Fly.io Python worker + Supabase functions
- ALLOW states: 25 jurisdictions (24 states + DC) where both DK + FD operate
- Geo-blocking: Vercel Edge Middleware IP geo (primary) + profiles.geo_blocked (secondary)
- Age gate: DOB entry, server-side verification, full DOB stored for audit, no retry on failure
- Responsible gambling: 5 copy surfaces, 1-800-522-4700 national line + state-specific injection
- Caching: 7 Redis resources with TTLs from 10 min (odds) to 3 hours (player stats)
- Parlays: deferred to v1.1
- ML/AI seam: PickCandidate contract defined; Fly.io worker produces it; Edge Function consumes
- Tier gating: enforced in API route handlers (column masking), not via RLS (row visibility only)
- Free tier: NO LLM call — side + confidence only
- Minimum confidence: Tier 3+ (EV > 4%), ~3-6 picks/day published
- Pricing: Free (no card) / Pro $19/mo / Elite $39/mo
- Required tier mapping: confidence_tier >= 5 → elite; confidence_tier 3-4 → pro; below 3 → not published
- Rationale tier routing: Haiku 4.5 for Pro, Sonnet 4.6 for Elite (locked, from kickoff decision #8)
- Pick pipeline: Supabase Edge Function orchestrates; Fly.io worker does ML inference + rationale proxy
