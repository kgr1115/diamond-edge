# Moneyline v0 — Feature Spec

**Date:** 2026-04-30
**Author:** mlb-feature-eng
**Proposal:** moneyline-v0-2026-04-30 (approved with conditions, all three lenses)
**Status:** Design artifact — no code yet. Implementer reads this.

---

## Overview

12 features, all snapshot-pinned at `game_start - 60min` (T-60). Every join carries an explicit `as_of` timestamp. No feature may read any column updated after first pitch.

The schema source of truth is `docs/schema/schema-v1.md`. Tables not yet in that schema (specifically `game_starters`, `pitcher_game_log`, `batter_game_log`, `lineup_entries`, `park_factors`) are flagged below as **SCHEMA DEPENDENCY** — mlb-data-engineer must land these before the implementer can build.

---

## Snapshot Pin — Global Rule

All features use the same pin:

```
as_of = game_start_utc - interval '60 minutes'
```

In training: `games.game_time_utc - interval '60 minutes'`
In serving: the Vercel Function receives `game_start_utc` from the pick-generation cron; the pin is computed at the top of the feature-construction function and passed through every sub-query. No sub-query may use `NOW()` or any current-time reference.

The pin is stored alongside each training row as `feature_snapshot_ts` so every historical row is auditable. The look-ahead audit queries this column.

---

## Feature 1: `market_log_odds_home`

**Description:** De-vigged DK+FD consensus log-odds for the home team, moneyline market. The market-prior anchor.

**Source columns:**
- `odds.game_id`, `odds.sportsbook_id`, `odds.market`, `odds.home_price`, `odds.away_price`, `odds.snapshotted_at`
- `sportsbooks.key` (to filter `'draftkings'` and `'fanduel'`)

**Snapshot pin:**
```
SELECT home_price, away_price, snapshotted_at
FROM odds
WHERE game_id = :game_id
  AND sportsbook_id IN (:dk_id, :fd_id)
  AND market = 'moneyline'
  AND snapshotted_at <= :as_of
ORDER BY snapshotted_at DESC
LIMIT 1 per sportsbook
```
Use the most-recent snapshot at or before `as_of` for each book. Average the two de-vigged probabilities, then take `log(p / (1 - p))`.

**Computation logic:**
1. Convert American odds to implied probability: `p_raw = 100 / (|american_odds| + 100)` if positive, `|american_odds| / (|american_odds| + 100)` if negative.
2. Proportional vig removal: `p_devig = p_raw_home / (p_raw_home + p_raw_away)` per book.
3. Consensus: average `p_devig_home` across DK and FD.
4. `market_log_odds_home = log(p_consensus / (1 - p_consensus))`

**Alternative (Shin):** Iteratively solve for `z` in `p_i = (sqrt(z^2 + 4*(1-z)*q_i^2) - z) / (2*(1-z))` where `q_i` is raw implied probability and `sum(p_i) = 1`. Proportional is the default; document choice in `models/moneyline/current/architecture.md`. The vig-removal method must match between training and serving — no silent divergence.

**Leakage check:** Only uses `snapshotted_at <= as_of`. Pre-game line movement after T-60 is excluded. In-game odds are excluded because game-status filtering is not needed: the pin is timestamp-based, not status-based, so any snapshot taken after first pitch is excluded by the `<= as_of` condition.

**Invalidation rule:** Recompute if a new odds snapshot arrives between the prior computation and T-60. In serving, the pick cron runs at T-60 and reads the freshest snapshot at or before that moment — no additional invalidation logic needed in production.

**Null handling:** If no DK snapshot exists at or before `as_of`, try FD alone. If neither book has a snapshot, set `market_log_odds_home = NULL` and exclude the row from training. At serve time, a NULL anchor is a hard error — the pick must not be generated; log and skip the game.

---

## Feature 2: `starter_fip_home`

**Description:** Home starter's fielding-independent pitching (FIP) over the last 30 days, weighted by innings pitched.

**Source columns:**
- `game_starters.game_id`, `game_starters.pitcher_id`, `game_starters.side` (SCHEMA DEPENDENCY)
- `pitcher_game_log.game_id`, `pitcher_game_log.pitcher_id`, `pitcher_game_log.game_date`, `pitcher_game_log.ip`, `pitcher_game_log.hr`, `pitcher_game_log.bb`, `pitcher_game_log.hbp`, `pitcher_game_log.k` (SCHEMA DEPENDENCY)

