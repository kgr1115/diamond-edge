# Moneyline v0 — Backfill Runbook

**Date:** 2026-04-30
**Rev:** 3 (updated 2026-04-30 — The Odds API historical endpoint replaces Pinnacle archive path; rationale steps removed per archive directive; $119/5M tier authorized by Kyle)
**Author:** mlb-data-engineer
**Status:** GATED — do not execute any step until migrations 0023–0027 land (mlb-backend owns). Backfill is re-invoked after migrations confirm.
**Prerequisite:** Architect must add `lineup_entries.pinned_at` column and `park_factor_runs` table before Steps 4 and 5 can complete meaningfully.

---

## Prerequisites

Before running any step:

```
SUPABASE_SERVICE_KEY    — required for all write steps
MLB_STATS_API_BASE      = https://statsapi.mlb.com/api/v1
OPEN_METEO_ARCHIVE      = https://archive-api.open-meteo.com/v1/archive
THE_ODDS_API_KEY        — required for Step 3 (historical endpoint)
ODDS_API_BASE           = https://api.the-odds-api.com/v4
```

**Migration gate:** do not execute any step until Supabase confirms migrations 0023, 0024, 0025, 0026, 0027 are applied to the target environment. Check via:

```sql
SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 10;
```

---

## Step 1 — MLB Stats API: Game Schedule 2022–2024

**Source:** `https://statsapi.mlb.com/api/v1/schedule`
**Target table:** `games`
**Cost:** Free
**Rate limit:** No official published limit; use 2 req/sec with exponential backoff on 429.
**Estimated wall time:** ~25 minutes (3 seasons × ~2,430 games, schedule fetched per-season in one call per sport-type per season)
**Training window:** Effective training start is 2023-04-01. September–October 2022 is ingested but used only as a rolling-feature warmup window, not as training rows. 2021 is not ingested (Odds API archive boundary makes closing-line joins unreliable before 2022).

### Approach

One call per season per sport type retrieves the full schedule:

```
GET /schedule?sportId=1&season=2022&gameType=R&fields=dates,games,gamePk,gameDate,status,teams,venue
```

Repeat for 2023, 2024. Parse into `games` rows. Map `gamePk` → `mlb_game_id`. Game time stored as UTC (`game_time_utc`).

### Idempotency

Upsert on `mlb_game_id`. Re-running the script inserts no duplicate rows. Track progress via `metrics.json` (see below).

### Failure handling

- 429: backoff 30s, retry up to 3 times, then dead-letter to `cron_runs` with `status='failure'`.
- Schema drift (new field names): log and skip the offending field; do not fail the whole season.
- Postponed/cancelled games: ingest with `status='postponed'` or `status='cancelled'`; exclude from training set at feature-build time.

### Expected row count

~2,430 rows per regular season × 3 seasons = ~7,290 `games` rows.

### Coverage output (metrics.json contribution)

```json
{ "step": "schedule", "seasons": [2022, 2023, 2024], "rows_upserted": <n>,
  "coverage_pct": <n/7290*100>, "gaps": [] }
```

---

## Step 2 — MLB Stats API: Pitcher Game Logs + Team Batting/Bullpen Stats 2022–2024

**Source:** `https://statsapi.mlb.com/api/v1/people/{personId}/stats` + team endpoints
**Target tables:** `pitcher_season_stats`, `team_batting_stats`, `bullpen_team_stats`
**Cost:** Free
**Rate limit:** 2 req/sec with backoff
**Estimated wall time:** ~5–6 hours (30 teams × 3 seasons for team stats; ~200–300 active starters × 3 seasons for pitcher stats)

### Approach

**Pitcher season stats (season-level FIP, ERA, etc.):**

```
GET /people/{personId}/stats?stats=season&season=2022&group=pitching
```

One call per pitcher per season. Seed player list from `players` table (position = 'P') plus any historical starters not currently in the DB (requires roster backfill pass first).

**Roster backfill (prerequisite for pitcher stats):**

```
GET /teams/{teamId}/roster?season=2022&rosterType=40Man
```

One call per team per season = 30 × 3 = 90 calls. Upsert into `players`.

**Team batting + bullpen (season-level):**

```
GET /teams/{teamId}/stats?stats=season&season=2022&group=hitting
GET /teams/{teamId}/stats?stats=season&season=2022&group=pitching
```

30 teams × 2 groups × 3 seasons = 180 calls.

**Note on rolling-window features:** `starter_fip_last_30`, `bullpen_fip_l14`, `team_wrcplus_l30` are rolling windows computed at feature-build time from per-game pitcher/team logs. This step ingests season-level stats; the rolling windows are feature-engineer responsibility using per-game log data. A separate game-log ingestion pass is needed:

```
GET /people/{personId}/stats?stats=gameLog&season=2022&group=pitching
```

~300 starters × 3 seasons × ~30 starts = ~270,000 rows, but the endpoint batches by player-season (~900 calls at 2 req/sec ≈ 8 minutes).

### Idempotency

Upsert on `(mlb_player_id, season, game_date)` for game logs; upsert on `(mlb_player_id, season)` for season stats. Re-runnable.

### Failure handling

Same as Step 1. Player not found (traded mid-season, retired): log and continue.

---

## Step 3 — The Odds API Historical: Closing Lines 2022-Sep through 2024

**Cost: 45,000 credits one-time (≈ 1% of the 5M monthly tier).**
**Source:** `GET /v4/historical/sports/baseball_mlb/odds`
**Target table:** `odds`
**odds_source tag:** `source = 'odds_api_historical'` (per migration 0027)
**closing_snapshot tag:** `closing_snapshot = true` (per migration 0026)

### Archive cadence

The Odds API stores snapshots at **5-minute intervals** from September 18, 2022 onward. Coverage for this backfill (2022-Sep through 2024) falls entirely within this window.

Closing-snapshot capture strategy: pass `game_time_utc - 5 minutes` as the `date` parameter. The API returns the snapshot closest to and no later than that timestamp — guaranteed to be the last pre-game snapshot for any game with at least a 5-minute betting window before first pitch.

### Call pattern

For each game in the backfilled `games` table:

```
GET /v4/historical/sports/baseball_mlb/odds
  ?apiKey=<THE_ODDS_API_KEY>
  &date=<game_time_utc - 5 minutes, ISO 8601 UTC>
  &regions=us
  &markets=h2h
  &bookmakers=draftkings,fanduel
  &oddsFormat=american
```

One call per game. Response wraps the live-format odds payload with `timestamp`, `previous_timestamp`, and `next_timestamp` metadata fields. Parse the `data` array using the same `OddsApiGame` shape from `apps/web/lib/ingestion/odds/client.ts`.

**h2h only** — run line and totals are out of scope for v0.

### Credit math

4,500 games × 1 call × 10 credits (1 market × 1 region × 10x multiplier) = **45,000 credits total**.
4.94M credits remaining on the $119 tier → **0.9% consumed**. Empty responses do not consume quota.

### Client integration sketch

The existing `fetchMlbOdds` in `client.ts` calls `/sports/baseball_mlb/odds`. The historical variant is a sibling function — same auth pattern, same retry/backoff logic, different base path and an added `date` param:

```typescript
// Sketch only — not yet implemented.
// Add a fetchHistoricalMlbOdds(params: { date: string; bookmakerKeys: string[]; markets?: string[] })
// that calls /v4/historical/sports/baseball_mlb/odds with date in the URL params.
// Reuse fetchWithRetry and the OddsApiGame type unchanged.
// Surface timestamp/previous_timestamp/next_timestamp from the wrapper for audit logging.
```

Full implementation is gated until migrations 0023–0027 land and Kyle re-invokes the engineer.

### Row tagging

Every row written by this step:

```sql
source = 'odds_api_historical'   -- migration 0027
closing_snapshot = true           -- migration 0026
```

### Idempotency

Check `(game_id, sportsbook_id, market_type, closing_snapshot)` uniqueness before insert. Re-running skips games that already have a `closing_snapshot = true` row for both DK and FD.

### Rate limit

The Odds API does not publish a per-second rate limit for the historical endpoint. Start at 5 req/sec; back off on 429. At 5 req/sec, 4,500 calls = 15 minutes pure compute. With pacing overhead and retries: **30–60 minutes total wall time**.

### Failure handling

- 429: log `x-requests-remaining` + `x-requests-used` headers, backoff 60s, retry up to 3 times, then dead-letter to `cron_runs`.
- 5xx: backoff 30s × 3 attempts, then dead-letter.
- Empty response (game not in Odds API archive): record as a gap in `metrics.json`; do not retry indefinitely. Expected for early-September 2022 games near the archive boundary.
- Schema drift in `data` array: the wrapper fields (`timestamp`, `previous_timestamp`, `next_timestamp`) are new vs the live endpoint — parse them separately and log them; a missing wrapper field does not fail the game.

### Coverage output (metrics.json)

```json
{
  "step": "odds_historical",
  "source": "odds_api_historical",
  "retrieval_timestamp": "<ISO UTC>",
  "seasons": [2022, 2023, 2024],
  "games_attempted": <n>,
  "rows_upserted": <n>,
  "games_with_both_dk_fd": <n>,
  "games_missing_close": <gap_count>,
  "coverage_pct": <rows_upserted / (games_attempted * 2) * 100>,
  "credits_consumed": <n>,
  "credits_remaining_after": <from_x_requests_remaining_header>
}
```

