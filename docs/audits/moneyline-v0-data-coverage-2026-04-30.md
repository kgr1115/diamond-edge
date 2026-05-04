# Moneyline v0 — Data Coverage Audit

**Date:** 2026-04-30  
**Author:** mlb-data-engineer  
**Scope:** Pre-backfill coverage assessment for 2021–2024 regular seasons. Read-only. No API credits spent.

---

## 1. `lineup_entries` Coverage

### Current state

| Season | Games in `games` | Games w/ 9+ home + 9 away entries (T-60 pin) | Coverage % |
|--------|-----------------|----------------------------------------------|------------|
| 2021   | 0               | 0                                             | —          |
| 2022   | 0               | 0                                             | —          |
| 2023   | 0               | 0                                             | —          |
| 2024   | 0               | 0                                             | —          |
| 2026   | 100             | 0                                             | 0%         |

The `games` table contains only 2026 data (100 games, 2026-04-23 through 2026-04-30). The `lineup_entries` table has 0 rows across all seasons. The full 2021–2024 game schedule and lineup backfill are both absent.

### Schema gap

`lineup_entries` has no `pinned_at` or `snapshot_time` column — only `updated_at`. The T-60min pin requirement (serve-time join key) cannot be enforced or audited with the current schema. A `pinned_at TIMESTAMPTZ` column is required before lineup backfill is meaningful for the v0 feature build.

### Gating decision

**2021 inclusion: CANNOT EVALUATE — data absent.**  
Default verdict per CSO/CEng conditions: **DROP-2021**. The coverage gate (≥ 95% on serve-time join keys) cannot be cleared until:
1. `games` is backfilled for 2021–2024.
2. `lineup_entries` gains a `pinned_at` column (architect change).
3. MLB Stats API historical lineup pull executes for 2021–2024.

Even if all three happen, CSO/CEng both set DROP-2021 as the default. Include 2021 only if coverage comes back ≥ 95% and the architect signs off on the schema addition.

---

## 2. Closing-Odds Backfill Audit

### Current state

There is no separate `odds_history` or `live_odds` table. Closing lines would live in the `odds` table alongside live snapshots, distinguished by `snapshotted_at`. No `is_closing` flag exists on the current schema.

| Season | Games in DB | Games w/ DK close | Games w/ FD close | Games w/ both | Coverage % | Gap count |
|--------|------------|-------------------|-------------------|---------------|------------|-----------|
| 2021   | 0          | 0                 | 0                 | 0             | —          | ~2,430    |
| 2022   | 0          | 0                 | 0                 | 0             | —          | ~2,430    |
| 2023   | 0          | 0                 | 0                 | 0             | —          | ~2,430    |
| 2024   | 0          | 0                 | 0                 | 0             | —          | ~2,430    |
| 2026   | 100        | 79                | 79                | 79            | 79%        | 21        |

2026 coverage at 79% is expected — games still in-progress or future-scheduled at time of last pull.

### 2021 Odds API historical-pull cost estimate

The Odds API historical endpoint `/v4/historical/sports/{sport}/odds` costs **10 credits per call** (1 market × 1 region).

Assumptions for 2021 regular season backfill (DK + FD, moneyline only):
- ~2,430 regular-season games
- 1 closing-line snapshot per game (one call captures all books at a given timestamp)
- Market: `h2h` (moneyline) = 1 market
- Regions: `us` = 1 region

The historical `/odds` endpoint returns all books at a given timestamp in a single call — you do not need one call per book. One call per game date captures all books simultaneously.

**Per-game-date approach:** ~162 regular-season game-days in 2021. One call per date = 162 calls × 10 credits = **1,620 credits**.

However, to get a true closing snapshot for each individual game (games end at different times), the safer approach is one call per game at its approximate end time: 2,430 calls × 10 credits = **24,300 credits**.

| Approach | Calls | Credits | % of 100K tier | Monthly $ impact |
|----------|-------|---------|-----------------|------------------|
| Per game-date (162 dates) | 162 | 1,620 | 1.6% | One-time, within tier |
| Per game (2,430 games) | 2,430 | 24,300 | 24.3% | One-time, within tier |

The 100K/month tier is $59/mo (project uses entry tier at ~$79/mo with the 100K plan as of CLAUDE.md). Either approach fits inside the hard cap. The per-game approach is recommended for accuracy; it consumes 24,300 credits of 100K in the pull month, leaving 75,700 credits for that month's regular polling.

**Note:** Odds API historical snapshots are available only post-September 2022 per their documentation ("snapshots taken at 5-minute intervals post-September 2022"). **2021 and most of 2022 pre-September fall outside the Odds API historical snapshot window.** This means The Odds API cannot supply 2021 closing odds regardless of credit budget. This is a hard source-availability block, not a cost block.

For 2022 (September onward), 2023, and 2024, closing odds via Odds API historical snapshots are feasible.

**Revised recommendation:** 2021 closing odds from The Odds API = **unavailable**. 2022 (full season) = partially unavailable (pre-September coverage absent). 2023–2024 = available at ~16,200–19,440 credits per season (per-game approach, ~1,620–1,944 games with post-September-2022 snapshot coverage). All within tier.