**Snapshot pin:**
```
WHERE pgl.game_date < date_trunc('day', :as_of)
  AND pgl.game_date >= date_trunc('day', :as_of) - interval '30 days'
```
`<` not `<=` on game_date: a pitcher's same-day start is excluded.

**Computation logic:**
```
FIP = ((13*HR + 3*(BB+HBP) - 2*K) / IP) + FIP_constant
```
FIP constant = 3.10 (league-average ERA - league-average peripheral-FIP; use a static 2022-2024 average, update annually). Weighted by innings pitched across appearances in the 30-day window.

**Leakage check:** The `game_date < as_of_date` guard ensures the starter's own current-day start is not included. No in-game stats (live IP, K, BB) can enter because the source table is a completed-game log.

**Invalidation rule:** Recompute if the identified starter changes (scratch). The starter identity comes from `game_starters`, which is updated when MLB Stats API reports a lineup/pitching change. A scratch before T-60 triggers recompute of both `starter_fip_home` and `starter_days_rest_home`.

**Null handling:** If fewer than 3 IP in the window, impute with the team's bullpen FIP (see feature 6) as a proxy. If truly no data (debut), impute with the 2022-2024 league-average FIP (≈4.20). Document the imputation in the row's `feature_flags` bitmask bit 0.

---

## Feature 3: `starter_fip_away`

Same spec as `starter_fip_home` with `side = 'away'` in `game_starters`. All source columns, pin, computation, leakage check, and null handling identical.

---

## Feature 4: `starter_days_rest_home`

**Description:** Number of calendar days since the home starter's last game appearance (start or relief).

**Source columns:**
- `game_starters.pitcher_id`, `game_starters.side`
- `pitcher_game_log.pitcher_id`, `pitcher_game_log.game_date`

**Snapshot pin:**
```
SELECT MAX(pgl.game_date) AS last_appearance
FROM pitcher_game_log pgl
WHERE pgl.pitcher_id = :starter_id
  AND pgl.game_date < date_trunc('day', :as_of)
```

**Computation logic:**
```
starter_days_rest_home = game_date - last_appearance  (integer days)
```
Capped at 60 days (spring training / IL return; beyond 60 days the signal is flat and the cap prevents outlier leverage).

**Leakage check:** `game_date < as_of_date` excludes same-day appearances. The current game's own pitching appearance does not exist in `pitcher_game_log` until the game is final.

**Invalidation rule:** Same as `starter_fip_home` — recompute on starter scratch.

**Null handling:** If no prior appearance in the table (true debut), set to 60 (the cap; treat as maximum rest). Document with `feature_flags` bit 1.

---

## Feature 5: `starter_days_rest_away`

Same spec as `starter_days_rest_home` with `side = 'away'`. Identical pin, computation, leakage check, null handling.

---

## Feature 6: `bullpen_fip_l14_home`

**Description:** Home team's bullpen FIP over the last 14 days, excluding the identified starter.

**Source columns:**
- `pitcher_game_log.pitcher_id`, `pitcher_game_log.team_id`, `pitcher_game_log.game_date`, `pitcher_game_log.ip`, `pitcher_game_log.hr`, `pitcher_game_log.bb`, `pitcher_game_log.hbp`, `pitcher_game_log.k`, `pitcher_game_log.is_starter` (boolean)
- `game_starters.pitcher_id` (to exclude the current starter from the bullpen pool)

**Snapshot pin:**
```
WHERE pgl.game_date < date_trunc('day', :as_of)
  AND pgl.game_date >= date_trunc('day', :as_of) - interval '14 days'
  AND pgl.team_id = :home_team_id
  AND pgl.pitcher_id != :home_starter_id
```

**Computation logic:** Same FIP formula as feature 2, IP-weighted across all qualifying relief appearances. Excludes `is_starter = true` rows for pitchers who also started in the 14-day window when appearing as starters (to avoid conflating starter vs. bullpen roles).

**Leakage check:** Same day-boundary guard. No live game data; source is completed-game log only.

**Invalidation rule:** Recompute daily when new completed-game data lands. In serving, the pick cron re-reads at T-60 — no additional trigger needed unless game log ingestion fails.

**Null handling:** If fewer than 10 IP across the 14-day window, impute with the 30-day team bullpen FIP (expand window). If still under 10 IP, use league-average (≈4.30). Document with `feature_flags` bit 2.

---

## Feature 7: `bullpen_fip_l14_away`

Same spec as `bullpen_fip_l14_home` with `team_id = :away_team_id` and `pitcher_id != :away_starter_id`. Identical pin, computation, leakage check, null handling.

---

## Feature 8: `team_wrcplus_l30_home`

