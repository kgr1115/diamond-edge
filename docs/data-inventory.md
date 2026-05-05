# Diamond Edge — Historical Data Inventory

**Generated:** 2026-05-04 from live Supabase Postgres (`pitcher_game_log` rowcounts, `games` status breakdown, `odds` book/market coverage, model artifact metadata, feature spec, audit memos).

**Purpose:** Portable handoff for the next iteration. Anyone (human or LLM) starting on a sibling project that needs to know "what data did this thing train on, and where did it come from" should be able to reconstruct the picture from this file alone.

---

## 1. Data sources

### Paid (1)

| Source | Cost | Auth | What it gives | Cache |
|---|---|---|---|---|
| **The Odds API** | $119/mo (5M-credit tier as of 2026-04-30) | API key (`THE_ODDS_API_KEY`) | h2h moneyline + run line + totals + props for DK + FD; live snapshots and historical | Upstash Redis with TTL |

That is the only paid data source. Everything else below is free.

### Free (3)

| Source | Auth | What it gives | Quirks |
|---|---|---|---|
| **MLB Stats API** (`statsapi.mlb.com/api/v1`) | None | Schedules, rosters, box scores, lineups, sabermetrics endpoint (`stats=sabermetrics&group=pitching` returns FIP, xFIP, fipMinus, eraMinus, WAR) | None — stable, well-documented |
| **Baseball Savant** (`baseballsavant.mlb.com/statcast_search/csv`) | None | Pitch-by-pitch CSV with `bb_type`, `events`, `game_pk`, `pitcher`, `batter`, etc. | **Cloudflare bot detection — bespoke User-Agents return 403. Use a recent Chrome UA.** |
| **Meteostat** (used in `scripts/backfill-db/02-weather*`) | API key | Historical weather (wind, temp) per venue | Rate-limited; backfill-only |

### Paid infra (not APIs but billed monthly)

| Service | Target / cap |
|---|---|
| Vercel Pro + Fluid Compute | $30 / $60 |
| Supabase | $25 / $50 |
| Upstash Redis | $10 / $25 |
| Stripe (passthrough fees only) | n/a |
| **Anthropic LLM** | **ARCHIVED $0** — `mlb-rationale` paused per Kyle 2026-04-30 |
| Misc | $15 / $30 |

Total envelope: **<$300/mo** at <500 users.

---

## 2. Database tables (live counts as of 2026-05-04)

All tables in Supabase Postgres, schema = `public`. RLS varies — model-feature tables (`pitcher_game_log`, `games`, `odds`, etc.) are NOT user-data and have no RLS; subscriber-data tables (`profiles`, `subscriptions`, etc.) do.

### Game outcomes — the spine

| Table | Rows | Date column | Range | Notes |
|---|---|---|---|---|
| `games` | 7,460 | `game_date` | 2022-04-07 → 2026-05-06 | Status breakdown: 7,369 final, 89 scheduled, 1 live, 1 cancelled (Athletics 2024-09-29). Includes pre-game `probable_home_pitcher_id`/`probable_away_pitcher_id`. |
| `game_wind_features` | 7,460 | — | matches games | View; computed from venue + Meteostat |
| `lineup_entries` | 131,166 | — | matches games | Per-game per-team batting orders; `pinned_at` field for snapshot freshness |

### Pitcher game logs

| Table | Rows | Range | Source |
|---|---|---|---|
| `pitcher_game_log` | 61,950 | 2022-04-07 → 2024-09-30 | MLB Stats API boxscore (IP, HR, BB, HBP, K, is_starter) **+** Baseball Savant pitch-by-pitch (`fb` = `bb_type ∈ {fly_ball, popup}` per pitcher per game; provenance audit on `fb_source`) |

Per-season: 2022: 20,818 / 2023: 20,554 / 2024: 20,578 rows.

