# Historical Odds Backfill

One-time script to pull historical MLB odds from The Odds API for the 2022, 2023, and 2024 seasons. Output feeds the ML engineer's EV calibration backtest.

## Scope

| Season | Date range | Notes |
|--------|-----------|-------|
| 2022 | 2022-04-07 – 2022-11-05 | Opening Day through WS Game 6 cushion |
| 2023 | 2023-03-30 – 2023-11-02 | Opening Day through WS |
| 2024 | 2024-03-28 – 2024-10-31 | Opening Day through WS (ended Oct 30) |

All-Star break dates (no regular-season games) are skipped via static list — avoids burning credits on known-empty days.

## Credit Budget

- Cost: 30 credits/call (historical 10× multiplier × 3 markets)
- Estimated calls: ~545 (total game days across 3 seasons minus All-Star breaks)
- Estimated credit spend: ~16,350 credits of 100,000/month available
- Safety guardrail: script aborts if X-Requests-Remaining drops below 5,000

## Output

```
data/historical-odds/
  2022/
    2022-04-07.json
    2022-04-08.json
    ...
  2023/
    ...
  2024/
    ...
```

Each file is the raw JSON response from The Odds API historical endpoint:

```json
{
  "timestamp": "2022-04-08T03:00:00Z",
  "previous_timestamp": "...",
  "next_timestamp": "...",
  "data": [
    {
      "id": "...",
      "sport_key": "baseball_mlb",
      "commence_time": "2022-04-07T23:10:00Z",
      "home_team": "New York Yankees",
      "away_team": "Boston Red Sox",
      "bookmakers": [
        {
          "key": "draftkings",
          "title": "DraftKings",
          "last_update": "...",
          "markets": [
            { "key": "h2h", "outcomes": [...] },
            { "key": "spreads", "outcomes": [...] },
            { "key": "totals", "outcomes": [...] }
          ]
        },
        { "key": "fanduel", ... }
      ]
    }
  ]
}
```

The `data/` directory is gitignored. Files stay on disk only.

## Snapshot Time Rationale

Each date's snapshot is requested at `03:00 UTC` the following day (= 23:00 EDT). This approximates closing lines — the gold-standard training signal for EV calibration. All timestamps are UTC.

## Usage

From this directory (or repo root using the path):

```bash
# 1. Install deps
npm install

# 2. Run test call only — verifies response shape and credit cost, does not start backfill
npm test
# or: npx tsx run.ts --test-only

# 3. Full run (test call + 5s pause + backfill)
npm run backfill:full
# or: npx tsx run.ts

# 4. Skip test call (re-runs / resuming after interruption)
npm run backfill
# or: npx tsx run.ts --skip-test
```

The script uses `THE_ODDS_API_KEY` from the repo-root `.env`. It does NOT require running from `apps/web/`.

## Idempotency

If `data/historical-odds/<year>/<YYYY-MM-DD>.json` already exists and contains a populated `.data` array, the date is skipped. Safe to re-run after interruptions at zero extra credit cost for already-fetched dates.

## Failure Modes

| Error | Behavior |
|-------|----------|
| HTTP 429 | Exponential backoff 2s→60s, up to 6 retries. Logs `retry-after` header. |
| HTTP 5xx | Exponential backoff 2s→60s, up to 6 retries. Continues to next date on exhaustion. |
| HTTP 4xx (non-429) | Immediate abort — caller error, fix before re-running. |
| Network error | Retry with backoff. Continues on exhaustion (logs error). |
| Credits < 5,000 | Hard abort with message. Resume after credit reset with `--skip-test`. |

## ML Engineer Notes

- Field `data[].bookmakers[].markets[].outcomes[].price` is American odds (integer).
- Field `data[].bookmakers[].markets[].outcomes[].point` is the spread/total line (float).
- `data[].commence_time` is UTC ISO 8601 — use this for game matching, not local time.
- `data[].home_team` / `data[].away_team` are full team names (e.g., "New York Yankees").
  Map to your internal team keys before joining with MLB Stats API data.
- Each file is a single JSON object (not JSONL). Parse with `JSON.parse(fs.readFileSync(...))`.
- Empty `data` arrays mean no MLB games were scheduled that day — skip in feature pipeline.
- The `timestamp` field in the response shows the actual snapshot time returned by the API,
  which may differ slightly from the requested date. Use it for provenance, not as the game time.
