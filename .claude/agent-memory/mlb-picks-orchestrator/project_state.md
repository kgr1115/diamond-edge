---
name: Project State — Live
description: Current backlog, in-progress work, blockers, critical path, and open questions
type: project
---

Last updated: 2026-04-22 (Phase 1 agents actively spawned — session 2)

## Status: Phase 1 active. Four agents running in parallel. User confirmed all 5 product decisions ("go with the recommendations").

## Done

- 8 kickoff Q&A decisions locked
- Memory system initialized
- CLAUDE.md written (project source of truth)
- 9 specialist agent definitions created (.claude/agents/)
- Git repo initialized at C:\Projects\Baseball_Edge (commit d3255d2)
- TASK-001 (Architect) COMPLETE:
  - ADR-001: repo folder structure (Next.js + Fly.io worker + Supabase)
  - docs/schema/schema-v1.md: 11-table Postgres schema with full RLS policies
  - docs/api/api-contracts-v1.md: 13 typed API routes
  - docs/schema/caching-strategy.md: 7 Redis resources with justified TTLs
  - docs/api/ml-output-contract.md: PickCandidate schema + pipeline seam
- TASK-002 (Compliance) COMPLETE:
  - docs/compliance/state-matrix.md: 51-state DK+FD matrix; 25 ALLOW jurisdictions
  - docs/compliance/geo-block-spec.md: IP geo strategy, frontend+backend handoff
  - docs/compliance/copy/responsible-gambling.md: 5 surfaces, real NCPG resources
  - docs/compliance/age-gate-spec.md: DOB flow, failure behavior, audit log
  - docs/compliance/launch-checklist.md: 9-category pre-launch checklist, all attorney items
- 5 user product decisions locked (2026-04-22):
  - Free tier: NO LLM call (side + confidence only)
  - Minimum confidence: Tier 3+ (EV > 4%), ~3-6 picks/day
  - Pricing: Free / Pro $19/mo / Elite $39/mo
  - Parlays: deferred to v1.1
  - Soft launch: UNCONFIRMED — working assumption 2026-06-03

## In Progress

- TASK-003 (mlb-backend): Scaffold Next.js 15 app, Supabase migrations, auth + age-gate + geo-block middleware
- TASK-004 (mlb-data-engineer): The Odds API integration design, MLB Stats API ingestion, caching layer
- TASK-005 (mlb-ml-engineer): Feature engineering scope, model selection (ML/totals/run-line), inference runtime decision
- TASK-006 (mlb-devops): Provision Vercel + Supabase + Upstash, CI/CD skeleton, secrets management

## Blocked

- USPTO trademark clearance — HARD PRE-LAUNCH BLOCKER (not a build blocker)
- LLC formation — HARD PRE-LAUNCH BLOCKER (not a build blocker)
- Attorney review of all compliance docs — HARD PRE-LAUNCH BLOCKER
- Soft launch date — UNCONFIRMED (working assumption: 2026-06-03)
- Fly.io worker vs. Edge Function for ML inference — TASK-005 must resolve this (unblocks TASK-006)

## Critical Path (ordered)

1. [DONE] Architect: data model, API contracts, folder structure
2. [DONE] Compliance: legal launch states (25 ALLOW states)
3. [IN PROGRESS] TASK-003: Backend scaffold + Supabase migrations + auth middleware
4. [IN PROGRESS] TASK-004: Data ingestion layer (odds + MLB stats)
5. [IN PROGRESS] TASK-005: ML feature scope + model selection + runtime decision
6. [IN PROGRESS] TASK-006: DevOps provisioning + CI/CD
7. NEXT (Phase 2): TASK-007 — AI Reasoning (reads TASK-005 output + ml-output-contract.md)
8. NEXT (Phase 2): TASK-008 — Frontend slate view + pick detail + subscription flow (reads TASK-003 routes)
9. NEXT (Phase 2): TASK-009 — Stripe billing integration (reads pricing decisions + TASK-003 backend)
10. Final: TASK-010 — QA end-to-end + pick pipeline validation
11. Launch — after attorney review, trademark clearance, LLC formation

## Phase 2 Dependencies (not yet delegated)

- TASK-007 (AI Reasoning): needs TASK-005 complete (inference runtime locked)
- TASK-008 (Frontend): needs TASK-003 complete (API routes stable)
- TASK-009 (Stripe billing): needs TASK-003 complete (auth + profiles table stable); pricing confirmed
- TASK-010 (QA): needs TASK-003 + TASK-004 + TASK-005 + TASK-007 + TASK-008 + TASK-009

## Open Questions for User (decisions needed)

1. **Soft launch date:** Working assumption is 2026-06-03 (~6 weeks). Confirm or adjust — guides sprint pressure.
2. **LLC formation timing:** Is Kyle forming it now in parallel with build? Hard blocker before first paid subscription.

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
