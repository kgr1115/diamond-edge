# TASK-001 — Architect: Foundation Data Model, API Contracts, Folder Structure

**Status:** In Progress (spawned 2026-04-22)
**Owner:** mlb-architect
**Unblocks:** TASK-003 (Data Engineer), TASK-004 (ML Engineer), TASK-005 (Backend), TASK-006 (Frontend)

---

## Objective

Deliver the foundational design artifacts — Postgres schema spec, core API contracts, caching strategy, and repo folder structure — that every other agent builds against.

---

## Context

- Stack locked: Next.js 15 App Router + TypeScript / Supabase Postgres + Auth + RLS / Upstash Redis / Vercel Cron + Supabase Edge Functions / Stripe billing. See CLAUDE.md.
- Sportsbooks: DraftKings + FanDuel only in v1. Schema must extend to additional books without churn.
- Markets: moneyline, run line, totals, props, parlays, futures.
- Vercel timeout constraint: 10s (hobby) / 60s (pro). ML/LLM inference offloads.
- Budget: <$300/mo total. Odds data hard-capped at $100/mo.
- Auth: Supabase Auth. Row-level security on every user-facing table — mandatory.
- Subscription tiers exist (pricing TBD by user, but schema must support Free / Pro / Elite or similar named tiers).
- Responsible gambling, age-gate, geo-block are hard requirements — they show up in schema (user profile, blocked-state list).

---

## Inputs

- `CLAUDE.md` — locked decisions, full stack, agent roster
- Nothing else yet (this is the first artifact; everything downstream reads it)

---

## Deliverables

### 1. Repo Folder Structure (`docs/adr/ADR-001-repo-structure.md`)

Propose the top-level monorepo or app structure. At minimum cover:
- `apps/` or `src/` split
- Where ingestion code lives
- Where ML model code lives
- Where Supabase migrations live
- Where docs live (already created: `docs/adr/`, `docs/schema/`, `docs/api/`, `docs/compliance/`)
- Where background job code lives

### 2. Postgres Schema Spec (`docs/schema/schema-v1.md`)

For each table, specify:
- Table name
- Column name, type, nullable, default
- Indexes (explicit — don't rely on backend to guess)
- Foreign keys
- RLS policies (read/insert/update/delete, which roles)

Minimum tables required:
- `users` / `profiles` — age verification flag, geo state, subscription tier
- `games` — MLB schedule and state (scheduled/live/final)
- `picks` — one row per pick, all markets, confidence, EV, model probability, LLM rationale id
- `odds` — sportsbook odds snapshot per game/market, timestamped, book identifier (must be extensible)
- `pick_outcomes` — actual result after game completes, for historical accuracy tracking
- `subscriptions` — Stripe subscription record per user
- `bankroll_entries` — user-defined bet tracking (amounts, outcome, ROI)
- Any additional tables you judge necessary (e.g., `players`, `teams`, `rationale_cache`)

### 3. API Contracts (`docs/api/api-contracts-v1.md`)

For each Next.js API route, specify:
- Method + path
- Auth required (yes/no, which tier)
- Request shape (query params + body)
- Response shape (success + error envelope)
- Cache behavior (what headers, what Redis key)

Minimum routes required:
- `GET /api/picks/today` — today's slate (tier-gated fields)
- `GET /api/picks/[id]` — single pick detail
- `GET /api/games/[id]` — game detail with odds
- `GET /api/odds/[game_id]` — current odds, all books
- `GET /api/stats/team/[id]` — team stats
- `GET /api/stats/player/[id]` — player stats
- `GET /api/bankroll` — user's bankroll history
- `POST /api/bankroll/entry` — log a bet
- `GET /api/history` — historical pick performance (public)
- `POST /api/auth/age-verify` — age gate confirmation
- Stripe webhook handler (note: path, not full contract — Stripe shape is fixed)

### 4. Caching Strategy (`docs/schema/caching-strategy.md`)

For each cacheable resource:
- Redis key pattern
- TTL (justify each)
- Invalidation trigger
- What happens on cache miss

Minimum resources to cover:
- Today's odds per game per book
- Today's picks slate
- Game schedule
- Historical pick performance aggregate
- Player/team stats

### 5. ML/AI Output Contract (`docs/api/ml-output-contract.md`)

The seam between the ML agent's model output and the AI Reasoning agent's input. Specify:
- What fields the ML model produces per pick candidate
- How confidence/probability is structured
- How feature attributions (SHAP-style values) are structured
- How this flows into the LLM prompt

---

## Definition of Done

- [ ] ADR-001 (folder structure) exists at `docs/adr/ADR-001-repo-structure.md`
- [ ] Schema spec covers all listed tables with RLS policies per table
- [ ] API contracts cover all listed routes with typed request/response shapes
- [ ] Caching strategy has justified TTLs for all listed resources
- [ ] ML/AI output contract specifies the inter-agent seam
- [ ] Every table has an RLS policy in the spec
- [ ] No locked stack decisions reopened
- [ ] Budget impacts called out explicitly where applicable
- [ ] Open questions listed (orchestrator will triage, not architect)

---

## Dependencies

- No blockers. This task is self-contained — it reads CLAUDE.md and produces design artifacts.

---

## Notes

- You are specifying, not implementing. Backend agent writes migrations. Data engineer writes ingestion code.
- The folder structure you define in ADR-001 becomes the source of truth for where all agents write code.
- When in doubt, prefer boring patterns (standard FK relationships, standard REST shapes, no clever caching tricks without justification).
