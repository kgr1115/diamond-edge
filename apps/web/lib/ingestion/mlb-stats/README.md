# MLB Stats API Ingestion

## Source Summary

| Field | Value |
|---|---|
| Provider | MLB Stats API (free, public, no auth) |
| Base URL | `https://statsapi.mlb.com/api/v1` (overridable via `MLB_STATS_API_BASE` env var) |
| Auth | None required |
| Rate limit | Undocumented; courtesy cap of 60 req/min observed |
| Key endpoint | `/schedule?sportId=1&date=YYYY-MM-DD&hydrate=team,venue,probablePitcher(note),weather,linescore` |

## Ingestion Components

| File | Purpose | Cadence |
|---|---|---|
| `schedule.ts` | Today + tomorrow games → `games` upsert | 2×/day via Vercel Cron |
| `rosters.ts` | All 30 teams + active rosters → `teams`, `players` upsert | 1×/day via Supabase Edge Function |
| `box-scores.ts` | Live + final scores → `games` update | Every 5 min during live window; once post-game nightly |

## Rate Limit Envelope

| Operation | Calls per run | Daily calls | Monthly calls |
|---|---|---|---|
| Schedule sync (2 dates) | 1 | 2 | 60 |
| Roster sync (1 teams + 30 rosters) | 31 | 31 | 31 (daily) |
| Box score sync (during game window ~4h) | 1/call | ~48 | ~1,440 |
| **Total** | — | **~81** | **~1,531** |

No monthly cap on MLB Stats API — these numbers are for internal tracking only.

## Freshness SLA

| Data | Freshness | Acceptable Stale |
|---|---|---|
| Game schedule (status, venue, pitchers) | Updated 2×/day | Up to 12 hours for non-score fields |
| Live scores (inning, score) | Updated every 5 min | 5 minutes during live games |
| Final scores | Updated by 4am ET next day | ≤ 12 hours post-game end |
| Team metadata | Updated daily | 24 hours |
| Roster (active players) | Updated daily | 24 hours |

## Failure Modes

| Failure | Handling |
|---|---|
| HTTP 5xx | Retry 3× with exponential backoff (1s, 2s, 4s). Log each attempt. |
| HTTP 429 (unexpected) | 30s backoff, then retry. Log. |
| Network error | Same retry as 5xx. |
| Game missing from DB | Box-score sync skips — schedule sync must run first. |
| Team missing from DB | Schedule sync creates a minimal stub record. Roster sync fills in full metadata. |
| Pitcher missing from DB | Schedule sync creates a minimal stub (position = 'SP'). Roster sync corrects. |

## Key Design Notes

- **One schedule call covers all games for a date** — no per-game calls for schedule or box scores.
- **Weather from schedule hydration** — `?hydrate=weather` returns MLB's weather feed for same-day games. Tomorrow's games without weather fall back to Open-Meteo (see `weather/` module).
- **UTC everywhere** — `game.gameDate` from the MLB API is already UTC with 'Z' suffix. `game_time_utc` stores it as-is. `game_date` is the UTC date slice (`YYYY-MM-DD`). No timezone conversion.
- **Doubleheader awareness** — `game.gameNumber` (1 or 2) is present in the schedule response. The `mlb_game_id` (gamePk) is unique per game including doubleheaders.