---

## 3. Other-Source Coverage (Free APIs)

### MLB Stats API — pitcher and team game logs

| Source | Coverage 2022–2024 | Notes |
|--------|-------------------|-------|
| `pitcher_season_stats` | 2026 only (48 rows) | No historical seasons backfilled |
| `team_batting_stats` | 2026 only (30 rows) | No historical seasons backfilled |
| `bullpen_team_stats` | 2026 only (30 rows) | No historical seasons backfilled |
| `games` (schedule) | 2026 only (100 rows) | Full 2021–2024 schedule absent |

MLB Stats API is free and rate-limit-generous (~600 calls/min per unofficial community observation). All 2022–2024 historical data is fetchable at no cost. This is a backfill execution gap, not a data-availability gap.

Features blocked without this backfill: `starter_fip_home/away`, `starter_days_rest_home/away`, `bullpen_fip_l14_home/away`, `team_wrcplus_l30_home/away`, `b2b_flag_home/away`. That is 9 of 12 v0 features. **The MLB Stats API backfill is the critical-path blocker for v0.**

### Baseball Savant / Statcast

Not required for v0 per research memo. No action needed.

### Open-Meteo — weather columns

`games` has `weather_temp_f` and `weather_wind_mph` (not `weather_wind_out_mph` — the research memo uses a slightly different column name; confirm with architect). Current fill rate on 2026 games: **13%** (13/100 games). Backfill pull rate is low, likely because the weather ingestion job only runs prospectively.

Open-Meteo historical API (`archive-api.open-meteo.com`) is free with no key required. Historical re-pulls require latitude/longitude per stadium, not per game. Stadium coordinates for 30 MLB venues are a one-time static lookup.

Note: `weather_wind_out_mph` does not exist as a column — the actual column is `weather_wind_mph`. Wind direction is `weather_wind_dir` (text, not numeric). Computing "wind blowing out" requires combining `weather_wind_mph` + `weather_wind_dir` + stadium orientation. Stadium orientation is not in any current table. This is a schema/data gap the feature engineer needs to flag.

### 2022–2024 backfill gaps blocking v0

| Feature | Source | Status | Blocking? |
|---------|--------|--------|-----------|
| `market_log_odds_home` | Odds API historical | 2023–2024 fetchable; 2022-Sep+ fetchable; pre-Sep 2022 unavailable | Yes — 2022 partial |
| `starter_fip_home/away` | MLB Stats API game logs | Not backfilled | Yes |
| `starter_days_rest_home/away` | MLB Stats API schedules | Not backfilled | Yes |
| `bullpen_fip_l14_home/away` | MLB Stats API game logs | Not backfilled | Yes |
| `team_wrcplus_l30_home/away` | MLB Stats API team logs | Not backfilled | Yes |
| `park_factor_runs` | Static table | Not present in schema | Yes — needs architect |
| `weather_temp_f` | Open-Meteo historical | 87% missing on current games; backfillable | Yes |
| `weather_wind_out_mph` | Open-Meteo + stadium orientation | Column name mismatch; stadium orientation absent | Yes — schema gap |
| `b2b_flag_home/away` | Derived from `games` schedule | Games table empty 2022–2024 | Yes |
| `home_field` | Derived from `games` schema | Games table empty 2022–2024 | Yes |

---

## 4. Backfill Plan Summary

See `docs/runbooks/moneyline-v0-backfill-plan.md` for step-by-step execution with rate-limit details and wall-time estimates.

### Priority order

1. **MLB Stats API — games schedule 2021–2024** (free, ~4 hours, unblocks everything downstream)
2. **MLB Stats API — pitcher game logs + team game logs 2021–2024** (free, ~6 hours)
3. **Odds API historical — closing lines 2023–2024** (paid, ~19,440 credits, fits within tier)
4. **Open-Meteo — weather backfill 2022–2024** (free, ~2 hours, requires stadium coordinate table)
5. **lineup_entries — MLB Stats API historical lineups 2022–2024** (free, ~8 hours, **requires architect to add `pinned_at` column first**)

2021 closing odds via Odds API: **unavailable** — historical snapshots do not exist for that period. 2021 inclusion in training is blocked on both lineup coverage AND closing-odds availability. Default per CSO/CEng: **DROP-2021**.

---

## Schema Issues Requiring Architect Action Before Backfill

1. `lineup_entries` needs `pinned_at TIMESTAMPTZ NOT NULL` to support T-60min serve-time join.
2. `park_factor_runs` static table does not exist — needs design + migration.
3. `weather_wind_out_mph` feature name in the research memo does not match actual column `weather_wind_mph` + `weather_wind_dir`. Feature engineer and architect need to align on how "wind out" is computed and whether a derived column or runtime computation is the right approach.
4. `odds` table has no `is_closing` flag — closing-line identification relies on `snapshotted_at` proximity to `game_time_utc`. This is workable but fragile; recommend architect adds a `closing_snapshot BOOLEAN DEFAULT FALSE` flag to `odds`.