**Description:** Home team's lineup-weighted wRC+ over the last 30 days. Once `lineup_entries` is locked (T-0 actual lineup), use only batters in that day's lineup. Before lineup lock (serving at T-60), use the 26-man active roster weighted by projected AB share from the last 30-day sample.

**Source columns:**
- `batter_game_log.batter_id`, `batter_game_log.team_id`, `batter_game_log.game_date`, `batter_game_log.pa`, `batter_game_log.wrc_plus` (SCHEMA DEPENDENCY)
- `lineup_entries.game_id`, `lineup_entries.batter_id`, `lineup_entries.batting_order` — used when available at T-60 (SCHEMA DEPENDENCY)

**Snapshot pin:**
```
WHERE bdl.game_date < date_trunc('day', :as_of)
  AND bdl.game_date >= date_trunc('day', :as_of) - interval '30 days'
  AND bdl.team_id = :home_team_id
```
Lineup lock check: `SELECT EXISTS(SELECT 1 FROM lineup_entries WHERE game_id = :game_id AND side = 'home' AND confirmed = true AND updated_at <= :as_of)`. If locked, filter `batter_id IN (SELECT batter_id FROM lineup_entries WHERE game_id = :game_id AND side = 'home' AND confirmed = true AND updated_at <= :as_of)`.

Note: `lineup_entries.pinned_at` (added in migration 0023) is the long-term home for the explicit T-60min snapshot pin. Once the lineup-sync ingester writes `pinned_at` for new rows, the lock check should migrate to `pinned_at IS NOT NULL AND pinned_at <= :as_of`. For v0 and all historical backfill rows where `pinned_at IS NULL`, the fallback is `confirmed = true AND updated_at <= :as_of`.

**Computation logic:** PA-weighted average of `wrc_plus` across the eligible batter set in the 30-day window.

**Leakage check:** Lineup lock status is checked against `confirmed = true AND updated_at <= :as_of`, not current status. At T-60 min, MLB typically has not yet published the official lineup — the lock check will usually return false, falling back to the roster-weighted average. The leakage risk is if `updated_at` is touched on a confirmed row after the actual confirmation event (e.g., by a background sync that re-writes unchanged rows). The ingester must not bump `updated_at` on rows it does not modify. `pinned_at` will eliminate this ambiguity once the ingester writes it for new confirmed rows.

**Invalidation rule:** Recompute if `lineup_entries` is updated for this game before T-60 (lineup change, late scratch). The pick cron re-reads at T-60 using the freshest locked lineup at that moment.

**Null handling:** If fewer than 50 PA across the team roster in the 30-day window (April cold start), expand to 60 days. If still sparse, use the prior-season team wRC+ (stored in a `team_season_stats` lookup table). Document with `feature_flags` bit 3.

---

## Feature 9: `team_wrcplus_l30_away`

Same spec as `team_wrcplus_l30_home` with `team_id = :away_team_id` and `side = 'away'` in lineup_entries. Identical pin, computation, leakage check, null handling.

---

## Feature 10: `park_factor_runs`

**Description:** Venue-level runs park factor (multi-year), normalized to 100 (100 = league average).

**Source columns:**
- `park_factors.venue_name`, `park_factors.runs_factor`, `park_factors.season_years` (SCHEMA DEPENDENCY — static lookup table, populated once per season from Baseball Savant or FanGraphs park factors)
- `games.venue_name` (join key)

**Snapshot pin:** Static table — no time-based pin needed. Updated once per season (pre-season or after ~2 months of data). The implementer must verify the table is populated before training; a missing park factor is a hard error in data validation.

**Computation logic:** `park_factor_runs = pf.runs_factor` joined on `games.venue_name = pf.venue_name`. Single scalar lookup per game.

**Leakage check:** No time-variant data. The park factor is a multi-year average and does not change within a season. No in-game signal can enter.

**Invalidation rule:** Update the `park_factors` table once per season (January or after 2 months of current-season data if revising). A season-start update triggers recompute of all training rows for that venue. Training and serving both read from the same `park_factors` table, so they're automatically in sync.

**Null handling:** If `venue_name` has no match in `park_factors` (new stadium, name mismatch), use 100 (neutral). Log the miss as a data-quality alert. Document with `feature_flags` bit 4.

---

## Feature 11: `weather_temp_f`

**Description:** Forecast temperature (°F) at game venue at game start time.

**Source columns:**
- `games.weather_temp_f`, `games.game_time_utc`, `games.updated_at`

