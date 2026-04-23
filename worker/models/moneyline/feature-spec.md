# Moneyline Model — Feature Specification

**Model:** Moneyline win probability
**Target:** `P(home team wins)` — binary, calibrated
**Date:** 2026-04-22
**Author:** mlb-ml-engineer

---

## Leak Audit Protocol

Every feature below is evaluated against this standard:
> **"Is this value observable without knowledge of the game's outcome, by a bettor placing a wager no earlier than game-day morning and no later than confirmed lineup posting (~60 min before first pitch)?"**

Features that fail this test are excluded. Features that become more accurate closer to first pitch (e.g., confirmed lineups) are noted — they require the pipeline to wait for lineup confirmation before final prediction.

---

## Feature List

### Category 1 — Home Starting Pitcher

Features reference the **home team's probable starter** (`games.probable_home_pitcher_id` → `players.id`).

| # | `feature_name` | Source Table / API | Transformation | Leak Audit |
|---|---|---|---|---|
| 1 | `home_sp_era_season` | `pitcher_game_logs` (G1) | Season ERA for home SP through yesterday | **PASS** — prior-day stats only |
| 2 | `home_sp_era_last_30d` | `pitcher_game_logs` (G1) | ERA over rolling 30-day window, trailing | **PASS** |
| 3 | `home_sp_era_last_10d` | `pitcher_game_logs` (G1) | ERA over rolling 10-day window, trailing | **PASS** |
| 4 | `home_sp_fip_season` | `pitcher_game_logs` (G1) | Season FIP (Fielding Independent Pitching) | **PASS** |
| 5 | `home_sp_xfip_season` | `statcast_pitcher_stats` (G3) | Season xFIP from Baseball Savant | **PASS** — [DATA GAP G3] |
| 6 | `home_sp_k9_season` | `pitcher_game_logs` (G1) | K/9 season | **PASS** |
| 7 | `home_sp_bb9_season` | `pitcher_game_logs` (G1) | BB/9 season | **PASS** |
| 8 | `home_sp_hr9_season` | `pitcher_game_logs` (G1) | HR/9 season | **PASS** |
| 9 | `home_sp_whip_season` | `pitcher_game_logs` (G1) | WHIP season | **PASS** |
| 10 | `home_sp_days_rest` | `pitcher_game_logs` (G1) | Days since last start (cap at 7; 0 = same-day bullpen start) | **PASS** |
| 11 | `home_sp_ip_last_start` | `pitcher_game_logs` (G1) | Innings pitched in most recent start (pitch load proxy) | **PASS** |
| 12 | `home_sp_throws` | `players.throws` | 0=L, 1=R (encoded) | **PASS** — static |
| 13 | `home_sp_era_vs_opp_season` | `pitcher_game_logs` (G1) | ERA against today's away team this season (min 3 IP; else impute season ERA) | **PASS** — prior games only |
| 14 | `home_sp_home_era` | `pitcher_game_logs` (G1) | ERA in home starts this season | **PASS** |
| 15 | `home_sp_is_confirmed` | `games.probable_home_pitcher_id` | 1 if pitcher confirmed (not just probable), 0 if still probable | **PASS** — feature signals uncertainty; model learns to discount unconfirmed |

### Category 2 — Away Starting Pitcher

Mirror of Category 1, prefixed `away_sp_*`. All same sources, same transformations, same leak audit.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 16 | `away_sp_era_season` | `pitcher_game_logs` | Season ERA | **PASS** |
| 17 | `away_sp_era_last_30d` | `pitcher_game_logs` | 30-day rolling ERA | **PASS** |
| 18 | `away_sp_era_last_10d` | `pitcher_game_logs` | 10-day rolling ERA | **PASS** |
| 19 | `away_sp_fip_season` | `pitcher_game_logs` | Season FIP | **PASS** |
| 20 | `away_sp_xfip_season` | `statcast_pitcher_stats` (G3) | Season xFIP | **PASS** — [DATA GAP G3] |
| 21 | `away_sp_k9_season` | `pitcher_game_logs` | Season K/9 | **PASS** |
| 22 | `away_sp_bb9_season` | `pitcher_game_logs` | Season BB/9 | **PASS** |
| 23 | `away_sp_hr9_season` | `pitcher_game_logs` | Season HR/9 | **PASS** |
| 24 | `away_sp_whip_season` | `pitcher_game_logs` | Season WHIP | **PASS** |
| 25 | `away_sp_days_rest` | `pitcher_game_logs` | Days since last start | **PASS** |
| 26 | `away_sp_ip_last_start` | `pitcher_game_logs` | IP in last start | **PASS** |
| 27 | `away_sp_throws` | `players.throws` | 0=L, 1=R | **PASS** |
| 28 | `away_sp_era_vs_opp_season` | `pitcher_game_logs` | ERA vs today's home team | **PASS** |
| 29 | `away_sp_road_era` | `pitcher_game_logs` | ERA in away starts | **PASS** |
| 30 | `away_sp_is_confirmed` | `games.probable_away_pitcher_id` | 1=confirmed, 0=probable | **PASS** |

