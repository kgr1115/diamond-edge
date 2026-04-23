---
name: Phase 2 Artifacts — 5 Commits
description: Complete inventory of what shipped in Phase 2 (commits 0321eb3, 014bbc5, f4f8c60, 9c7c05e, 2628d9a) so future sessions don't need to re-read diffs
type: project
---

Committed: 2026-04-22, five commits ending at 2628d9a (plus memory-hygiene commit 54d97c9 and return-format commit 666d437). All four Phase 2 tasks delivered.

## TASK-007 (mlb-ai-reasoning) — commit 0321eb3

- `apps/web/lib/ai/types.ts` — TypeScript interfaces matching Python PickCandidate field-for-field
- `apps/web/lib/ai/prompts/system-prompt.ts` — Stable, cache-eligible system prompt (600 tokens)
- `apps/web/lib/ai/prompts/user-prompt.ts` — Per-pick user prompt builder (not cached)
- `apps/web/lib/ai/generate-rationale.ts` — Main generation function with `server-only` guard; Haiku for Pro, Sonnet for Elite, throws on Free tier
- `apps/web/lib/ai/cost-model.ts` — Monthly cost estimator with cache hit/miss modeling
- `apps/web/lib/ai/evals/rationale-eval.ts` — 6-check factuality eval harness
- `apps/web/lib/ai/evals/test-cases.ts` — 3 canned test cases (Pro pass, Elite pass, hallucination fail)
- `docs/briefs/TASK-007-cost-projection.md` — Cost projections at 3/5/6 picks/day
- `docs/briefs/TASK-007-ai-reasoning.md` — task brief
- Dep added: `@anthropic-ai/sdk`

Cost headline: $0.85/mo at 6 picks/day, 100% users — far below the $50 trip-wire.

## TASK-009 (mlb-backend focused) — commit 014bbc5

- `apps/web/app/api/billing/checkout/route.ts` — creates Stripe checkout session
- `apps/web/app/api/billing/portal/route.ts` — redirects to Stripe customer portal
- Stripe product seeding script / doc (see docs/briefs/TASK-009-stripe-billing.md)
- Adds env vars `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ELITE` (confirmed locked at $19 / $39)

## TASK-008 (mlb-frontend) — commit f4f8c60

- Slate view, pick detail, bankroll dashboard, pricing page, age gate screen, geo-block screen, RG copy surfaces
- "No qualifying picks today" zero-state handled (Tier 3+ threshold produces some zero-pick days)
- shadcn/ui Radix primitives added (Dialog, Dropdown, Label, Select, Slot, Toast)
- Deps added: `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`

## Build hygiene — commit 9c7c05e

- `force-dynamic` exports on age-verify + picks/today (prevents Next.js static generation of request-dependent routes)
- Lazy Stripe singleton in `lib/stripe/client.ts` + `getStripe()` call pattern in webhook route (prevents module-load-time init during `next build`)
- `tsconfig.json`: target ES2017, downlevelIteration, ingestion lib excluded from Next.js compilation context
- Narrower cast for Supabase join typing in `odds/poll.ts`

## TASK-010-pre (mlb-backend + ml-engineer coordination) — commit 2628d9a

Vercel Cron triggers:
- `apps/web/app/api/cron/pick-pipeline/route.ts` — 9am ET trigger, fire-and-forget invoke of Supabase Edge Function
- `apps/web/app/api/cron/outcome-grader/route.ts` — 2am ET stub for TASK-011

Supabase Edge Function — `supabase/functions/pick-pipeline/`:
- `index.ts` — 7-stage orchestrator (game_fetch → odds_fetch → worker_call → ev_filter → rationale_call → db_write → cache_invalidate)
- `worker-client.ts` — HTTP contract for Fly.io `/predict` endpoint
- `feature-builder.ts` — builds feature vectors from game + odds + stats rows
- `rationale.ts` — per-pick rationale fetch (Pro/Elite only, prompt_hash dedup)
- `redis.ts` — invalidates `picks:today:*` keys after successful write
- `types.ts` — shared types for pipeline stages

Error handling aligned with `docs/runbooks/pick-pipeline-failure.md`:
- Single-game predict failure → skip, continue
- Rationale failure → write pick with `rationale_id = null`
- DB write failure → return 500
- Cache invalidation failure → log warning, return 200

## Key Decisions Made in Phase 2

- `@anthropic-ai/sdk` is the LLM client. No OpenAI. No other providers.
- Rationale generation is `server-only` — cannot leak into client bundle.
- `temperature: 0` on all Claude calls — deterministic for `prompt_hash` dedup.
- System prompt uses `cache_control: ephemeral` — user prompt is uncached (dynamic per pick).
- Free tier: `generateRationale()` throws at function boundary. No Claude call possible.
- Pipeline uses fire-and-forget Edge Function invocation (Vercel cron returns in <2s; Edge runs independently).
- Pro tier users see Haiku rationale; Elite users get Sonnet. No per-user override in v1.

## Outstanding for Phase 3

- TASK-011 (QA) — spawned in background after Phase 2
- TASK-012 (DevOps provisioning) — requires user confirmation per Auto Mode rules (touches real cloud + money)
- ML model training artifacts — pipeline writes 0 picks until Fly.io worker returns populated candidates
