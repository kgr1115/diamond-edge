# TASK-004 â€” Data Ingestion Layer

**Agent:** mlb-data-engineer
**Phase:** 1
**Date issued:** 2026-04-22
**Status:** In progress

---

## Objective

Design and implement the complete data ingestion layer: The Odds API integration for DK + FD lines, MLB Stats API ingestion for schedules/rosters/box scores, and the Upstash Redis caching layer â€” all within the $79/mo The Odds API budget.

---

## Context

- Stack: Vercel Cron (light, <10s) + Supabase Edge Functions (>10s, scheduled) + Fly.io worker (overflow ML/LLM â€” not your concern for ingestion). Coordinate runtime choice with DevOps (TASK-006).
- Odds budget: The Odds API entry tier ~$79/mo. Hard cap $100/mo. No real-time polling â€” scheduled pulls only.
- Sportsbooks: DraftKings (`draftkings`) + FanDuel (`fanduel`) only. Ingestion code must be data-driven on `sportsbook.key` â€” no hardcoded book strings.
- Cache: Upstash Redis via `@upstash/redis` SDK. All Redis keys prefixed `de:`. Key patterns and TTLs defined in `docs/schema/caching-strategy.md`. TASK-003 (backend) writes `lib/redis/cache.ts`; you use it.
- UTC timestamps everywhere â€” MLB games cross time zones.
- The DB schema is in `docs/schema/schema-v1.md`. You normalize external data into the tables defined there. You do not modify the schema.
- ML/AI pipeline note: The pick pipeline reads `odds` and `games` tables. Freshness of your ingestion directly determines pick quality. Design polling cadence to minimize staleness without blowing the API budget.
- Weather: free or near-free source for v1. Suggest Open-Meteo (free, no key required) or wttr.in as a fallback. Surface your recommendation with cost estimate.

---

## Inputs

- `CLAUDE.md` â€” locked constraints
- `docs/schema/schema-v1.md` â€” target tables: `games`, `odds`, `teams`, `players`, `sportsbooks`
- `docs/schema/caching-strategy.md` â€” Redis key patterns and TTLs for odds and schedule resources
- `docs/api/api-contracts-v1.md` â€” downstream consumers of ingested data (read to understand what freshness they need)
- `docs/api/ml-output-contract.md` â€” ML model reads `games` and `odds` table shape; your data feeds it

---

## Deliverable Format

Working code committed under the repo root `C:\AI\Public\diamond-edge`. Suggested paths:

1. **`apps/web/lib/ingestion/odds/`** â€” The Odds API client:
   - `client.ts` â€” typed fetch wrapper with retry + exponential backoff on 429/5xx
   - `transform.ts` â€” normalizes Odds API response â†’ `odds` table rows
   - `poll.ts` â€” polling orchestration: cadence logic, budget tracking
   - `README.md` â€” source summary, rate-limit envelope, monthly call projection, failure modes

2. **`apps/web/lib/ingestion/mlb-stats/`** â€” MLB Stats API client:
   - `client.ts` â€” fetch wrapper for MLB Stats API endpoints
   - `schedule.ts` â€” today + tomorrow schedule sync â†’ `games` table upsert
   - `rosters.ts` â€” active roster sync â†’ `teams`, `players` tables upsert
   - `box-scores.ts` â€” completed game box scores â†’ `games` table updates (scores, final status)
   - `README.md` â€” source summary, rate limits, freshness SLA

3. **`apps/web/lib/ingestion/weather/`** â€” Weather data:
   - `client.ts` â€” lightweight weather fetch for game venue + game time
   - `README.md` â€” source selected, cost, freshness, how it feeds `games.weather_*` columns

4. **`apps/web/app/api/cron/odds-refresh/route.ts`** â€” Vercel Cron handler:
   - CRON_SECRET header check
   - Calls odds client, upserts `odds` rows
   - Invalidates Redis keys: `de:odds:game:{game_id}` for each updated game (per caching-strategy.md)
   - Structured log: games updated, rows inserted, call count used this run

5. **`apps/web/app/api/cron/schedule-sync/route.ts`** â€” Vercel Cron handler:
   - Syncs today + tomorrow schedule from MLB Stats API
   - Upserts `games` table
   - Invalidates Redis: `de:schedule:{today}`, `de:schedule:{tomorrow}`

6. **`docs/ingestion/rate-limit-budget.md`** â€” Call budget analysis:
   - The Odds API: calls/day by endpoint, monthly projection, headroom vs. ~$79 tier limit
   - MLB Stats API: daily call count (free, no hard limit but be polite)
   - Recommended Vercel Cron schedules (e.g., `0 */30 * * *` for odds every 30 min pre-game)

---

## Definition of Done

- [ ] The Odds API client fetches moneyline, run_line, and totals markets for both DK and FanDuel for all MLB games today.
- [ ] Fetched odds are transformed into `odds` table row format and insertable via upsert (with ON CONFLICT handling).
- [ ] Monthly call projection documented in `rate-limit-budget.md` showing total calls/month < The Odds API tier limit.
- [ ] Polling cadence defined: at minimum, odds refresh every 30 minutes for games starting within 3 hours; less frequently for games >3 hours out.
- [ ] MLB Stats API schedule sync upserts today + tomorrow games into `games` table with all columns from schema-v1.md.
- [ ] Roster sync upserts current `teams` and `players` rows (run daily).
- [ ] Box score sync updates `games` with final scores and status after game completion.
- [ ] Weather fetch wired to game venue + UTC game time; populates `games.weather_*` columns.
- [ ] Redis invalidation called from cron handlers after each successful write batch.
- [ ] All external API calls have retry logic with backoff for 429 and 5xx responses.
- [ ] 429 errors are logged (not silently dropped) with call-count context.
- [ ] UTC timestamps on all `snapshotted_at` fields â€” no local time leakage.
- [ ] Adding a third sportsbook requires only a config/seed change, not a code change.
- [ ] `rate-limit-budget.md` exists and shows projected monthly spend < $100 hard cap.
- [ ] No The Odds API key in client-side code or committed to repo (uses env var `ODDS_API_KEY`).

---

## Dependencies

**Requires (before starting):**
- `docs/schema/schema-v1.md` â€” DONE (TASK-001): target tables defined
- `docs/schema/caching-strategy.md` â€” DONE (TASK-001): Redis key patterns defined

**Does NOT require:**
- TASK-003 (backend) to be complete â€” you write ingestion code; backend wires the cron routes
- TASK-005 (ML) to be complete â€” ML consumes your data; you don't depend on it

**This task unblocks:**
- TASK-005 (ML/Analytics) â€” needs real odds and game data to build features and backtest
- Pick pipeline (Phase 2) â€” reads `odds` and `games` tables you populate

**New secrets/env vars to surface to DevOps (TASK-006):**
- `ODDS_API_KEY` â€” The Odds API key
- `MLB_STATS_API_BASE` â€” optional, base URL if needed (API is public, no key required)
- `WEATHER_API_KEY` â€” only if your chosen weather source requires one (prefer keyless)