**Snapshot pin:**
```
SELECT weather_temp_f, updated_at
FROM games
WHERE id = :game_id
  AND updated_at <= :as_of
```
Use the most recent `games` row version with `updated_at <= as_of`. In the current schema, `games` is an upsert target — the `updated_at` column records when weather was last refreshed.

**Computation logic:** Direct read from `games.weather_temp_f`. No transformation.

**Leakage check:** The `updated_at <= as_of` pin ensures the weather value in training is the one that was available at T-60, not a post-game actual temperature update. Weather ingestion writes to `games.weather_temp_f`; any update after T-60 is excluded.

**Invalidation rule:** Recompute if a new weather update lands between prior computation and T-60. The cron fetches weather at T-90 and T-60 min; the feature reads the latest available at T-60.

**Null handling:** If `weather_temp_f` is NULL (dome stadium, missing fetch), impute with 72°F (indoor/neutral). Dome stadiums should have a static `is_dome` flag on the `teams` table or in `park_factors` — if a venue is a dome, NULL is expected and the imputation is correct, not a data-quality miss. Document with `feature_flags` bit 5.

---

## Feature 12: `weather_wind_out_mph`

**Description:** Wind speed (mph) in the "out" direction at game venue at game start. Negative values indicate wind blowing in.

**Source columns:**
- `game_wind_features.weather_wind_out_mph` — Postgres view (migration 0025) that joins `games` + `park_factor_runs` on `venue_name` and computes the scalar inline via `COS(RADIANS(weather_wind_dir - (outfield_bearing_deg + 180)))`. The feature layer reads this column directly; the derivation formula does not live in the feature construction code.
- Underlying raw columns (for reference): `games.weather_wind_mph`, `games.weather_wind_dir`, `park_factor_runs.outfield_bearing_deg`, `park_factor_runs.is_dome`

**Snapshot pin:**
```
SELECT weather_wind_out_mph, games_updated_at
FROM game_wind_features
WHERE game_id = :game_id
  AND games_updated_at <= :as_of
ORDER BY games_updated_at DESC
LIMIT 1
```
`games_updated_at` is the `games.updated_at` column exposed by the view. The pin is on the `games` side — same discipline as `weather_temp_f`.

**Computation logic:** Read `game_wind_features.weather_wind_out_mph` directly. The view handles the cosine computation and dome override. No re-derivation in the feature layer.

**Leakage check:** Same as `weather_temp_f`. The `games_updated_at <= as_of` pin on the `games` side holds. `park_factor_runs` is a static reference table with no time-variant column — no leakage path from that side.

**Invalidation rule:** Same as `weather_temp_f`. Recompute on new weather update at or before T-60.

**Null handling:** The view returns `NULL` for `weather_wind_out_mph` when `park_factor_runs.outfield_bearing_deg IS NULL` (venue not seeded). The feature layer must substitute `0.0` in this case and set `feature_flags` bit 6. The view already returns `0.0` for dome stadiums and for NULL `weather_wind_mph` / `weather_wind_dir` — those are not NULL at the feature layer. The only path to a NULL that reaches the feature layer is an unseeded venue; mean-imputation is not appropriate here because bearing is venue-specific, so `0.0` (neutral crosswind) is the correct fallback. Log the miss as a data-quality alert so the data engineer can add the missing venue row to `park_factor_runs`.

---

## Feature 13: `b2b_flag_home`

**Description:** Boolean (0/1) — home team played a game yesterday.

**Source columns:**
- `games.home_team_id`, `games.game_date`, `games.status`

**Snapshot pin:**
```
SELECT EXISTS(
  SELECT 1 FROM games
  WHERE (home_team_id = :home_team_id OR away_team_id = :home_team_id)
    AND game_date = date_trunc('day', :as_of)::date - interval '1 day'
    AND status IN ('final', 'live', 'scheduled')
) AS b2b_flag_home
```
Uses `game_date`, not game outcome — the team is considered back-to-back if they had a scheduled game yesterday regardless of whether it completed.

**Leakage check:** `game_date = yesterday` is a static date comparison. No live game data. `status IN ('final', 'live', 'scheduled')` includes games that were still live at T-60 yesterday — this is correct because the team played yesterday regardless of outcome. `status = 'postponed'` is excluded (team did not play).

**Invalidation rule:** Does not need recompute after the initial construction — the prior day's game existence does not change. Exception: if a prior day's game is retroactively reclassified from `final` to `postponed`, the flag should be recomputed for all subsequent games. This is a data-quality edge case; the look-ahead audit will catch any systematic version of it.

**Null handling:** Treat as 0 (no back-to-back) if the query returns no rows. This is correct behavior — no prior game means no fatigue signal.

