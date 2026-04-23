# TASK-003 — Backend Scaffold

**Agent:** mlb-backend
**Phase:** 1
**Date issued:** 2026-04-22
**Status:** In progress

---

## Objective

Scaffold the `apps/web/` Next.js 15 application, write all Supabase Postgres migrations from `docs/schema/schema-v1.md`, and implement Supabase Auth with the age-gate endpoint and Vercel Edge Middleware geo-blocking per the compliance specs.

---

## Context

- Repo root: `C:\Projects\Baseball_Edge`. ADR-001 defines the folder layout.
- Stack: Next.js 15 App Router + TypeScript + Tailwind CSS + shadcn/ui (locked in CLAUDE.md).
- DB: Supabase Postgres with RLS. Every user-facing table has RLS — no exceptions (schema design principle).
- Auth: Supabase Auth (email + OAuth). JWT claims carry `subscription_tier` for fast tier checks.
- Tier gating is enforced in application code (column masking), not RLS. RLS controls row visibility only.
- Geo-blocking: Vercel Edge Middleware reads `request.geo.region` and checks against `GEO_ALLOW_STATES` env var (v1 recommendation from geo-block-spec: bake ALLOW list into env var, not DB lookup). For v1 the list is: AZ,AR,CO,CT,DC,IL,IN,IA,KS,KY,LA,MD,MA,MI,MO,NJ,NY,NC,OH,PA,TN,VT,VA,WV,WY
- Age gate: POST /api/auth/age-verify. Server-side age computation. No retry on failure. Full DOB stored in profiles.date_of_birth for audit. See docs/compliance/age-gate-spec.md.
- Free-tier users see pick side + confidence_tier only. No rationale field. Rationale is pro/elite only. LOCKED DECISION.
- Parlays deferred to v1.1. `market_type` enum retains 'parlay' as reserved value but no parlay picks generated.
- Minimum confidence threshold: tier 3+ (EV > 4%). The pick pipeline will enforce this; backend route handlers must not filter by confidence_tier themselves (let the pipeline own that).

---

## Inputs

All inputs are checked in at the repo root `C:\Projects\Baseball_Edge`:

- `CLAUDE.md` — locked stack and engineering principles
- `docs/schema/schema-v1.md` — 13-table Postgres schema with full RLS policies and enums
- `docs/api/api-contracts-v1.md` — 13 typed API routes (response shapes, auth requirements, error envelope)
- `docs/schema/caching-strategy.md` — Redis key patterns, TTLs, invalidation triggers per route
- `docs/compliance/geo-block-spec.md` — Edge Middleware logic, conflict resolution table, ALLOW list
- `docs/compliance/age-gate-spec.md` — DOB gate mechanics, failure behavior, audit log spec
- `docs/adr/ADR-001-repo-structure.md` — canonical folder layout

---

## Deliverable Format

Working code committed to `C:\Projects\Baseball_Edge`:

1. **`apps/web/`** — scaffolded Next.js 15 app. Must include:
   - `package.json` with Next.js 15, TypeScript, Tailwind CSS, shadcn/ui, @supabase/ssr, @upstash/redis, zod
   - `tsconfig.json`, `tailwind.config.ts`, `next.config.ts`
   - `app/layout.tsx` (root layout, Tailwind wired)
   - `app/page.tsx` (placeholder homepage — "Diamond Edge coming soon")
   - `middleware.ts` — Vercel Edge Middleware implementing geo-block logic per geo-block-spec.md
   - `lib/supabase/` — server client, browser client, middleware client (three helper files per @supabase/ssr pattern)
   - `lib/redis/cache.ts` — thin typed wrapper: `get<T>()`, `set<T>()`, `invalidate()` per caching-strategy.md

2. **`supabase/migrations/`** — numbered SQL migration files implementing every table, enum, index, and RLS policy from schema-v1.md:
   - `0001_enums.sql` — all 5 enums
   - `0002_lookup_tables.sql` — sportsbooks (with seed data: DK + FD), geo_blocked_states (seeded with all non-ALLOW states)
   - `0003_reference_tables.sql` — teams, players
   - `0004_core_tables.sql` — games, odds, rationale_cache
   - `0005_pick_tables.sql` — picks, pick_outcomes
   - `0006_user_tables.sql` — profiles (with auth trigger), subscriptions, bankroll_entries, age_gate_logs
   - `0007_rls_policies.sql` — all RLS policies (can be inline with tables above OR a separate file — your call, but name it clearly)