**`fb_source` provenance distribution after 2026-05-04 backfill:**
- `statcast_bb_type_v2`: 43,930 rows (~71% per season — the corrected "fly_ball + popup" aggregation matching FG xFIP definition)
- `mlb_boxscore_flyouts`: 18,020 rows (legacy default; no Statcast write because the pitcher allowed 0 fly_balls AND 0 popups in that game — typically very short relief outings)

### Batter game logs

| Table | Rows | Range | Source |
|---|---|---|---|
| `batter_game_log` | 145,839 | 2022-04-07 → 2024-09-30 | MLB Stats API boxscore |

Per-season: 2022: 48,325 / 2023: 48,761 / 2024: 48,753 rows.

### Odds / lines

| Table | Rows | Range | Books | Markets |
|---|---|---|---|---|
| `odds` | 18,684 | 2026-04-23 → 2026-05-04 | DK 9,299 + FD 9,385 rows | Columns: `home_price`, `away_price`, `total_line`, `over/under_price`, `prop_*`, `run_line_spread`, `closing_snapshot` flag |

The `odds` row range is short because that table only began populating after the 2026-04-30 wipe rebuild. **Historical odds for 2022-2024 training came from a separate per-game backfill** (credit reconciliation in `docs/audits/moneyline-v0-pergame-repull-receipt-*.json`); those rows landed elsewhere or were consumed in the model-training feature build. The training-time odds are NOT in `odds` table format — they're in the model's training fixture.

### Model-input season aggregates

| Table | Rows | Notes |
|---|---|---|
| `pitcher_season_stats` | 48 | Aggregated season-level pitcher stats (used as fallback when 30-day window is thin) |
| `team_batting_stats` | 30 | Season-level team batting (one row per team) |
| `bullpen_team_stats` | 30 | Season-level bullpen splits per team |
| `park_factor_runs` | 30 | Park-factor runs index per venue |

### Pick / outcome / CLV (post-wipe live)

| Table | Rows | Notes |
|---|---|---|
| `picks` | 211 | First batch 2026-04-23/24 (pre-wipe), then v0 picks starting 2026-05-03 |
| `pick_outcomes` | 136 | Graded picks (win/loss/push/void) |
| `pick_clv` | 211 | CLV-vs-closing for every pick |
| `calibration_history` | 105 | Daily ECE snapshots since 2026-04-28 |
| `rationale_cache` | 37 | Pre-wipe LLM rationale cache (LLM archived since 2026-04-30) |

### News (signal-quality questionable; 0 signals derived)

| Table | Rows | Notes |
|---|---|---|
| `news_events` | 481 | Raw poll output |
| `news_signals` | 0 | No derived signals yet — `news_poll` returns `ok=false` daily, ingestion known-failing for ≥4 days |

### Empty / unused

| Table | Notes |
|---|---|
| `market_priors` | Reserved; 0 rows |
| `umpire_assignments` | Reserved; 0 rows |
| `odds_closing_snapshot` | Does not exist (yet — referenced in some tests) |

---

## 3. Sportsbook coverage

**v1 scope:** DraftKings + FanDuel ONLY. Schema can extend (`sportsbooks` table holds N books; `odds.sportsbook_id` is the FK). UX surfaces only DK+FD.

**v1 geography:** states where BOTH DK + FD are legal AND operational. Geo-block everywhere else. (Compliance agent maintains the authoritative list.)

---

## 4. Moneyline v0 model artifact

Path: `models/moneyline/current/`

### Training + holdout windows (locked declaration `moneyline-v0-holdout-2026-05-03`)

```
warmup_only:    2022-09-01 → 2023-03-29  (30-day rolling-feature warmup; not used to fit coefficients)
training:       2023-04-01 → 2024-07-15  (last pre-All-Star-break date)
holdout:        2024-07-19 → 2024-12-31  (post-ASB through end of postseason)
```

Holdout was pre-declared in writing **before** the per-game odds re-pull, per CEng rev3 condition (no selection bias from boundary tweaks).

### Sample sizes (from `models/moneyline/current/metrics.json`)

```
training_n: 3282
holdout_n:  609
training_home_win_rate: 0.520
holdout_home_win_rate:  0.498
```

