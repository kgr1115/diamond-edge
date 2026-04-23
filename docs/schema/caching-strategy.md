# Diamond Edge — Caching Strategy v1

**Status:** Draft for implementation
**Date:** 2026-04-22
**Author:** mlb-architect
**Implements:** Upstash Redis via `apps/web/lib/redis/`

---

## Principles

- **Cache at the API route layer,** not inside the DB query. The route checks Redis first; on miss, queries Supabase and writes back.
- **Key namespacing:** All keys prefixed with `de:` (Diamond Edge) to avoid collisions if the Redis instance is ever shared.
- **TTL over explicit invalidation where possible.** Only invalidate explicitly when stale data causes a wrong pick or wrong odds display. Over-invalidation wastes The Odds API quota.
- **No user-specific caching in Redis.** Bankroll, subscription status, and profile data are user-specific, fast Postgres queries with RLS. Redis is for shared/public data only.
- **Cache-aside pattern** throughout: read from Redis → hit returns; miss → query source → write to Redis → return.

---

## Resource Cache Policies

### 1. Today's Picks Slate

**Purpose:** `/api/picks/today` — highest-traffic endpoint; data changes only when pick pipeline runs (1–2x/day).

**Redis key pattern:**
```
de:picks:today:{date}:{tier}
```
Where `{date}` is `YYYY-MM-DD` and `{tier}` is `anon | free | pro | elite`.

Four cached variants per day — one per entitlement level — because column masking is baked into the serialized response.

**TTL:** 900 seconds (15 minutes)

**Justification:** Pick pipeline runs at most 2–3x per day (morning pre-slate, possible midday update). 15-min TTL means a new subscriber gets fresh picks within 15 minutes without a manual flush. Acceptable staleness for a daily-picks product.

**Invalidation trigger:** Pick pipeline completion (Supabase Edge Function `pick-pipeline` writes picks → calls `INVALIDATE picks:today:*` via Upstash REST API). Wildcard invalidation over the 4 tier variants.

**Cache miss behavior:** Query `picks` table with RLS bypass (service role), apply tier masking in code, serialize, write to Redis, return.

---

### 2. Odds Per Game Per Book

**Purpose:** `/api/odds/[game_id]` and embedded in `/api/games/[id]`. Changes when The Odds API is polled.

**Redis key pattern:**
```
de:odds:game:{game_id}
```

**TTL:** 600 seconds (10 minutes)

