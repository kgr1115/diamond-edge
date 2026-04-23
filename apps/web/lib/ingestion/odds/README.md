# Odds Ingestion — The Odds API

## Source Summary

| Field | Value |
|---|---|
| Provider | The Odds API |
| Endpoint | `GET /v4/sports/baseball_mlb/odds` |
| Markets | `h2h` (moneyline), `spreads` (run line), `totals` |
| Books | Driven by `sportsbooks` table — currently DraftKings + FanDuel |
| Auth | `ODDS_API_KEY` env var (query param per Odds API spec) |
| Response | All MLB games + all requested markets + all requested books in **one call** |

## Rate-Limit Envelope

| Metric | Value |
|---|---|
| API tier | Entry tier (~$79/mo) |
| Requests per call | 1 (single `/odds` endpoint fetches all games) |
| Max daily (season) | ~20 calls/day |
| Max monthly (season) | ~600 calls/month |
| Max monthly (off-season) | ~60 calls/month |
| Requests remaining | Logged from `x-requests-remaining` response header after every call |
| Budget alert threshold | Log error when `requestsRemaining < 50` |

Full budget analysis: `docs/ingestion/rate-limit-budget.md`

## Polling Cadence

Controlled by Vercel Cron in `vercel.json` (configured by DevOps, TASK-006).

| Condition | Cadence | Rationale |
|---|---|---|
| Games starting within 3 hours | Every 30 min | Lines move most pre-game |
| Games starting 3–24 hours out | Every 2 hours | Moderate staleness acceptable |
| No games today / off-season | Twice a day | Schedule check; conserves quota |

Recommended Vercel Cron expression (DevOps configures):
- `0,30 * * * *` — every 30 min (cron handler decides internally whether to actually poll)

The cron handler checks the earliest game start time against `POLL_CADENCE` thresholds before calling the Odds API. This keeps the cron schedule simple (`*/30`) while the actual API call budget stays within limits.

## Cache Policy

| Key Pattern | TTL | Invalidation Trigger |
|---|---|---|
| `de:odds:game:{game_id}` | 600s (10 min) | After each successful odds write, the cron handler calls `cacheInvalidate(CacheKeys.oddsGame(gameId))` for every affected game |

The 10-min TTL is shorter than the 30-min polling cadence — once the cache expires, the next API request will always serve fresh data from the `odds` table (latest snapshot via `snapshotted_at DESC`).

## Freshness SLA

- **Pre-game (< 3h to first pitch):** Lines are at most 30 minutes stale.
- **Near-game (3–24h out):** Lines are at most 2 hours stale.
- **Pick pipeline:** The ML model reads `odds` at pick-generation time (1–2x/day). With 30-min polls pre-game, the best available line used for EV calculation is at most 30 minutes old when picks are generated.

## Failure Modes

| Failure | Handling |
|---|---|
| HTTP 429 (rate limited) | Log with `x-requests-remaining` / `x-requests-used` context. Retry after `Retry-After` header value (capped at 120s). |
| HTTP 5xx | Retry up to 3 times with exponential backoff (1s, 2s, 4s). Log each attempt. |
| Network error | Same retry as 5xx. |
| HTTP 4xx (not 429) | No retry — likely a misconfigured API key or invalid parameter. Throw immediately. |
| Game not found in DB | Log unmatched Odds API game IDs with a hint (`schedule sync may not have run`). Skip — do not insert orphaned odds. |
| DB insert failure | Log per-batch error. Continue remaining batches. Return partial success with `errors[]` in result. |
| `ODDS_API_KEY` missing | Throw on first call. Cron handler catches and returns 500. |

## Data Model Notes

- `odds` table is **append-only** — each poll inserts new rows, never overwrites.
- "Latest odds" queries use `ORDER BY snapshotted_at DESC` with `DISTINCT ON (game_id, sportsbook_id, market)`.
- `snapshotted_at` is set once per poll run (UTC), applied uniformly to all rows in that batch — do not use `bookmaker.last_update` from the Odds API response (it may reflect the book's server time, not our poll time).
- Adding a new sportsbook: `INSERT INTO sportsbooks (key, name) VALUES ('newbook', 'New Book')`. No code change needed. On the next poll run, the new key is included automatically.