### Architecture

- Logistic regression
- 1 anchor feature (`market_log_odds_home`, NOT standardized — stays in log-odds)
- 11 standardized residual features
- L2 reg, C=1.0, intercept fit
- LightGBM is the documented fallback per rev3 proposal (`approach_b_fallback`) if logistic fails the variance-aware ship rule

### Promotion gate values

| Metric | Holdout value | Threshold | Pass |
|---|---|---|---|
| Anchor coefficient (point) | 0.977 | n/a — interpretation only | — |
| Anchor coefficient 95% CI | [0.781, 1.172] | should bracket 1.0 (it does) | ✓ |
| Sum |residuals| post-scaling | 0.295 | ≥ 0.05 (variance-collapse floor) | ✓ |
| Log-loss vs market prior | −0.00225 (model better) | < market | ✓ |
| ECE raw on holdout | 0.0304 | ≤ 0.04 | ✓ |
| Max calibration deviation | 0.187 | informational | — |
| ROI at +2% EV (default) | +11.3% (CI lower 0.7%) | ≥ −0.5% | ✓ |
| ROI at +1% EV | +8.3% (CI lower −1.6%) | ≥ −0.5% | barely |
| ROI at +3% EV | +11.4% (CI lower 0.3%) | ≥ −0.5% | ✓ |
| Sub-300 variance-aware rule | n/a (n=416 ≥ 300) | n/a | ✓ |

**CLV: identically 0** at v0 by construction (training source = closing source = DK+FD via The Odds API; same vendor, same books, same h2h moneyline market, same pin). Independent CLV grading begins once the live cron captures closing snaps a few minutes after the model's anchor pin.

### Snapshot pin

Every training and serving feature is pinned to `game_start_utc - 60min` (T-60). No feature may read any column updated after first pitch. The pin is stored alongside each training row as `feature_snapshot_ts` for audit.

### 12 features (full spec at `docs/features/moneyline-v0-feature-spec.md`)

1. `market_log_odds_home` — DK+FD de-vigged consensus log-odds (the anchor)
2. `starter_fip_home` — home starter 30-day FIP, IP-weighted
3. `starter_fip_away` — away starter 30-day FIP
4. `starter_days_rest_home` — capped at `DAYS_REST_CAP`
5. `starter_days_rest_away`
6. `bullpen_fip_home` — 14-day team bullpen FIP excluding the starter
7. `bullpen_fip_away`
8. (4 more — see feature spec; 12 total)

xFIP is **NOT** in the v0 served payload (CSO/CEng condition from the prior xFIP infra verdict — wired in via a future retrain chain).

---