**Justification:** The Odds API cron job runs every 30 minutes pre-game (see Data Engineer's polling cadence). 10-min TTL ensures users see the latest odds within one poll cycle. Lines don't move fast enough to require shorter TTL for a daily-picks product.

**Invalidation trigger:** Odds-refresh cron job writes new `odds` rows → calls `INVALIDATE de:odds:game:{game_id}` for each updated game.

**Cache miss behavior:** Query `odds` table for the latest snapshot per book per market for the game (ORDER BY snapshotted_at DESC, DISTINCT ON (sportsbook_id, market)). Compute best lines across books. Serialize. Write to Redis.

---

### 3. Game Schedule (Today + Tomorrow)

**Purpose:** Game list for the slate view, game detail lookups.

**Redis key pattern:**
```
de:schedule:{date}
```

**TTL:** 3600 seconds (1 hour)

**Justification:** The MLB schedule for a given day is stable once posted. Lineup and pitcher changes come through as game updates, not schedule changes. 1-hour TTL is safe. Postponements/cancellations are the only time this needs to refresh mid-day.

**Invalidation trigger:** Schedule-sync cron job (runs 2x/day) explicitly invalidates `de:schedule:{today}` and `de:schedule:{tomorrow}` after writing.

**Cache miss behavior:** Query `games` table for `game_date = {date}`, join teams. Serialize. Write.

---

### 4. Historical Pick Performance Aggregate

**Purpose:** `/api/history` — public transparency page. Expensive aggregate query. Changes only when outcomes are graded (1–2x/day post-game completion).

**Redis key pattern:**
```
de:history:agg:{market}:{from_date}:{to_date}
```
For paginated results:
```
de:history:list:{market}:{from_date}:{to_date}:{page}:{per_page}
```

**TTL:** 3600 seconds (1 hour)

**Justification:** Historical accuracy is append-only; it only changes when the outcome-grader job runs (~2–4am ET after all West Coast games complete). 1-hour TTL is safe. Subscribers viewing historical performance don't need sub-minute freshness.

**Invalidation trigger:** Outcome-grader job completion → invalidate `de:history:agg:*` and `de:history:list:*` (wildcard on the aggregate and list keys). Upstash supports SCAN-based pattern deletion; use that here.

**Cache miss behavior:** Run aggregate SQL query across `pick_outcomes` JOIN `picks`. Paginate list query. Write both aggregate and list page to Redis.

---

### 5. Player Stats

**Purpose:** `/api/stats/player/[id]`. Season stats per player per split. Changes daily (after games complete).

**Redis key pattern:**
```
de:stats:player:{player_id}:{season}:{split}
```

**TTL:** 10800 seconds (3 hours)

**Justification:** Player stats update once per day after games complete. 3-hour TTL means stats refresh within 3 hours of game completion. Players don't need real-time stats for daily picks.

**Invalidation trigger:** No explicit invalidation. TTL expiry is sufficient — stats change at most once per day.

**Cache miss behavior:** Query MLB Stats API (or cached DB table if Data Engineer stores stats locally). Return and cache.

---

### 6. Team Stats

**Purpose:** `/api/stats/team/[id]`. Same cadence as player stats.

**Redis key pattern:**
```
de:stats:team:{team_id}:{season}:{split}
```

**TTL:** 10800 seconds (3 hours)

**Justification:** Same as player stats. Team records and aggregates change post-game, not intra-game.

**Invalidation trigger:** No explicit invalidation. TTL expiry.

**Cache miss behavior:** Query DB or MLB Stats API.

---

### 7. Single Pick Detail

**Purpose:** `/api/picks/[id]` — individual pick pages, linked from social/email.

**Redis key pattern:**
```
de:pick:{pick_id}:{tier}
```

**TTL:** 1800 seconds (30 minutes)

**Justification:** Pick detail changes only if the result is graded. 30-min TTL is a reasonable balance — low traffic per individual pick, so cache hits are fewer than the slate view, but worth caching to reduce DB reads on linked/viral picks.

**Invalidation trigger:** Outcome-grader job grades the pick → invalidate `de:pick:{pick_id}:*` across tiers.

---

## What Is NOT Cached in Redis

| Resource | Why |
|---|---|
| User profile / subscription tier | User-specific, small, fast RLS query. Cached in Supabase session via Supabase Auth JWT claims (tier in JWT). |
| Bankroll entries | User-specific, write-heavy, must be fresh after every POST. |
| Age gate status | Stored in profile, served from JWT claims. |
| Geo block check | `geo_blocked_states` table is small (~50 rows); cached in-memory at the Edge Function layer or queried directly. Not Redis. |
| Stripe webhook state | Event-driven writes; no read pattern to cache. |

---

## Upstash Redis Budget

At <500 users and current cache patterns:
- Estimated daily commands: ~15,000–30,000 (reads + writes)
- Upstash free tier: 10,000 commands/day
- Upstash Pay-as-You-Go: ~$0.20 per 100K commands

**Projected cost:** <$5/month at <500 users. Well within budget.

**Hard limit:** Configure Upstash max monthly budget alert at $20/month. If commands spike, the first thing to check is odds polling cadence or a hot pick going viral.

---

## Implementation Notes for Data Engineer

- All Redis operations use the Upstash REST API via `@upstash/redis` SDK (edge-compatible, no TCP connection pooling needed).
- Write a thin `cache.ts` helper in `apps/web/lib/redis/` with typed `get<T>` and `set<T>` wrappers.
- Wildcard invalidation (SCAN + DEL) should be a utility function. Do not call it on every request — only from cron/pipeline completion hooks.
- All cache writes must handle Redis failures gracefully: if Redis is down, fall through to Supabase and return the result without caching. Never surface a Redis error to the user.