### Post-backfill verification query

```sql
-- Closing coverage by sportsbook and season
SELECT
  EXTRACT(YEAR FROM g.game_date)::int AS season,
  b.key AS sportsbook,
  COUNT(DISTINCT o.game_id) AS games_covered
FROM odds o
JOIN games g ON g.id = o.game_id
JOIN sportsbooks b ON b.id = o.sportsbook_id
WHERE o.market_type = 'h2h'
  AND o.closing_snapshot = true
  AND o.source = 'odds_api_historical'
  AND EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
GROUP BY 1, 2 ORDER BY 1, 2;
```

---

## Step 4 — Open-Meteo: Weather Backfill 2022–2024

**Source:** `https://archive-api.open-meteo.com/v1/archive`
**Target table:** `games` (`weather_temp_f`, `weather_wind_mph`, `weather_wind_dir`, `weather_condition`)
**Cost:** Free (no API key required)
**Rate limit:** Open-Meteo public historical archive: **10,000 calls/day** free tier. At ~7,290 games across 3 seasons, the full backfill fits in a single day with ~2,710 calls of headroom. Use 60 req/min (well inside the daily cap). Do not exceed 100 req/min to avoid triggering soft throttling.
**Estimated wall time:** ~2 hours at 60 req/min

**`weather_wind_dir` format:** This step writes numeric degrees (0–360, `winddirection_10m` from Open-Meteo) as a string. Do not apply `degreesToWindDir()` — the live ingester patch (2026-04-30) removed that conversion. Feature construction owns compass/stadium-relative derivation.

### Stadium coordinate requirement

Open-Meteo takes `latitude` and `longitude`, not venue name. A static mapping of 30 MLB stadium coordinates is required. This is a one-time lookup; store as a seed file or in the `teams` table (`venue_lat`, `venue_lon` columns — architect to add if not present).

### Approach

One call per game per venue retrieves hourly data for the game date:

```
GET /archive?latitude={lat}&longitude={lon}&start_date=2023-04-05&end_date=2023-04-05
    &hourly=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code
    &wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC
```

Extract the hour matching `game_time_utc`. Update the `games` row.

### Wind-out computation gap

The research memo references `weather_wind_out_mph` — a "wind blowing out to center" metric. This is not a raw weather column; it requires combining wind speed + wind direction + stadium orientation (facing direction of home plate). Stadium orientation data is not currently stored anywhere. The feature engineer must decide:

- Option A: Use raw `weather_wind_mph` as a proxy (loses directionality).
- Option B: Build a static stadium-orientation lookup and compute a `wind_out_component` at feature construction time.

This decision is out of scope for the backfill runbook; flagged for feature engineer and architect.

### Idempotency

Skip games where `weather_temp_f IS NOT NULL AND weather_wind_dir IS NOT NULL`. Re-running only fills gaps; existing Open-Meteo rows are not overwritten.

### Coverage output (metrics.json contribution)

```json
{ "step": "weather", "rows_updated": <n>, "rows_skipped_already_present": <n>,
  "null_rate_pct": <nulls/total*100>, "rate_limit_calls_used": <n>,
  "rate_limit_daily_cap": 10000, "headroom": <10000 - n> }
```

### Failure handling

- Non-200 response: retry once after 10s, then log and leave `NULL`. NULL weather is acceptable for training (impute with median at feature-build time).
- Daily call cap approach (>8,000 calls): pause and resume the next day. The idempotency logic above means a resume picks up where it left off.

---

## Step 5 — MLB Stats API: Lineup Backfill 2022–2024

**BLOCKED pending architect adding `lineup_entries.pinned_at TIMESTAMPTZ NOT NULL` (migration 0025 or 0026).**

**Source:** MLB Stats API boxscore endpoint (for confirmed post-game lineups)
**Target table:** `lineup_entries`
**Cost:** Free
**Estimated wall time:** ~6 hours (2,430 games × 3 seasons, 2 API calls per game)

### Note on T-60min pin for historical data

MLB Stats API does not store "what the lineup looked like at T-60min" for historical games — it stores the actual batting order from the boxscore. For training data purposes, the boxscore lineup is acceptable (it is the actual lineup that played). The T-60min pin requirement applies to serve-time feature construction, not historical training data. This distinction must be documented in `architecture.md` for the v0 artifact.

### Approach

```
GET /game/{gamePk}/boxscore
```

Parse `teams.home.batters` / `teams.away.batters` in batting order. Insert 9 home + 9 away rows per game. Set `confirmed = TRUE`, `pinned_at = game_time_utc - interval '60 minutes'` (approximate; acceptable for training data).