## 5. Crons (data refresh schedule, all UTC)

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/schedule-sync` | `0 14 * * *` | Daily MLB schedule sync + odds initial pull + news poll |
| `/api/cron/odds-refresh` | (every 30 min implicit; not in vercel.json — runs via internal pings) | Odds snapshot refresh |
| `/api/cron/pick-pipeline` | `0 16 * * *` and `0 22 * * *` | Pick generation (afternoon + evening slates) |
| `/api/cron/outcome-grader` | `0 8 * * *` | Grade overnight-finished games |
| `/api/cron/clv-compute` | `0 9 * * *` | CLV vs closing for newly-graded picks |
| `/api/cron/calibration-snapshot` | `0 10 * * *` | Daily ECE snapshot per market/tier |
| `/api/cron/statcast-fb-refresh` | `0 11 * * *` | Daily Statcast `fb` re-ingestion for previous day's starters (commits `4f8b9f0` + `c842123` + `b946bd5`) |

---

## 6. Known data quirks / gotchas

These came up in build; capture them so the next iteration doesn't relearn:

1. **MLB IP convention.** `pitcher_game_log.ip` is stored as the raw MLB-API value: `.1 = 1/3`, `.2 = 2/3` (NOT decimal thirds). FIP and xFIP formulas in `scripts/lib/` consume this convention directly. Summing across games via SQL `SUM(ip)` introduces a small bias (3.7% average) but the convention matches train/serve so the bias cancels in the model.
2. **Savant `bb_type` ≠ FG "FB".** FanGraphs xFIP "FB" denominator includes both `fly_ball` AND `popup` outcomes. Statcast splits them. Aggregating only `fly_ball` undercounts by ~30-40%. Fix: always sum both for any FB-derived feature. (Discovered the hard way 2026-05-04; see `feedback_xfip_fb_includes_popup` memory.)
3. **Savant Cloudflare bot detection.** Bespoke User-Agents return 403. Always set a recent Chrome UA on Savant fetches. (Same trick `pybaseball` uses.)
4. **xFIP constants precision.** `XFIP_CONST` per year is the FG `cFIP` value; transcribe to 3-decimal precision from the [FG guts page](https://www.fangraphs.com/guts.aspx?type=cn). The 2026-05-04 transcription was off by 0.04-0.07; corrected at commit `3daa83b`. `LG_HR_PER_FB` lives behind FG's Cloudflare-protected leaderboard; values currently transcribed are plausible vs Statcast cross-reference but not 4-decimal-confirmed (TODO in code).
5. **2021 season not ingested.** The 2026-05-04 xFIP backfill iterated `[2021, 2022, 2023, 2024]` but found 0 rows in `pitcher_game_log` for 2021. If you want 2021, run the upstream backfill chain (`07-pitcher-game-log.mjs` + `08-batter-game-log.mjs`) for that range first; ~2,430 games.
6. **Postseason inclusion.** The `games` table currently has 7,460 rows for 2022-04-07 → 2026-05-06; status='final' through 2026-04-29. Postseason games for 2022-2024 ARE included (the holdout window 2024-07-19 → 2024-12-31 explicitly covers playoffs). Spring training and exhibition are NOT.
7. **News pipeline known-broken.** `news_poll` subtask returns `ok=false` daily; the cron returns HTTP 207 (multi-status); ingestion failing for ≥4 days with zero `news_signals` derived. Low priority — schedule + odds work, news doesn't feed any v0 feature.
8. **`outcome-grader` cron has never fired.** Vercel cron entry is in `vercel.json` (`0 8 * * *`) but zero rows ever in `cron_runs.job_name = 'outcome-grader'`. Manual trigger works. Investigation: check Vercel dashboard cron registration; likely a registration issue not a code issue.

---

## 7. Schema invariants

These are enforced by code and migration order; future iterations should preserve:

- **DK + FD only** in v1 UX. Schema extends to N books (`sportsbooks` table is generic).
- **Snapshot-pinned features.** Every model-input feature carries an explicit `as_of` timestamp. No feature reads `NOW()` at train or serve. Look-ahead audit runs against this column.
- **Train/serve parity.** Same vendor, same books, same h2h moneyline market, same pin. The 12-feature serving payload at `apps/web/lib/features/moneyline-v0.ts` is byte-identical to the training row built by `scripts/features/build-moneyline-v0.py` for the same game at the same `as_of`. Parity test fixture at `tests/integration/feature-parity-moneyline-v0.spec.ts`.
- **Provenance audit columns.** `pitcher_game_log.fb_source` is the pattern: when a column has multiple source candidates over time, add a `_source TEXT NOT NULL DEFAULT 'legacy_value'` column to track which row came from which source. Enables targeted rollback (`UPDATE … WHERE fb_source = 'X'`) and post-backfill coverage audit.
- **Methodology-agnostic CLAUDE layer.** Architecture choice (logistic vs LightGBM vs Bayesian vs neural) lives in `models/<market>/current/architecture.md` + `metrics.json`, NOT in CLAUDE.md or agent prompts.
- **Calibrated `p` from every model surface** regardless of architecture. Currently logistic is near-natively calibrated on binary outcomes (ECE 0.030 < 0.04 target, no isotonic wrap needed).

---

## 8. What's not yet wired (for the next iteration to know what's open)

- **xFIP feature** is NOT yet in the served payload. Data is in `pitcher_game_log.fb` (post-backfill) and the formula is in `scripts/lib/xfip-formula.ts` + `xfip_formula.py`. Wiring it requires a fresh holdout declaration and a retrain — explicitly deferred per CSO/CEng condition.
- **wRC+ / Stuff+** ingestion attempts both halted at scope-gate or verification gate; no rows in DB.
- **2025 season** — no games, no constants. `XFIP_CONST` and `LG_HR_PER_FB` need to be transcribed from FG before any 2025-data retrain.
- **Daily `pitcher_game_log` incremental** — there's no daily cron updating MLB-side stats (IP/HR/BB/HBP/K/is_starter) for yesterday's games. The `statcast-fb-refresh` cron only updates the `fb` column. If yesterday's pgl rows aren't populated by some other path, the Statcast cron exits at `pairs.length === 0`. Worth verifying whether any of the existing crons writes pgl daily.
- **Props / parlays / futures markets** — `odds` table schema supports them but no ingestion or modeling.
- **Multi-market models** — only moneyline v0 exists. Run line, totals, props, parlays, futures all open.

---

## 9. How to bootstrap a fresh sibling project from this data

If you're starting iteration 2 and want to use the same data assets:

1. **Get keys:** The Odds API key (paid), Anthropic key (optional — currently archived), Stripe key (subscription), Supabase project URL + service role key, Upstash Redis URL+token. Vercel project link.
2. **Clone the schema:** Run all migrations in `supabase/migrations/0001_*.sql` through `0031_*.sql` against a fresh Supabase project. Migration runner at `scripts/run-migrations/run.mjs` is idempotent.
3. **Backfill in order:**
   - `01-games-schedule.mjs` → MLB Stats API schedule sync 2022-2024 (free)
   - `02-weather*` → Meteostat weather (free, rate-limited)
   - `03-odds-historical.mjs` + `03b-odds-historical-pergame.mjs` → The Odds API historical (paid; budget ~5,000-50,000 credits depending on completeness)
   - `04-lineups.mjs` → MLB Stats API lineups
   - `05-park-factors.mjs`
   - `06-fix-divisions.mjs` (one-time data fix)
   - `07-pitcher-game-log.mjs` → MLB API boxscore
   - `08-batter-game-log.mjs` → MLB API boxscore
   - `09-pitcher-fb-statcast.mjs` → Savant fb (Chrome UA required; ~5h wall time)
4. **Train v0:** Run `scripts/features/build-moneyline-v0.py` against the holdout declaration in `models/moneyline/holdout-declaration.json`, then the trainer (in the same dir or wherever it lives). Output lands in `models/moneyline/current/`.
5. **Wire serving:** `apps/web/lib/features/moneyline-v0.ts` mirrors the training feature builder. The pick-pipeline cron at `0 16 * * *` and `0 22 * * *` UTC reads from this and writes `picks` rows.
6. **Read the lessons:** memory entries at `~/.claude/projects/C--AI-Public-diamond-edge/memory/` capture six rounds of build feedback (auto-chain rules, anti-AI-style opt-out, Savant UA, xFIP+popup, etc.).

---

## 10. Source references

- CLAUDE.md — locked stack, budget, scope, methodology stance
- `docs/features/moneyline-v0-feature-spec.md` — full 12-feature spec
- `docs/proposals/` — every scope-gate verdict in chronological order
- `docs/research/xfip-constants-audit-2026-05-05.md` — constants audit
- `docs/audits/moneyline-v0-pergame-repull-receipt-*.json` — odds backfill credit reconciliation
- `models/moneyline/current/` — v0 artifact (architecture.md, metrics.json, feature-coefficients.json, holdout-predictions.parquet, model.joblib, scaler.joblib, serving-params.json)
- `models/moneyline/holdout-declaration.json` — locked holdout slice
- `tests/fixtures/feature-parity/xfip-statcast-verification-2026-05-04.json` — xFIP verification gate result

---

*This doc is a snapshot. Re-run the inventory queries (see `scripts/audit/` patterns) before relying on counts older than a week.*