### Category 3 — Home Bullpen

Bullpen defined as all non-starting pitchers who have appeared for the home team. Rolling windows are trailing (exclude today's game).

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 31 | `home_bp_era_last_7d` | `bullpen_usage` (G2) | Bullpen ERA over last 7 days | **PASS** |
| 32 | `home_bp_era_season` | `bullpen_usage` (G2) | Season bullpen ERA | **PASS** |
| 33 | `home_bp_ip_last_2d` | `bullpen_usage` (G2) | Bullpen innings pitched in last 2 days (fatigue signal) | **PASS** |
| 34 | `home_bp_ip_last_3d` | `bullpen_usage` (G2) | Bullpen IP in last 3 days | **PASS** |
| 35 | `home_bp_whip_last_7d` | `bullpen_usage` (G2) | Bullpen WHIP over last 7 days | **PASS** |
| 36 | `home_bp_sv_opp_last_7d` | `bullpen_usage` (G2) | Blown saves in last 7 days | **PASS** |

### Category 4 — Away Bullpen

Mirror of Category 3, prefixed `away_bp_*`.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 37 | `away_bp_era_last_7d` | `bullpen_usage` | 7-day ERA | **PASS** |
| 38 | `away_bp_era_season` | `bullpen_usage` | Season ERA | **PASS** |
| 39 | `away_bp_ip_last_2d` | `bullpen_usage` | IP last 2 days | **PASS** |
| 40 | `away_bp_ip_last_3d` | `bullpen_usage` | IP last 3 days | **PASS** |
| 41 | `away_bp_whip_last_7d` | `bullpen_usage` | 7-day WHIP | **PASS** |
| 42 | `away_bp_sv_opp_last_7d` | `bullpen_usage` | Blown saves last 7 days | **PASS** |

### Category 5 — Home Team Offense

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 43 | `home_team_ops_season` | `team_game_logs` (G4) | Team OPS season | **PASS** |
| 44 | `home_team_ops_last_14d` | `team_game_logs` (G4) | Team OPS rolling 14-day | **PASS** |
| 45 | `home_team_woba_season` | `team_game_logs` / Statcast (G4) | Team wOBA season | **PASS** — [DATA GAP G4] |
| 46 | `home_team_k_rate_season` | `team_game_logs` (G4) | Team K% season | **PASS** |
| 47 | `home_team_bb_rate_season` | `team_game_logs` (G4) | Team BB% season | **PASS** |
| 48 | `home_team_runs_pg_season` | `team_game_logs` (G4) | Runs scored per game, season | **PASS** |
| 49 | `home_team_runs_pg_last_14d` | `team_game_logs` (G4) | Runs per game, rolling 14-day | **PASS** |
| 50 | `home_team_batting_avg_season` | `team_game_logs` (G4) | Team batting average | **PASS** |

### Category 6 — Away Team Offense

Mirror of Category 5, prefixed `away_team_*`.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 51 | `away_team_ops_season` | `team_game_logs` | Team OPS season | **PASS** |
| 52 | `away_team_ops_last_14d` | `team_game_logs` | 14-day OPS | **PASS** |
| 53 | `away_team_woba_season` | `team_game_logs` / Statcast | Team wOBA season | **PASS** |
| 54 | `away_team_k_rate_season` | `team_game_logs` | Team K% | **PASS** |
| 55 | `away_team_bb_rate_season` | `team_game_logs` | Team BB% | **PASS** |
| 56 | `away_team_runs_pg_season` | `team_game_logs` | Runs per game season | **PASS** |
| 57 | `away_team_runs_pg_last_14d` | `team_game_logs` | 14-day runs per game | **PASS** |
| 58 | `away_team_batting_avg_season` | `team_game_logs` | Batting average | **PASS** |

### Category 7 — Team Record / Form

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 59 | `home_team_win_pct_season` | Derived from `games` (G8) | Home team W/(W+L) through yesterday | **PASS** |
| 60 | `home_team_win_pct_home` | Derived from `games` (G8) | Win % in home games only | **PASS** |
| 61 | `home_team_last10_win_pct` | Derived from `games` (G8) | Win % in last 10 games | **PASS** |
| 62 | `home_team_run_diff_pg` | Derived from `games` (G8) | Season run differential per game | **PASS** |
| 63 | `home_team_pythag_win_pct` | Derived from `games` (G9) | Pythagorean win % = RS² / (RS² + RA²) | **PASS** |
| 64 | `away_team_win_pct_season` | Derived from `games` (G8) | Away team overall W% | **PASS** |
| 65 | `away_team_win_pct_away` | Derived from `games` (G8) | Win % in away games | **PASS** |
| 66 | `away_team_last10_win_pct` | Derived from `games` (G8) | Last-10 win % | **PASS** |
| 67 | `away_team_run_diff_pg` | Derived from `games` (G8) | Run differential per game | **PASS** |
| 68 | `away_team_pythag_win_pct` | Derived from `games` (G9) | Pythagorean win % | **PASS** |
| 69 | `h2h_home_wins_pct_season` | Derived from `games` (G10) | H2H win % for home team this season (min 3 games; else 0.5) | **PASS** |

### Category 8 — Platoon Advantage

Computed from confirmed lineup handedness (`game_lineups`, G7) vs opposing starter's throwing hand (`players.throws`). If lineup not yet confirmed, use roster-based platoon estimate.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 70 | `home_platoon_advantage` | `game_lineups` (G7) + `players.throws` | Weighted platoon score: fraction of home lineup spots with handedness advantage vs away SP. L batter vs R pitcher = +1, R batter vs L pitcher = +1, same hand = 0. Normalized 0–1. | **PASS** — available at lineup posting |
| 71 | `away_platoon_advantage` | `game_lineups` (G7) + `players.throws` | Same as above for away lineup vs home SP | **PASS** |
| 72 | `home_lineup_confirmed` | `game_lineups` (G7) | 1 if official lineup posted, 0 if using roster estimate | **PASS** — signals uncertainty |

### Category 9 — Park Factors

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 73 | `park_run_factor` | `park_factors` (G5) | 5-year regressed park run factor (100 = average; Coors ≈ 115) | **PASS** — static reference, no leakage |
| 74 | `park_hr_factor` | `park_factors` (G5) | Park home run factor index | **PASS** |
| 75 | `park_is_dome` | `park_factors` (G5) | 1 if indoor/retractable (weather-independent) | **PASS** — static |

### Category 10 — Umpire

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 76 | `ump_k_rate_career` | `umpires` (G6) | Home plate umpire's career K-rate for batters faced | **PASS** — historical data |
| 77 | `ump_run_factor` | `umpires` (G6) | Umpire's run-per-game factor vs league average (career) | **PASS** |
| 78 | `ump_assigned` | `umpire_game_assignments` (G6) | 1 if umpire assignment confirmed for this game | **PASS** — signal for uncertainty |

**Note:** If umpire data gaps (G6) are not filled before model training, features 76–78 are dropped and added in v1.1.

### Category 11 — Weather

Weather from `games.weather_*` columns (populated by data engineer from weather API pre-game).

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 79 | `weather_temp_f` | `games.weather_temp_f` | Temperature at first pitch (F). Impute 72°F for domes. | **PASS** |
| 80 | `weather_wind_mph` | `games.weather_wind_mph` | Wind speed (mph) | **PASS** |
| 81 | `weather_wind_to_cf` | `games.weather_wind_dir` + stadium orientation | +1 if wind blowing to CF (offense favored), −1 if blowing in (pitcher favored), 0 if crosswind/dome. Requires stadium CF bearing per team. | **PASS** — derived from static bearing + real-time wind dir |
| 82 | `weather_is_dome` | `park_factors` (G5) | Duplicate of park_is_dome; used to zero-out weather features | **PASS** |

### Category 12 — Rest and Travel

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 83 | `home_team_days_rest` | Derived from `games` | Days since home team's last game (0 = consecutive day, cap at 4) | **PASS** |
| 84 | `away_team_days_rest` | Derived from `games` | Days since away team's last game | **PASS** |
| 85 | `away_team_travel_tz_change` | `teams.venue_state` + `games.venue_state` | Timezone difference (hours) between previous venue and today's venue for away team. Proxy for travel fatigue. | **PASS** |

### Category 13 — Market Signal

Market signal as an additional feature (not the primary signal — model learns when it disagrees with market).

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 86 | `market_implied_prob_home` | `odds` table (latest snapshot before bet placement) | Convert best home moneyline price to implied probability: positive odds (+150) → 100/(100+150); negative odds (−130) → 130/(130+100) | **PASS** — uses only pre-game odds |
| 87 | `line_move_direction` | `odds` table (first vs latest snapshot for game_date) | Opening line vs current line direction for home team: +1 (moved toward home), −1 (moved away), 0 (no move or insufficient data) | **PASS** |

---

## Feature Count Summary

| Category | Features | Data Gaps |
|---|---|---|
| Home SP | 15 | G1, G3 |
| Away SP | 15 | G1, G3 |
| Home Bullpen | 6 | G2 |
| Away Bullpen | 6 | G2 |
| Home Offense | 8 | G4 |
| Away Offense | 8 | G4 |
| Team Record / Form | 11 | G8, G9, G10 |
| Platoon | 3 | G7 |
| Park Factors | 3 | G5 |
| Umpire | 3 | G6 |
| Weather | 4 | — |
| Rest / Travel | 3 | — |
| Market Signal | 2 | — |
| **Total** | **87** | |

---

## Missing Value Handling

| Scenario | Treatment |
|---|---|
| SP not yet confirmed (probable only) | Use probable pitcher stats; `home_sp_is_confirmed = 0` signals uncertainty |
| Lineup not yet posted | Use roster-median handedness; `home_lineup_confirmed = 0` |
| Umpire not assigned | Impute league-average umpire run factor; `ump_assigned = 0` |
| Weather not yet available | Impute historical average for that park and month |
| Rookie pitcher (< 50 IP) | Impute league-average starter ERA/FIP; flag low sample |
| Rolling window (e.g., 30d) has < 5 games | Impute season average |

---

## Categorical Encoding

| Feature | Encoding |
|---|---|
| `home_sp_throws`, `away_sp_throws` | Binary: 0=L, 1=R |
| `weather_wind_to_cf` | Ordinal: −1, 0, +1 |
| `line_move_direction` | Ordinal: −1, 0, +1 |
| All other features | Numeric (no further encoding needed for LightGBM) |

---

## Data Gaps Requiring TASK-004 Action

| Gap | Tables Needed | Priority |
|---|---|---|
| G1 | `pitcher_game_logs` (SP game-by-game stats) | **Critical** — 30 features blocked |
| G2 | `bullpen_usage` (daily bullpen IP/ERA by team) | **Critical** — 12 features blocked |
| G3 | `statcast_pitcher_stats` (xFIP, Stuff+) | **Important** — 2 features blocked; can use FIP as proxy if delayed |
| G4 | `team_game_logs` (daily team offensive stats) | **Critical** — 16 features blocked |
| G5 | `park_factors` (run/HR factor per park) | **Critical for totals** — 3 features; static table, one-time load |
| G6 | `umpires` + `umpire_game_assignments` | **Nice-to-have v1** — 3 features; drop if delayed |
| G7 | `game_lineups` (confirmed batting order with handedness) | **Important** — 3 features; can impute with roster data |
| G8 | Team record computed views | **Important** — 11 features; derivable from existing `games` table |
| G9 | Pythagorean win % computed view | **Minor** — 2 features; derivable |
| G10 | H2H computed view | **Minor** — 1 feature; derivable |

---

## Feature Attribution Format (SHAP Output)

Each feature above generates a `FeatureAttribution` entry in the `PickCandidate.feature_attributions` array. The top 7 features by `|shap_value|` are included (sufficient for AI Reasoning; manageable for UI display).

Example attribution for a home team pick:

```json
{
  "feature_name": "home_sp_era_last_30d",
  "feature_value": 2.14,
  "shap_value": 0.31,
  "direction": "positive",
  "label": "Home Starter ERA (30-day): 2.14"
}
```

```json
{
  "feature_name": "away_bp_ip_last_2d",
  "feature_value": 7.2,
  "shap_value": 0.18,
  "direction": "positive",
  "label": "Away Bullpen Load (2-day IP): 7.2"
}
```

```json
{
  "feature_name": "weather_wind_to_cf",
  "feature_value": -1,
  "shap_value": -0.08,
  "direction": "negative",
  "label": "Wind Direction: Blowing In (pitcher-favored)"
}
```

**Label formatting rules:**
- Numeric features: `"{Human Name}: {value}"`
- Ordinal features: `"{Human Name}: {human-readable description}"`
- Always round numeric values to 2 decimal places in the label string
