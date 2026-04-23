---
name: Project State — Live
description: Current backlog, in-progress work, blockers, critical path, and open questions
type: project
---

Last updated: 2026-04-22 (TASK-011 QA complete — session 4)

## Status: Phase 2 complete. TASK-011 (QA scaffold) complete. TASK-012 (real infra provisioning) gated on user confirmation.

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
- Phase 2 COMPLETE (5 commits):
  - TASK-007 (commit 0321eb3): AI Reasoning — system/user prompts, generate-rationale, cost model ($0.85/mo projected), eval harness with 6 factuality checks. @anthropic-ai/sdk added.
  - TASK-009 (commit 014bbc5): Stripe Billing — checkout + portal routes, product seeding, tier transitions
  - TASK-008 (commit f4f8c60): Frontend — full v1 UI (slate, pick detail, bankroll, pricing, age gate, geo-block, RG copy screens)
  - Build hygiene (commit 9c7c05e): force-dynamic exports, lazy Stripe singleton, tsconfig excludes for ingestion lib
  - TASK-010-pre (commit 2628d9a): Pick Pipeline — Vercel Cron triggers + Supabase Edge Function orchestrating 7 stages (game_fetch → odds_fetch → worker_call → ev_filter → rationale_call → db_write → cache_invalidate) with runbook-aligned error handling
- 5 user product decisions locked (2026-04-22):
  - Free tier: NO LLM call (side + confidence only)
  - Minimum confidence: Tier 3+ (EV > 4%), ~3-6 picks/day
  - Pricing: Free / Pro $19/mo / Elite $39/mo
  - Parlays: deferred to v1.1
  - Soft launch: UNCONFIRMED — working assumption 2026-06-03

## In Progress

- (none — awaiting user direction on TASK-012 infra provisioning and ML model training)

## Recent Completion

- **TASK-011 QA (commit 910c6d9):** 5 Playwright E2E suites (auth/slate/pick-detail/subscription/bankroll), 3 Vitest integration suites (pipeline/ingestion/rationale), test fixtures + idempotent seed, GitHub Actions `test.yml`, staging gate checklist, flake registry. Tests scaffolded and enumerate cleanly (28 Playwright + 19 Vitest) but skip locally until `supabase start` runs.

## Blocked

- USPTO trademark clearance — HARD PRE-LAUNCH BLOCKER (not a build blocker)
- LLC formation — HARD PRE-LAUNCH BLOCKER (not a build blocker)
- Attorney review of all compliance docs — HARD PRE-LAUNCH BLOCKER
- Soft launch date — UNCONFIRMED (working assumption: 2026-06-03)
- Full Statcast feature integration — Pick pipeline Phase 2 uses simplified features; full Statcast requires TASK-004 data pipeline to be fully operational with real API keys
- ML model training — No trained model artifact yet; Fly.io worker will return empty candidates until training completes (staging blocker, not a code blocker)

## Phase 3 (not yet spawned — Phase 2 committed 2026-04-22)

- TASK-011 (QA): E2E tests (Playwright), pick pipeline validation (real ingestion → model → rationale → API → UI), golden-path tests, staging gate criteria
- TASK-012 (DevOps): Real Vercel/Supabase/Upstash/Fly projects provisioned, secrets wired, monitoring live, cost dashboard
- ML model training: Train initial models on 2021–2023 data, validate on 2024 holdout; until artifacts exist, Fly.io worker returns empty candidate arrays and pipeline writes zero picks
- Stripe product creation (live mode): seeding script exists (TASK-009); needs LLC + bank account to run against a live Stripe account

**⚠ Phase 3 touches real cloud infrastructure + money.** Do not spawn without explicit user confirmation per Auto Mode safety rules. Cost: provisioning starts the $300/mo envelope clock ticking.

## Critical Path (ordered)

1. [DONE] Architect: data model, API contracts, folder structure
2. [DONE] Compliance: legal launch states (25 ALLOW states)
3. [DONE] TASK-003: Backend scaffold + Supabase migrations + auth middleware
4. [DONE] TASK-004: Data ingestion layer (odds + MLB stats)
5. [DONE] TASK-005: ML feature scope + model selection + runtime decision (Fly.io confirmed)
6. [DONE] TASK-006: DevOps scaffolding + CI/CD files
7. [DONE] TASK-007 — AI Reasoning (commit 0321eb3)
8. [DONE] TASK-008 — Frontend (commit f4f8c60)
9. [DONE] TASK-009 — Stripe billing routes (commit 014bbc5)
10. [DONE] TASK-010-pre — Pick pipeline Edge Function (commit 2628d9a)
11. [NEXT PHASE] TASK-011 — QA end-to-end + pick pipeline validation
12. [NEXT PHASE] TASK-012 — DevOps: real infra provisioned (touches shared systems + money)
13. [NEXT PHASE] ML model training artifacts produced
14. Launch — after attorney review, trademark clearance, LLC formation

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
