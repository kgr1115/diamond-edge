---
name: Phase 1 Artifacts — Commit d17d720
description: Complete inventory of what shipped in Phase 1 (commit d17d720, 84 files) so future sessions don't need to re-read the diff
type: project
---

Committed: 2026-04-22, commit d17d720
84 files. All four Phase 1 agents delivered.

## TASK-001 (mlb-architect)

- `docs/adr/ADR-001-repo-structure.md` — ADR for Next.js + Fly.io worker + Supabase structure
- `docs/schema/schema-v1.md` — 11-table Postgres schema with full RLS policies (profiles, sportsbooks, teams, players, games, odds, picks, rationale_cache, pick_outcomes, subscriptions, bankroll_entries, geo_blocked_states, age_gate_logs)
- `docs/api/api-contracts-v1.md` — 13 typed API routes with full request/response shapes, tier gating table
- `docs/schema/caching-strategy.md` — 7 Redis resources with justified TTLs
- `docs/api/ml-output-contract.md` — PickCandidate TypeScript interface + RationaleInput/RationaleOutput + pipeline seam diagram + grounding rules

## TASK-002 (mlb-compliance)

- `docs/compliance/state-matrix.md` — 51-state DK+FD matrix; 25 ALLOW jurisdictions (24 states + DC)
- `docs/compliance/geo-block-spec.md` — IP geo strategy, Vercel Edge Middleware, frontend+backend handoff
- `docs/compliance/copy/responsible-gambling.md` — 5 surfaces with exact copy, state-specific helplines
- `docs/compliance/age-gate-spec.md` — DOB flow, failure behavior, audit log spec
- `docs/compliance/launch-checklist.md` — 9-category pre-launch checklist, attorney items flagged

## TASK-003 (mlb-backend)

Key files (not exhaustive):
- `apps/web/` — full Next.js 15 App Router scaffold
- `apps/web/app/api/auth/age-verify/route.ts` — age gate POST handler
- `apps/web/app/api/webhooks/stripe/route.ts` — Stripe webhook (4 events handled, idempotent)
- `apps/web/app/api/picks/today/route.ts` — tier-gated picks slate with Redis caching
- `apps/web/app/api/cron/odds-refresh/route.ts` — cron handler (trigger only)
- `apps/web/app/api/cron/schedule-sync/route.ts` — cron handler (trigger only)
- `apps/web/lib/supabase/client.ts` — browser Supabase client
- `apps/web/lib/supabase/server.ts` — server Supabase client + service role client
- `apps/web/lib/supabase/middleware.ts` — geo-block + age-gate middleware
- `apps/web/lib/stripe/client.ts` — Stripe client + tierFromPriceId (reads STRIPE_PRICE_PRO, STRIPE_PRICE_ELITE env vars)
- `apps/web/lib/redis/cache.ts` — Redis cache helpers + CacheKeys + CacheTTL constants
- `apps/web/lib/types/database.ts` — hand-maintained TypeScript DB types (all 11 tables)
- `supabase/migrations/` — 7 migration files implementing schema-v1.md

## TASK-004 (mlb-data-engineer)

- `apps/web/lib/ingestion/config.ts` — ingestion config constants
- `apps/web/lib/ingestion/odds/client.ts` — The Odds API client
- `apps/web/lib/ingestion/odds/transform.ts` — odds API → DB transform
- `apps/web/lib/ingestion/odds/poll.ts` — scheduled polling logic
- `apps/web/lib/ingestion/mlb-stats/client.ts` — MLB Stats API client
- `apps/web/lib/ingestion/mlb-stats/schedule.ts` — schedule sync
- `apps/web/lib/ingestion/mlb-stats/rosters.ts` — roster sync
- `apps/web/lib/ingestion/mlb-stats/box-scores.ts` — box score sync
- `apps/web/lib/ingestion/weather/client.ts` — Open-Meteo weather client
- `apps/web/lib/ingestion/weather/stadiums.ts` — MLB stadium coordinates
- `docs/ingestion/rate-limit-budget.md` — API rate limit budgets and polling intervals

## TASK-005 (mlb-ml-engineer)

- `worker/models/README.md` — top-level model overview (moneyline, run_line, totals)
- `worker/models/moneyline/feature-spec.md` — full feature list with sources, transformations, leak audits
- `worker/models/run_line/feature-spec.md` — same for run line
- `worker/models/totals/feature-spec.md` — same for totals
- `worker/models/backtest-harness.md` — 3-season backtest spec (2021-2023 train, 2024 holdout)
- `worker/models/calibration-spec.md` — confidence tier mapping (EV → tier 1-5)
- `worker/models/inference-runtime.md` — COMMITTED: Fly.io Python worker, shared-cpu-1x, 512 MB RAM, scale-to-zero, $1-4/mo cost, `/predict` HTTP contract
- `worker/models/pick_candidate_schema.py` — Python dataclass exactly matching TypeScript PickCandidate interface
- `worker/fly.toml` — Fly.io configuration skeleton

## TASK-006 (mlb-devops)

- `vercel.json` — 4 Vercel Cron definitions (odds-refresh, schedule-sync, pick-pipeline, outcome-grader)
- `.github/workflows/ci.yml` — GitHub Actions CI (lint, typecheck, test, build)
- `.github/workflows/migrations.yml` — Supabase migration workflow
- `worker/fly.toml` — finalized Fly.io config
- `docs/runbooks/odds-ingestion-lag.md` — runbook for odds data issues
- `docs/runbooks/pick-pipeline-failure.md` — runbook for pipeline failures (log event names referenced by TASK-010-pre)
- `docs/runbooks/cost-spike.md` — runbook for cost alerts
- `docs/infra/cost-projection.md` — monthly cost projection by service
- `docs/infra/secrets-manifest.md` — complete secrets inventory (Vercel, GitHub Actions, Supabase Vault, Fly.io)
- `docs/infra/vercel-setup.md` — Vercel project setup guide

## Key Decisions Made in Phase 1

- Fly.io Python worker CONFIRMED for ML inference (not Supabase Edge Function — Deno cannot run LightGBM)
- Scale-to-zero Fly.io machine (0 min machines) — $1-4/mo at v1 volumes
- `WORKER_API_KEY` shared secret for Fly.io worker authentication (set in Fly.io secrets + Supabase Vault)
- `MODEL_ENDPOINT_URL` = `https://diamond-edge-worker.fly.dev` (set in Supabase Edge Function env + Vercel)
- Feature attributions: top 7 by |shap_value|, sorted descending
- PickCandidate.feature_attributions must not be empty — pipeline rejects picks without SHAP attributions
- Stripe env vars: `STRIPE_PRICE_PRO` and `STRIPE_PRICE_ELITE` (not yet set — TASK-009 adds these)