### Idempotency

Upsert on `(game_id, player_id, side)`. Re-runnable. Skip games where ≥ 18 lineup entries already exist for that game.

### Expected row count

~2,430 games × 3 seasons × 18 lineup slots = ~131,220 `lineup_entries` rows.

### Coverage output (metrics.json contribution)

```json
{ "step": "lineups", "rows_upserted": <n>, "games_with_full_lineup": <n>,
  "coverage_pct": <n/7290*100>, "gaps": [] }
```

---

## Execution Order and Dependency Chain

**Pre-condition:** Migrations 0023, 0024, 0025, 0026, 0027 confirmed applied. Do not start Step 1 before this check passes.

```
[migration gate: 0023/0024/0025/0026/0027 confirmed]
  └─► Step 1 (games schedule — 2022–2024, ~25 min)
        └─► Step 2 (pitcher/team stats — needs gamePk FK, ~5–6 hours)
        └─► Step 3 (Odds API historical closing lines — needs game_time_utc, ~30–60 min)
        └─► Step 4 (Open-Meteo weather — needs game_time_utc + venue, ~2 hours)
        └─► Step 5 (lineups — needs game_id FK + migration 0025/0026, ~6 hours)
```

Steps 2, 3, 4, 5 can all run in parallel after Step 1 completes.

**Total estimated wall time (parallel execution):** ~8 hours (bottleneck = Step 2 pitcher logs).

---

## Go/No-Go Checklist

- [ ] Migrations 0023, 0024, 0025, 0026, 0027 confirmed applied
- [ ] Step 1 complete: `games` rows exist for 2022–2024 with `game_time_utc` populated
- [ ] `THE_ODDS_API_KEY` confirmed set in environment; credits balance confirmed ≥ 50,000 before run
- [ ] `odds.source` column confirmed present (migration 0027); if absent, flag to mlb-architect before writing any odds rows
- [ ] `odds.closing_snapshot` column confirmed present (migration 0026); if absent, do not proceed with Step 3
- [ ] `games.divisional_flag` column availability checked; if absent, note per-cluster audit limitation in metrics.json
- [ ] Dry-run (single 2023 game) confirms field mapping, source tag, and closing_snapshot tag before full run

**Odds API credits consumed by this backfill: 45,000 (≈ 0.9% of 5M monthly tier).**

---

## Post-Backfill Verification Queries

After each step, run:

```sql
-- Games per season (expect ~2,430 per season 2022–2024; 2021 not ingested)
SELECT EXTRACT(YEAR FROM game_date)::int AS season, COUNT(*) FROM games
WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
GROUP BY 1 ORDER BY 1;

-- Lineup coverage (after Step 5)
SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
       COUNT(DISTINCT g.id) AS total_games,
       COUNT(DISTINCT le.game_id) AS games_with_lineups,
       ROUND(100.0 * COUNT(DISTINCT le.game_id) / COUNT(DISTINCT g.id), 1) AS pct
FROM games g
LEFT JOIN (
  SELECT game_id FROM lineup_entries GROUP BY game_id
  HAVING COUNT(*) >= 18
) le ON le.game_id = g.id
WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
GROUP BY 1 ORDER BY 1;

-- Odds closing coverage by source and sportsbook (after Step 3)
SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
       o.source,
       b.key AS sportsbook,
       COUNT(DISTINCT o.game_id) AS games_covered
FROM odds o
JOIN games g ON g.id = o.game_id
JOIN sportsbooks b ON b.id = o.sportsbook_id
WHERE o.market_type = 'h2h'
  AND o.closing_snapshot = true
  AND EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- Weather coverage and wind_dir format check (after Step 4)
-- All wind_dir values should be numeric strings '0'–'360'
SELECT
  COUNT(*) FILTER (WHERE weather_wind_dir IS NOT NULL) AS wind_dir_populated,
  COUNT(*) FILTER (WHERE weather_wind_dir ~ '^[0-9]+$') AS wind_dir_numeric,
  COUNT(*) FILTER (WHERE weather_wind_dir !~ '^[0-9]+$' AND weather_wind_dir IS NOT NULL) AS wind_dir_bad_format
FROM games
WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024;

-- Verify no field-relative MLB strings remain in wind_dir
SELECT weather_wind_dir, COUNT(*) FROM games
WHERE weather_wind_dir ILIKE '%CF%'
   OR weather_wind_dir ILIKE '%LF%'
   OR weather_wind_dir ILIKE '%RF%'
   OR weather_wind_dir IN ('N','NE','E','SE','S','SW','W','NW')
GROUP BY 1;
-- Expected: zero rows
```