---

## Feature 14: `b2b_flag_away`

Same spec as `b2b_flag_home` with `home_team_id = :away_team_id` and `away_team_id = :away_team_id` in the existence check. Identical pin, computation, leakage check, null handling.

---

## Feature 15: `home_field`

**Description:** Boolean (0/1) — always 1 for every row in the home-team perspective.

**Source columns:** None beyond game context already known at row construction time.

**Snapshot pin:** N/A — derived from the game record structure, not a time-variant lookup.

**Computation logic:** `home_field = 1` for every training row where the outcome is from the home team's perspective; `home_field = 0` for the away-team perspective row. Since moneyline v0 models home win probability, every training row is from the home perspective and `home_field = 1` always. This feature is included as a structural intercept check.

**Leakage check:** No data dependency. Cannot leak.

**Invalidation rule:** Never needs recompute.

**Null handling:** Cannot be NULL.

---

## Feature Count Note

The proposal lists 12 features by name but counts 15 distinct feature columns when the home/away pairs are expanded. The 12-feature framing is correct at the named-feature level (`market_log_odds_home`, `starter_fip`, `starter_days_rest`, `bullpen_fip_l14`, `team_wrcplus_l30`, `park_factor_runs`, `weather_temp_f`, `weather_wind_out_mph`, `b2b_flag`, `home_field`). The implementer treats each home/away pair as two columns in the feature vector. The feature vector is 15 elements, ordered as listed above (features 1–15).

---

## Feature Vector Contract

Order is fixed. mlb-model reads this as the canonical column ordering.

```
[0]  market_log_odds_home       float64
[1]  starter_fip_home           float64
[2]  starter_fip_away           float64
[3]  starter_days_rest_home     int16
[4]  starter_days_rest_away     int16
[5]  bullpen_fip_l14_home       float64
[6]  bullpen_fip_l14_away       float64
[7]  team_wrcplus_l30_home      float64
[8]  team_wrcplus_l30_away      float64
[9]  park_factor_runs           float64
[10] weather_temp_f             float64
[11] weather_wind_out_mph       float64
[12] b2b_flag_home              int8
[13] b2b_flag_away              int8
[14] home_field                 int8
```

The `joblib` artifact must be trained on this exact column order. The serving function constructs the vector in this order and passes it as a 1×15 array to `model.predict_proba`. No named-column lookup at serve time — order is the contract.

`feature_snapshot_ts` is stored in the training rows but not passed to the model. It exists for audit only.

---

## Schema Dependencies (mlb-data-engineer must provide)

| Table | Required columns | Notes |
|---|---|---|
| `game_starters` | `game_id`, `pitcher_id`, `side` ('home'/'away'), `confirmed_at` | One row per game+side. Upserted when probable pitcher confirmed or changes. Note: `games.probable_home_pitcher_id` and `games.probable_away_pitcher_id` already exist in schema-v1 and may satisfy the identity lookup without a new table; mlb-data-engineer should evaluate whether a separate `game_starters` table is needed or if the `games` columns suffice plus a `scratch_history` log for invalidation events. |
| `pitcher_game_log` | `pitcher_id`, `team_id`, `game_id`, `game_date`, `ip`, `hr`, `bb`, `hbp`, `k`, `is_starter` | One row per pitcher per game appearance. Source: MLB Stats API box scores. |
| `batter_game_log` | `batter_id`, `team_id`, `game_id`, `game_date`, `pa`, `wrc_plus` | One row per batter per game. wRC+ must be pre-computed from box score components or sourced from FanGraphs. |
| `lineup_entries` | `game_id`, `batter_id`, `side`, `batting_order`, `confirmed` (boolean), `updated_at`, `pinned_at` (nullable, migration 0023) | Populated when official lineup is confirmed. v0 uses `confirmed = true AND updated_at <= :as_of` for the lock check. `pinned_at` is the long-term explicit pin field; once the ingester writes it for new rows, the lock check migrates to `pinned_at IS NOT NULL AND pinned_at <= :as_of`. |
| `park_factor_runs` | `venue_name`, `runs_factor`, `outfield_bearing_deg`, `is_dome`, `season_years`, `source` | Static table (migration 0024). Populated once per season from FanGraphs/BBRef. `outfield_bearing_deg` is required for `game_wind_features` view. |
| `game_wind_features` | view (migration 0025): `game_id`, `weather_wind_out_mph`, `games_updated_at` | Computed view joining `games` + `park_factor_runs`. Feature 12 reads from this view, not from raw `games` columns. Returns NULL for `weather_wind_out_mph` when venue is unseeded; feature layer falls back to 0.0. |

