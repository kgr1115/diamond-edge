---
name: Project State — Live
description: Current backlog, in-progress work, blockers, critical path, and open questions
type: project
---

Last updated: 2026-04-23 (App deployed, Kyle signed in as Elite, ML training + edge research spawned)

## Status: DEPLOYED. Kyle can log into https://diamond-edge-beryl.vercel.app — Elite tier, age-verified, geo-check passes. Slate shows zero-state pending ML model. ML training + edge-research agents running in background.

**Operating mode locked:** Personal-use v1. See `project_operating_mode.md` for full implications. Legal/commercial pre-launch blockers all SKIPPED.

## Deployment infrastructure (all provisioned, free tier)

- **Vercel Hobby**: `diamond-edge-beryl.vercel.app` (production). GitHub: `github.com/kgr1115/diamond-edge` (private, branch `main`)
- **Supabase Free**: project ref `wdxqqoafigbnwfqturmv`, 13 tables + RLS applied via `scripts/run-migrations/run.mjs`. Sportsbooks (DK, FD) + 26 blocked states seeded.
- **Upstash Redis Free**: `famous-bunny-77949.upstash.io`
- **Anthropic API**: configured, not yet used in production
- **The Odds API $59 plan**: 19,170 / 100,000 credits used (backfill). 80K remaining.
- **Fly.io**: account linked, FLY_API_TOKEN stored, **worker not yet deployed**.
- **Cron schedule**: 10am ET schedule-sync+odds, 12pm ET pick-pipeline (both in UTC as `0 14 * * *` / `0 16 * * *`)

## Gotchas encountered during provisioning (for future sessions)

- `vercel.json` CANNOT have `rootDirectory` — set via Vercel UI. Config file must live at `apps/web/vercel.json` (not repo root).
- Vercel Hobby caps crons at **2**. schedule-sync was extended to also run odds-refresh inline.
- Supabase Free tier's `db.<ref>.supabase.co` direct hostname is IPv6-only — residential networks can't reach it. Use the **session pooler** hostname instead: `aws-1-us-east-1.pooler.supabase.com:5432`.
- Supabase Site URL must be set to the prod URL; default `localhost:3000` breaks email links.
- Vercel dashboard UI truncated JWT pastes on long values — values got cut mid-token, causing "invalid API key" errors. Fix: paste via Vercel REST API or CLI with TTY. PowerShell/bash piping to `vercel env add` SAVED EMPTY STRINGS in this session's environment (CLI appears to need real TTY stdin).
- `GEO_ALLOW_STATES` env var was empty → every user got geo-blocked. Fixed by baking default ALLOW list into middleware code as fallback (`apps/web/middleware.ts` now has hardcoded default).
- Server-side page fetch used `NEXT_PUBLIC_APP_URL` with `localhost:3000` fallback — broke on Vercel. Fixed with VERCEL_URL fallback + explicit env var.

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

- **ML engineer ROI bias fix (background agent, late-night)** — spawned 2026-04-23 04:XX to fix the home-side EV bias bug the v2 ML agent flagged. Narrow scope: locate, fix, rerun backtest, report corrected numbers. Does not retrain.

## Recently Completed (Overnight 2026-04-23)

- **Research v1** (`5f6c38a`, `docs/research/mlb-edge-research.md`) — 30+ row edge catalog. Top 3: handedness-split park factors, opener detection + TTOP, LINEUP-01 late-news LLM pipeline.
- **Research v2** (`2f88af9`, `docs/research/mlb-edge-research-v2.md`) — 4 non-overlapping tracks: bankroll/Kelly ramp (0.10→0.25 over first 500 picks), advanced Statcast (release-point variability is peer-reviewed), prop derivatives (F5 markets confirmed on Odds API), data source audit (Retrosheet umpire CSVs free back to 1898; AAA Statcast free).
- **ML engineer v2** (8 commits `a9f432c` → `5c1ac27`) — Python worker scaffold, data pipelines (MLB Stats + Statcast + odds), handedness park factors, opener detection, training pipelines, backtest harness, FastAPI `/predict` + `/rationale` endpoints, Dockerfile.

## ML Backtest Results (2024 holdout) — NUMBERS PRE-BIAS-FIX

- **Moneyline**: log-loss=0.689, Brier=0.248, ECE=0.019 — calibration PASS. ROI inflated (bias bug).
- **Run line**: log-loss=0.655, Brier=0.225, ECE=0.016 — calibration PASS. ROI 18% (credible).
- **Totals**: log-loss=0.679, Brier=0.243, ECE=0.035 — calibration FAIL (max dev 0.065 > 0.05 threshold).

ML engineer recommends GATING totals picks to Tier 4+ only until calibration is resolved in v1.1 (needs more training data — Retrosheet history + umpire features from v2 research).

## Compute SLA

Worker: ~50ms/game inference (3 markets + SHAP), 200MB RAM, CPU-only, scale-to-zero on Fly.io.

## Outstanding Decisions for Kyle (Morning Check-in)

1. **Totals gating**: block entirely until v1.1, or publish with "lower confidence" flag? (ML engineer recommends gate to Tier 4+ only)
2. **Kelly sizing**: v2 research recommends ramp 0.10 → 0.25 over first 500 picks, not flat 0.25. Approve?
3. **Odds API plan**: current $59/100K tier. v2 research notes F5 + 30-min polling would hit cap; plan for $119/5M jump after F5 backtest.
4. **LINEUP-01 (late-news LLM)**: $30/mo RotoWire feed approval? Research says highest-ROI addition after v1 ships.
5. **AAA Statcast features**: v1 or v1.1 timing?
6. **Fly.io worker deploy**: ready to `flyctl deploy` the worker? Needed before any real picks land. Cost: ~$3-5/mo scale-to-zero.
7. **/rationale endpoint**: currently a stub. Full Claude Haiku integration needed — medium-scope work. v1 or v1.1?

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