3. **`apps/web/app/api/auth/age-verify/route.ts`** — POST handler per age-gate-spec.md:
   - Accepts `{ date_of_birth: 'YYYY-MM-DD', method: 'dob_entry' }`
   - Server-side age computation (no client trust)
   - On pass: updates `profiles`, writes `age_gate_logs`
   - On fail: writes `age_gate_logs`, returns 403 with `{ error: { code: 'AGE_GATE_FAILED', message: 'Age verification failed.' } }`
   - Same 403 for both "format invalid" and "age < 21" — no leakage

4. **`apps/web/app/api/webhooks/stripe/route.ts`** — Stripe webhook stub:
   - Signature verification via `stripe.webhooks.constructEvent`
   - Handles: `customer.subscription.created`, `.updated`, `.deleted`, `invoice.payment_failed`
   - Updates `subscriptions` table + `profiles.subscription_tier` accordingly
   - Returns 200 immediately; processing is synchronous (no queue in v1)
   - Idempotent on replay

5. **`apps/web/app/api/picks/today/route.ts`** — GET handler:
   - Implements tier gating (column masking) per api-contracts-v1.md tier table
   - Free tier: omits `best_line_price`, `best_line_book`, `model_probability`, `expected_value`, `rationale_preview`
   - Pro tier: includes above minus `expected_value`
   - Elite tier: includes all
   - Redis cache check first (key: `de:picks:today:{date}:{tier}`, TTL 900s per caching-strategy.md)
   - Geo-block check: reject if `profiles.geo_blocked = true` (authenticated) or IP geo check (anon)

6. **`supabase/config.toml`** — project config with dev/staging/prod awareness

---

## Definition of Done

- [ ] `apps/web/` directory exists; `npm install` runs cleanly (no missing peer deps).
- [ ] `next build` or `next dev` starts without TypeScript errors.
- [ ] All 13 tables from schema-v1.md are present in migration files with correct column types, constraints, indexes, and RLS policies.
- [ ] Migration files are numbered and apply in order without errors on a fresh Supabase local dev instance.
- [ ] `sportsbooks` seed data: DraftKings and FanDuel rows inserted.
- [ ] `geo_blocked_states` seed: all non-ALLOW states inserted.
- [ ] Edge Middleware (`middleware.ts`) blocks requests to `/api/picks/*` and `/api/bankroll/*` from non-ALLOW state IPs; passes everything else.
- [ ] `POST /api/auth/age-verify` correctly accepts/rejects DOBs, writes audit log, returns correct HTTP codes.
- [ ] `POST /api/webhooks/stripe` verifies Stripe signature, handles the 4 subscription events, is idempotent.
- [ ] `GET /api/picks/today` returns tier-masked responses (manually testable with different tier values in the DB).
- [ ] `lib/redis/cache.ts` has typed `get<T>()`, `set<T>()`, `invalidate()` with Redis failure gracefully falling through to the DB call (never surfacing a Redis error to the user).
- [ ] No service-role key in any client bundle or any file in `apps/web/public/`.
- [ ] All API route inputs validated with Zod.
- [ ] Structured logs emitted from route handlers (console.log is acceptable for v1; DevOps wires them to Sentry later).

---

## Dependencies

**Requires (before starting):**
- `docs/schema/schema-v1.md` — DONE (TASK-001)
- `docs/api/api-contracts-v1.md` — DONE (TASK-001)
- `docs/schema/caching-strategy.md` — DONE (TASK-001)
- `docs/compliance/geo-block-spec.md` — DONE (TASK-002)
- `docs/compliance/age-gate-spec.md` — DONE (TASK-002)

**Does NOT require:**
- DevOps provisioning (TASK-006) — write code against local Supabase dev; DevOps wires prod secrets later
- Data ingestion (TASK-004) — build against the schema shape; actual data comes later
- ML model (TASK-005) — routes that call the pick pipeline are stubs (return mock data) until TASK-005 completes

**This task unblocks:**
- TASK-007 (AI Reasoning) — needs stable API routes
- TASK-008 (Frontend) — needs stable API routes and Supabase client helpers
- TASK-009 (Stripe billing) — needs auth + subscriptions table