The coverage report for `lineup_entries` (2021–2024) is a precondition for the 2021 training-window decision per CSO and CEng verdict conditions.

---

## Look-Ahead Canary Design

### Purpose

CEng condition: the leakage audit must demonstrate it can catch look-ahead leakage. An audit that runs clean on all 15 features proves nothing if no leaky feature was present. The canary is a feature that is deliberately leaky — it should fail the audit, and if it passes, the audit itself is broken.

### Canary Feature: `first_inning_runs_home`

**Definition:** The number of runs scored by the home team in the first inning of this game.

**Why it leaks:** First inning results are known only after the first inning completes — well after first pitch and thus after any snapshot pin. A model trained on this feature learns outcomes, not pre-game predictors.

**How to construct it for the canary test:** Join `pick_outcomes` (or a raw game score table with inning-by-inning detail) on `game_id` and read the home team's first-inning run total. This value is 0 at T-60 (the game has not started) but is definitively non-zero or zero only after the first inning ends.

**Expected failure signature the audit should detect:**

1. **Timestamp audit:** The source data for `first_inning_runs_home` has no `<= as_of` filter. It reads from a completed-game table where the rows exist only after game completion. The audit checks every feature source for a timestamp-bound join; this one has none.

2. **Mutual information spike:** In the training set, `first_inning_runs_home` will have anomalously high mutual information with the outcome (`home_win`). An inning-level run total is a near-direct sub-component of the final score. MI for this feature should be an order of magnitude above the valid features.

3. **Holdout calibration break:** A model trained on this feature will show perfect calibration on training data and severe overconfidence on the holdout (or on any game where the feature is computed pre-game as 0). ECE will spike above the 0.04 ceiling on the holdout.

4. **Coefficient implausibility:** In logistic regression, the coefficient on `first_inning_runs_home` will be large and positive (more first-inning runs → higher estimated win probability) which is directionally correct but only because the feature encodes the outcome. The magnitude will be implausibly large relative to the other coefficients.

**How to include in the audit:**

The implementer trains two versions of the model:
- `v0_clean`: the 15 canonical features.
- `v0_canary`: the 15 canonical features + `first_inning_runs_home`.

The look-ahead audit runs on `v0_canary` and must flag `first_inning_runs_home` as leaky via the timestamp check. If the audit does not flag it, the audit has a bug. The `v0_canary` artifact is not shipped; it exists only to validate the audit.

**Failure modes to watch for:**

- The canary passes the timestamp check because the implementer inadvertently added a date-boundary filter when constructing the feature for the canary. This would be a false pass — the test validates the audit tool, not a correct feature.
- The canary is filtered out as NULL in training because the data pipeline doesn't have inning-level data. If `first_inning_runs_home` is always NULL, it fails silently instead of failing audibly. mlb-data-engineer should confirm inning-level data is available for at least a subset of the training window so the canary has real values.

---

## Train/Serve Parity Fixture Spec

### Purpose

CEng condition: prove that the same game inputs produce the same 15-element feature vector in both the training-time SQL pipeline and the serving-time Vercel Function. Byte-for-byte match required.

### Fixture Game

Use a specific, real, already-completed game with known data. The fixture spec defines the exact inputs; the implementer populates actual values after data backfill.

**Fixture game:** NYY (home) vs. BOS (away), 2024-08-15 (first game of a series, a date where both teams have 30+ days of prior stats). The exact game must be confirmed by mlb-data-engineer as having complete data for all 15 features before the fixture is finalized.

### Fixture Input Record

The fixture defines the exact Postgres rows (or their column values) that feed the feature computation. These are the source table values at `as_of = game_time_utc - 60min`.

The implementer populates this table from real data after backfill:

```
game_id:                 <uuid of the 2024-08-15 NYY/BOS game>
game_time_utc:           2024-08-15T23:10:00Z  (7:10 PM ET)
as_of:                   2024-08-15T22:10:00Z  (T-60)
home_team_id:            <NYY uuid>
away_team_id:            <BOS uuid>

odds inputs (at snapshotted_at <= as_of):
  DK home_price:         -135
  DK away_price:         +115
  FD home_price:         -132
  FD away_price:         +112

starter inputs:
  home starter id:       <pitcher uuid, NYY SP>
  home starter prior appearances in window: <list of game_dates + IP + HR + BB + HBP + K>
  home starter last_appearance date:        <date>
  away starter id:       <pitcher uuid, BOS SP>
  away starter prior appearances in window: <list>
  away starter last_appearance date:        <date>

bullpen inputs (14-day, excluding starter):
  home bullpen aggregate: <IP, HR, BB, HBP, K>
  away bullpen aggregate: <IP, HR, BB, HBP, K>

lineup/batter inputs:
  lineup_entries locked: <yes/no at as_of>
  home batter PA-weighted wRC+: <list of batter_id, pa, wrc_plus>
  away batter PA-weighted wRC+: <list>

park_factor:             <runs_factor for Yankee Stadium>
weather:                 weather_temp_f=<N>, weather_wind_mph=<N>, weather_wind_dir=<dir>
b2b checks:
  NYY game on 2024-08-14: <yes/no, status>
  BOS game on 2024-08-14: <yes/no, status>
```

### Expected Feature Vector

The implementer computes the 15-element feature vector from the above inputs using the formulas in this spec and records the expected output:

```
expected_feature_vector = [
  market_log_odds_home,       # computed from DK+FD prices above
  starter_fip_home,           # computed from home starter window
  starter_fip_away,           # computed from away starter window
  starter_days_rest_home,     # game_date - home_last_appearance
  starter_days_rest_away,     # game_date - away_last_appearance
  bullpen_fip_l14_home,       # computed from home bullpen aggregate
  bullpen_fip_l14_away,       # computed from away bullpen aggregate
  team_wrcplus_l30_home,      # PA-weighted wRC+ home
  team_wrcplus_l30_away,      # PA-weighted wRC+ away
  park_factor_runs,            # Yankee Stadium runs factor
  weather_temp_f,              # from games row
  weather_wind_out_mph,        # derived from wind_mph * direction_scalar
  b2b_flag_home,              # 1 or 0
  b2b_flag_away,              # 1 or 0
  home_field                  # 1 always
]
```

All float values are stored to 6 decimal places in the fixture file.

### Parity Test Protocol

Two code paths must produce the fixture vector:

**Path A (training):** The training SQL pipeline constructs features from the Supabase tables with `as_of = 2024-08-15T22:10:00Z`. The pipeline outputs a CSV or parquet row. The fixture test reads that row and asserts each element matches the expected vector within floating-point tolerance (1e-6 absolute for floats; exact match for integers and booleans).

**Path B (serving):** The Vercel Function feature-construction logic, called with the same `game_id` and `as_of` value, returns a JSON feature object. The fixture test converts that JSON to the 15-element ordered array and asserts the same match.

**Parity assertion:** For each element `i` in `[0..14]`:
- Integers/booleans: `path_a[i] == path_b[i]` (exact)
- Floats: `abs(path_a[i] - path_b[i]) < 1e-6`

Any mismatch is a parity failure and a hard blocker — the implementer must find and fix the divergence before the feature set is signed off.

**Fixture file location:** `tests/fixtures/feature-parity/moneyline-v0-2024-08-15-nyyvsboston.json`

The fixture file structure:

```json
{
  "fixture_id": "moneyline-v0-2024-08-15-nyyvsbos",
  "game_id": "<uuid>",
  "as_of": "2024-08-15T22:10:00Z",
  "feature_snapshot_ts": "2024-08-15T22:10:00Z",
  "inputs": { ... source values above ... },
  "expected_vector": [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14],
  "feature_names": ["market_log_odds_home", "starter_fip_home", "starter_fip_away",
                    "starter_days_rest_home", "starter_days_rest_away",
                    "bullpen_fip_l14_home", "bullpen_fip_l14_away",
                    "team_wrcplus_l30_home", "team_wrcplus_l30_away",
                    "park_factor_runs", "weather_temp_f", "weather_wind_out_mph",
                    "b2b_flag_home", "b2b_flag_away", "home_field"],
  "dtypes": ["float64", "float64", "float64", "int16", "int16",
             "float64", "float64", "float64", "float64",
             "float64", "float64", "float64", "int8", "int8", "int8"],
  "expected_model_probability": null,
  "notes": "expected_model_probability populated after mlb-model trains the v0 artifact"
}
```

`expected_model_probability` is filled in by mlb-model after the `joblib` artifact is trained. A second parity check then verifies that `model.predict_proba([expected_vector])[0][1]` matches the stored value. This closes the full loop from raw inputs to model output.

---

## Vig-Removal Method Documentation

Per COO and CSO conditions, the method must match between training and serving and be documented in the artifact.

**Default: Proportional**

```
p_raw_home = implied_prob(home_price)   # from American odds
p_raw_away = implied_prob(away_price)
p_devig_home = p_raw_home / (p_raw_home + p_raw_away)
```

