# Historical Odds Backfill

Scripts to pull historical MLB odds from The Odds API for the 2022, 2023, and 2024 seasons. Output feeds the ML engineer's EV calibration backtest and B2 delta model.

## Scripts

| Script | File | Purpose |
|--------|------|---------|
| `run.ts` | Evening snapshots | 03:00 UTC next day (~23:00 EDT) — closing-line proxy. **Already complete.** |
| `run-morning-afternoon.ts` | Morning + afternoon snapshots | 14:00 UTC (10 AM EDT) + 19:00 UTC (3 PM EDT) per game day. Feeds B2 delta model opening-line priors. |

## Scope

| Season | Date range | Notes |
|--------|-----------|-------|
| 2022 | 2022-04-07 – 2022-11-05 | Opening Day through WS Game 6 cushion |
| 2023 | 2023-03-30 – 2023-11-02 | Opening Day through WS |
| 2024 | 2024-03-28 – 2024-10-31 | Opening Day through WS (ended Oct 30) |

All-Star break dates (no regular-season games) are skipped via static list — avoids burning credits on known-empty days. Days where the existing evening snapshot has zero games are also skipped.

## Snapshot Times

| Slot | UTC time | ET time | Signal |
|------|----------|---------|--------|
| Morning | 14:00 same day | 10:00 AM EDT | Opening-prior proxy — before lineup reveals |
| Afternoon | 19:00 same day | 3:00 PM EDT | Pre-game — lineups mostly locked |
| Evening | 03:00 next day | 11:00 PM EDT | Closing-line proxy — already fetched by `run.ts` |

All times UTC. MLB season runs entirely under EDT (UTC-4) in the morning/afternoon window.

## Credit Budget

### Evening (run.ts — complete)
- Cost: 30 credits/call
- Calls: ~637 (game days with data across 3 seasons)
- Spend: ~19,110 credits

### Morning + Afternoon (run-morning-afternoon.ts)
- Cost: 30 credits/call × 2 slots per day
- Game days with data: 637
- Projected calls: ~1,274
- Projected credits: ~38,220
- Budget ceiling check: script aborts if projected > 40,000 credits before making any call
- Runtime guardrail: aborts if X-Requests-Remaining drops below 40,000 (preserves live-ingestion headroom)

## Output

```
data/historical-odds/          # Evening snapshots (existing, do not modify)
  2022/YYYY-MM-DD.json
  2023/YYYY-MM-DD.json
  2024/YYYY-MM-DD.json

data/historical-odds-morning/  # Morning snapshots (run-morning-afternoon.ts)
  2022/YYYY-MM-DD.json
  2023/YYYY-MM-DD.json
  2024/YYYY-MM-DD.json

data/historical-odds-afternoon/  # Afternoon snapshots (run-morning-afternoon.ts)
  2022/YYYY-MM-DD.json
  2023/YYYY-MM-DD.json
  2024/YYYY-MM-DD.json
```

Each file is the raw API response (with in-game sentinel outcomes stripped — see below), identical shape:

```json
{
  "timestamp": "2022-04-07T14:00:00Z",
  "previous_timestamp": "...",
  "next_timestamp": "...",
  "data": [ ... ]
}
```

The `data/` directory is gitignored. Files stay on disk only.

## In-Game Contamination Guard

`run-morning-afternoon.ts` applies the same h2h sentinel filter as `load_historical_odds.py` (commit 49756e2) **at fetch time**, before writing to disk:

- Any h2h outcome where `abs(price) > 500` is stripped from the outcome list.
- Pre-game MLB moneylines are always within ±500; prices outside that range indicate live in-game lines.
- Contamination risk by slot:
  - Morning (14:00 UTC): prior-day day games that ran late may produce in-game lines for games on the preceding calendar day.
  - Afternoon (19:00 UTC): late-afternoon day games starting 3–4 PM EDT may be live at snapshot time.
- Count of removed outcomes is logged as structured JSON per snapshot for auditing.

## Usage

From this directory:

```bash
# Install deps (once)
npm install

# --- Evening backfill (run.ts) ---
npm test                  # Test call only
npm run backfill:full     # Test + 5s pause + full run
npm run backfill          # Skip test (resume after interruption)

# --- Morning + afternoon backfill (run-morning-afternoon.ts) ---
npm run backfill:morning-afternoon        # Pre-estimate + 5s pause + full run
npm run backfill:morning-afternoon:now    # Skip 5s pause (--skip-precheck)
# or directly:
npx tsx run-morning-afternoon.ts
npx tsx run-morning-afternoon.ts --skip-precheck
```

The script uses `THE_ODDS_API_KEY` from the repo-root `.env`.

## Idempotency

Both scripts skip any date where the target file already exists. Safe to re-run after interruptions at zero extra credit cost for already-fetched dates.

`run-morning-afternoon.ts` also skips any date where the evening snapshot file has an empty `data` array — no games played, no point fetching other slots.

## Failure Modes

| Error | Behavior |
|-------|----------|
| HTTP 429 | Exponential backoff 2s→60s, up to 6 retries. Logs `retry-after` header. |
| HTTP 5xx | Exponential backoff 2s→60s, up to 6 retries. Continues to next slot on exhaustion. |
| HTTP 4xx (non-429) | Immediate abort — caller error, fix before re-running. |
| Network error | Retry with backoff. Continues on exhaustion (logs error). |
| Credits < 40,000 | Hard abort with message. Resume with `--skip-precheck` after assessing headroom. |
| Projected cost > 40,000 | Pre-run abort. Requires explicit approval to override. |

## ML Engineer Notes

### Column naming convention for multi-snapshot parquet rebuild

When `load_historical_odds.py` is extended to read all three directories, use this column naming:

```
dk_ml_home_morning     dk_ml_away_morning
dk_ml_home_afternoon   dk_ml_away_afternoon
dk_ml_home_evening     dk_ml_away_evening   (current default columns)
fd_ml_home_morning     ...
```

Pattern: `{book}_{market}_{side}_{slot}` — slot suffix disambiguates snapshot time.

### Other notes

- `data[].bookmakers[].markets[].outcomes[].price` — American odds (integer).
- `data[].bookmakers[].markets[].outcomes[].point` — spread/total line (float).
- `data[].commence_time` is UTC ISO 8601 — use for game matching, not local time.
- `data[].home_team` / `data[].away_team` are full team names. Map via `team_map.ODDS_NAME_TO_ABBR`.
- Each file is a single JSON object (not JSONL). Parse with `JSON.parse(...)`.
- Empty `data` arrays mean no MLB games that day — skip in feature pipeline.
- The `timestamp` field shows the actual snapshot time returned by the API; use for provenance, not game time.