**Alternative: Shin**

Solves for the "true" probability assuming the vig arises from a proportional insider-trading margin `z`:

```
p_shin_i = (sqrt(z^2 + 4*(1-z)*q_i^2) - z) / (2*(1-z))
```

where `q_i = p_raw_i / sum(p_raw)` and `z` is solved iteratively such that `sum(p_shin_i) = 1`. Shin is more accurate when vig is asymmetric (favorite-longshot bias) but more complex. For a v0 anchor feature where the log-odds is the input (not the probability), the difference between Shin and proportional is usually <0.003 on `p_devig_home` for juice under -150.

The artifact's `architecture.md` records which method was used. Both training and serving import from the same `devig.ts` / `devig.py` utility function. No inline re-implementation is permitted — the shared function is the enforcement mechanism for training/serving parity on this computation.

---

## Coordination Notes

### What mlb-data-engineer must provide (blockers before implementation)

1. **`lineup_entries` coverage report** — 2021–2024, reporting `(game_date, team_id, completeness_pct)` where completeness is the fraction of batting-order slots with a confirmed `batter_id`. This gates the CSO/CEng condition on whether to include 2021 in training (≥95% coverage threshold).
2. **`game_starters` backfill** — 2022–2024 (or 2021 if coverage clears), with `confirmed_at` timestamps. The `confirmed_at` must reflect when the starter was officially announced, not when the row was written, if these differ in historical data.
3. **`pitcher_game_log` and `batter_game_log` backfill** — same date range. These are derived from MLB Stats API box scores, which mlb-data-engineer's existing ingestion pipeline already targets.
4. **`wrc_plus` pre-computation** — either sourced from FanGraphs (scrape) or computed from box score components (PA, H, 2B, 3B, HR, BB, HBP, SF, league averages). This is the highest-effort item; mlb-data-engineer should surface complexity and an alternative (using OPS+ from MLB Stats API as a wRC+ proxy for v0) if wRC+ computation is too expensive.
5. **`park_factors` table** — populated for all venues in the 2022–2024 training range. `outfield_bearing_deg` is required for `weather_wind_out_mph`; if bearing data is unavailable, `weather_wind_out_mph` falls back to raw `weather_wind_mph` with a NULL direction treated as crosswind (0.0).
6. **`closing-line snapshots at T-60min` for backfilled games** — The Odds API does not provide true historical closing lines at arbitrary prior times for most plans. mlb-data-engineer must clarify whether the historical odds backfill includes time-stamped snapshots or only a single "closing line" per game. If only a single closing line is available for historical games, `market_log_odds_home` in training uses the closing line (best available proxy for T-60) with this assumption documented in `architecture.md`.
7. **`inning_scores` or equivalent table** — required for the look-ahead canary to have real values (see canary design above). If this table does not exist, the canary should use `games.home_score` as a proxy (total runs, not first-inning, but still leaky).

### What mlb-model must know

1. **Feature vector is 15 elements, ordered as specified in the Feature Vector Contract section.** No named-column lookup. Order is the contract.
2. **`feature_snapshot_ts` is stored in training rows but is not a model input.** It must be excluded from the feature matrix passed to `fit()`.
3. **`feature_flags` bitmask is stored in training rows but is not a model input.** Same exclusion rule.
4. **Dtype contract is fixed** (see Feature Vector Contract above). The `joblib` artifact must be trained on this exact dtype array. Float64 for all continuous features; int16 for rest-day features; int8 for flags.
5. **Null handling produces imputed values, not NaN.** The feature construction layer resolves all NULLs before passing to the model. No `SimpleImputer` in the sklearn Pipeline — imputation is handled upstream in the SQL/feature layer.
6. **The look-ahead canary test must be included in the v0 bundled report.** The canary model (`v0_canary`) is trained alongside `v0_clean`, the audit is run on the canary, and the audit's ability to flag `first_inning_runs_home` is confirmed in the report. This is a CEng condition.
7. **Parity fixture path:** `tests/fixtures/feature-parity/moneyline-v0-2024-08-15-nyyvsboston.json`. The fixture's `expected_model_probability` field must be populated after the artifact is trained and before the v0 bundled report is submitted to CEng.
8. **FIP constant:** 3.10. Both training SQL and serving function must use the same constant. Document in `architecture.md`.
9. **`market_log_odds_home` is a float64, not a probability.** The model receives the log-odds directly; the logistic regression's own sigmoid maps it to a probability. Do not pre-convert to probability before passing to the model.
