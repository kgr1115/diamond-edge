# Totals Model — Feature Specification

**Model:** Game total run probability
**Target:** `P(total runs > posted line)` — binary, calibrated
**Date:** 2026-04-22
**Author:** mlb-ml-engineer

---

## Market-Specific Context

The totals market (over/under) is the most environment-sensitive MLB market. The key drivers are:

1. **Pitcher quality** — Both starters' run-prevention ability is the single strongest predictor
2. **Park factor** — Coors Field alone can shift expected runs by 15%; must park-adjust all stats
3. **Weather** — Wind direction and speed at game-time directly affect fly ball distance and run scoring; temperature affects air density
4. **Bullpen quality** — Later-inning scoring contributes meaningfully to totals
5. **Offense quality** — Both offenses' ability to generate runs

The posted total line is itself a strong prior — the model's job is to find edges where the actual run-scoring probability differs from the market's implied probability. Games where weather changed significantly from when the line was set are prime candidates.

**Model note:** The totals model does **not** predict moneyline or run line. It produces `P(over)` only. `P(under) = 1 − P(over)`. Pushes (total exactly equals the line, e.g., 9 runs on a 9.0 line) are excluded from training — only half-run lines (e.g., 8.5) produce clean binary outcomes. For whole-number lines, push probability is small (~3–5%) but not zero; include only the over/under binary outcome, exclude pushes from training labels.

---

## Leak Audit Protocol

Identical to moneyline and run line specs. All features must be observable before first pitch.

---

## Feature List

### Category 1 — Home Starting Pitcher (Run Prevention)

Focuses on metrics most predictive of runs allowed, not wins.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 1 | `home_sp_era_season` | `pitcher_game_logs` (G1) | Season ERA | **PASS** |
| 2 | `home_sp_era_last_30d` | `pitcher_game_logs` (G1) | 30-day rolling ERA | **PASS** |
| 3 | `home_sp_fip_season` | `pitcher_game_logs` (G1) | Season FIP | **PASS** |
| 4 | `home_sp_xfip_season` | `statcast_pitcher_stats` (G3) | Season xFIP | **PASS** — [DATA GAP G3] |
| 5 | `home_sp_k9_season` | `pitcher_game_logs` (G1) | K/9 (strikeouts limit scoring) | **PASS** |
| 6 | `home_sp_bb9_season` | `pitcher_game_logs` (G1) | BB/9 (walks increase scoring) | **PASS** |
| 7 | `home_sp_hr9_season` | `pitcher_game_logs` (G1) | HR/9 (home runs are big scoring events) | **PASS** |
| 8 | `home_sp_lob_pct_season` | `pitcher_game_logs` (G1) | Left-on-base % season (LOB% — strand rate; high = fewer runs despite baserunners) | **PASS** |
| 9 | `home_sp_barrel_rate_against` | `statcast_pitcher_stats` (G3) | Barrel rate allowed (Statcast) — hard contact predictor | **PASS** — [DATA GAP G3] |
| 10 | `home_sp_days_rest` | `pitcher_game_logs` (G1) | Days rest (0–7+) | **PASS** |
| 11 | `home_sp_ip_last_start` | `pitcher_game_logs` (G1) | IP in last start | **PASS** |
| 12 | `home_sp_throws` | `players.throws` | 0=L, 1=R | **PASS** |
| 13 | `home_sp_is_confirmed` | `games.probable_home_pitcher_id` | 1=confirmed, 0=probable | **PASS** |

### Category 2 — Away Starting Pitcher (Run Prevention)

Mirror of Category 1, prefixed `away_sp_*`.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 14 | `away_sp_era_season` | `pitcher_game_logs` | Season ERA | **PASS** |
| 15 | `away_sp_era_last_30d` | `pitcher_game_logs` | 30-day ERA | **PASS** |
| 16 | `away_sp_fip_season` | `pitcher_game_logs` | Season FIP | **PASS** |
| 17 | `away_sp_xfip_season` | `statcast_pitcher_stats` (G3) | Season xFIP | **PASS** |
| 18 | `away_sp_k9_season` | `pitcher_game_logs` | K/9 | **PASS** |
| 19 | `away_sp_bb9_season` | `pitcher_game_logs` | BB/9 | **PASS** |
| 20 | `away_sp_hr9_season` | `pitcher_game_logs` | HR/9 | **PASS** |
| 21 | `away_sp_lob_pct_season` | `pitcher_game_logs` | LOB% | **PASS** |
| 22 | `away_sp_barrel_rate_against` | `statcast_pitcher_stats` (G3) | Barrel rate allowed | **PASS** |
| 23 | `away_sp_days_rest` | `pitcher_game_logs` | Days rest | **PASS** |
| 24 | `away_sp_ip_last_start` | `pitcher_game_logs` | IP last start | **PASS** |
| 25 | `away_sp_throws` | `players.throws` | 0=L, 1=R | **PASS** |
| 26 | `away_sp_is_confirmed` | `games.probable_away_pitcher_id` | 1=confirmed | **PASS** |

### Category 3 — Combined Pitcher Quality (Totals Composite)

Derived features combining both starters. These capture the "pitching environment" of the game.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 27 | `combined_sp_era_season` | Derived | `home_sp_era_season + away_sp_era_season` | **PASS** |
| 28 | `combined_sp_fip_season` | Derived | `home_sp_fip_season + away_sp_fip_season` | **PASS** |
| 29 | `combined_sp_k9_season` | Derived | `home_sp_k9_season + away_sp_k9_season` | **PASS** |
| 30 | `combined_sp_bb9_season` | Derived | `home_sp_bb9_season + away_sp_bb9_season` | **PASS** |

### Category 4 — Home Bullpen (Run Prevention)

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 31 | `home_bp_era_season` | `bullpen_usage` (G2) | Season bullpen ERA | **PASS** |
| 32 | `home_bp_era_last_7d` | `bullpen_usage` (G2) | 7-day rolling bullpen ERA | **PASS** |
| 33 | `home_bp_ip_last_2d` | `bullpen_usage` (G2) | Bullpen load: IP last 2 days | **PASS** |
| 34 | `home_bp_ip_last_3d` | `bullpen_usage` (G2) | Bullpen load: IP last 3 days | **PASS** |
| 35 | `home_bp_whip_last_7d` | `bullpen_usage` (G2) | 7-day WHIP | **PASS** |

### Category 5 — Away Bullpen (Run Prevention)

Mirror of Category 4, prefixed `away_bp_*`.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 36 | `away_bp_era_season` | `bullpen_usage` | Season ERA | **PASS** |
| 37 | `away_bp_era_last_7d` | `bullpen_usage` | 7-day ERA | **PASS** |
| 38 | `away_bp_ip_last_2d` | `bullpen_usage` | IP last 2 days | **PASS** |
| 39 | `away_bp_ip_last_3d` | `bullpen_usage` | IP last 3 days | **PASS** |
| 40 | `away_bp_whip_last_7d` | `bullpen_usage` | 7-day WHIP | **PASS** |

### Category 6 — Home Team Offense (Run Scoring)

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 41 | `home_team_ops_season` | `team_game_logs` (G4) | Team OPS season | **PASS** |
| 42 | `home_team_ops_last_14d` | `team_game_logs` (G4) | OPS last 14 days | **PASS** |
| 43 | `home_team_woba_season` | `team_game_logs` (G4) | wOBA season | **PASS** |
| 44 | `home_team_runs_pg_season` | `team_game_logs` (G4) | Runs per game | **PASS** |
| 45 | `home_team_runs_pg_last_14d` | `team_game_logs` (G4) | Runs per game rolling 14d | **PASS** |
| 46 | `home_team_hr_pg_season` | `team_game_logs` (G4) | Home runs per game (park-sensitive) | **PASS** |
| 47 | `home_team_k_rate_season` | `team_game_logs` (G4) | Team K% | **PASS** |
| 48 | `home_team_bb_rate_season` | `team_game_logs` (G4) | Team BB% | **PASS** |
| 49 | `home_team_iso_season` | `team_game_logs` (G4) | Isolated power (SLG − AVG) — extra base hit rate | **PASS** |

### Category 7 — Away Team Offense (Run Scoring)

Mirror of Category 6, prefixed `away_team_*`.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 50 | `away_team_ops_season` | `team_game_logs` | Season OPS | **PASS** |
| 51 | `away_team_ops_last_14d` | `team_game_logs` | 14-day OPS | **PASS** |
| 52 | `away_team_woba_season` | `team_game_logs` | wOBA season | **PASS** |
| 53 | `away_team_runs_pg_season` | `team_game_logs` | Runs per game | **PASS** |
| 54 | `away_team_runs_pg_last_14d` | `team_game_logs` | 14-day runs per game | **PASS** |
| 55 | `away_team_hr_pg_season` | `team_game_logs` | HR per game | **PASS** |
| 56 | `away_team_k_rate_season` | `team_game_logs` | K% | **PASS** |
| 57 | `away_team_bb_rate_season` | `team_game_logs` | BB% | **PASS** |
| 58 | `away_team_iso_season` | `team_game_logs` | ISO | **PASS** |

### Category 8 — Combined Offense (Run Environment)

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 59 | `combined_ops_season` | Derived | `home_team_ops_season + away_team_ops_season` | **PASS** |
| 60 | `combined_runs_pg_season` | Derived | Sum of both teams' runs/game (total run environment proxy) | **PASS** |
| 61 | `combined_hr_pg_season` | Derived | Sum of HR/game | **PASS** |

### Category 9 — Park Factors (Critical for Totals)

Park factors are the most important totals-specific adjustments. All pitcher and offense stats above should be park-neutral (based on opponent performance) but the park factor is explicitly added as a feature.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 62 | `park_run_factor` | `park_factors` (G5) | 5-year regressed run factor (100=avg; Coors≈115, Petco≈94) | **PASS** — static |
| 63 | `park_hr_factor` | `park_factors` (G5) | HR factor index | **PASS** |
| 64 | `park_is_dome` | `park_factors` (G5) | 1=indoor/retractable (weather-neutral) | **PASS** |
| 65 | `park_historical_ou_over_rate` | Derived from `games` history | Fraction of games at this park that went over their posted total (season and career) | **PASS** — prior games only |
| 66 | `park_avg_total_scored` | Derived from `games` history | Average actual runs scored at this park this season | **PASS** |

### Category 10 — Weather (Critical for Totals)

Weather is more predictive for totals than for moneyline. Cold weather reduces HR distance; wind to CF is a batting practice setup; high humidity slightly favors offense.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 67 | `weather_temp_f` | `games.weather_temp_f` | Temperature at first pitch. Impute 72°F for domes. Cold (<50°F) suppresses HR. | **PASS** |
| 68 | `weather_temp_deviation_from_avg` | `games.weather_temp_f` + historical avg | Deviation from park's monthly historical average temp (captures unusual cold/heat) | **PASS** |
| 69 | `weather_wind_mph` | `games.weather_wind_mph` | Wind speed (mph). Zero for domes. | **PASS** |
| 70 | `weather_wind_to_cf` | `games.weather_wind_dir` + stadium CF bearing | +1=blowing out to CF (offense boost), −1=blowing in (pitcher favored), 0=crosswind or dome | **PASS** |
| 71 | `weather_wind_factor` | Derived | `weather_wind_mph × weather_wind_to_cf` — signed magnitude (e.g., +15 = 15mph to CF, −12 = 12mph in) | **PASS** |
| 72 | `weather_is_dome` | `park_factors` (G5) | 1=dome; zeroes out all weather features at inference time | **PASS** |

**Weather-to-CF stadium bearing reference table** (required for `weather_wind_to_cf` computation — static data, not schema-dependent):

This bearing table maps each MLB park's center field compass direction and is hardcoded in the feature engineering pipeline. It is updated only when teams move stadiums (rare).

### Category 11 — Market Signal (Posted Line)

The totals posted line is not used as-is for prediction — it encodes what the market already believes. The model's job is to find games where the posted line differs from the model's expected runs.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 73 | `posted_total_line` | `odds` table (latest before prediction) | Posted over/under number (e.g., 8.5) | **PASS** |
| 74 | `implied_over_probability` | `odds` table | Convert best over/under prices to implied probability: `100/(100+odds)` for plus odds | **PASS** |
| 75 | `total_line_move_direction` | `odds` table (first vs latest for game_date) | +1 if line moved up (more runs expected), −1 if down, 0 if flat | **PASS** |

### Category 12 — Rest and Context

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 76 | `home_team_days_rest` | Derived from `games` | Days since last game | **PASS** |
| 77 | `away_team_days_rest` | Derived from `games` | Days since last game | **PASS** |
| 78 | `game_is_doubleheader` | `games` | 1 if part of a doubleheader (7-inning games have different scoring profiles) | **PASS** |

### Category 13 — Historical Scoring Patterns

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 79 | `home_team_ou_over_rate_season` | Derived from `games` + `odds` history | Fraction of home team's games this season that went over their posted total | **PASS** |
| 80 | `away_team_ou_over_rate_season` | Derived from `games` + `odds` history | Same for away team | **PASS** |
| 81 | `h2h_avg_total_scored_season` | Derived from `games` history | Average runs scored in matchups between these two teams this season (min 3 games) | **PASS** |

---

## Feature Count Summary

| Category | Features | Key Data Gaps |
|---|---|---|
| Home SP (run prevention) | 13 | G1, G3 |
| Away SP (run prevention) | 13 | G1, G3 |
| Combined SP composite | 4 | — |
| Home Bullpen | 5 | G2 |
| Away Bullpen | 5 | G2 |
| Home Offense | 9 | G4 |
| Away Offense | 9 | G4 |
| Combined Offense | 3 | — |
| Park Factors | 5 | G5 |
| Weather | 6 | — |
| Market Signal | 3 | — |
| Rest / Context | 3 | — |
| Historical Scoring | 3 | — |
| **Total** | **81** | |

---

## Target Variable Construction (for Training)

```python
def compute_over_cover(home_score: int, away_score: int, total_line: float) -> int | None:
    """
    Returns 1 if over, 0 if under, None if push (only for whole-number lines).
    Push rows are excluded from the training dataset.
    """
    total_runs = home_score + away_score
    if total_runs > total_line:
        return 1
    elif total_runs < total_line:
        return 0
    else:
        return None  # push — exclude from training
```

**Important:** The model is trained on the `P(over)` side. To generate an under pick, the model outputs `1 - P(over)` and checks EV against the under price.

---

## Park Factor Application

All pitcher and team offensive stats in the database reflect raw (non-park-adjusted) statistics because players play at many parks. The model learns park adjustments from `park_run_factor`. This is the correct approach — do not pre-adjust stats; let the model learn the interaction. SHAP values on `park_run_factor` will correctly attribute park effects in the rationale.

---

## Weather Feature Pipeline

For the `weather_wind_to_cf` feature, the inference pipeline must:

1. Look up the game's venue from `games.venue_name`
2. Look up the CF bearing from the hardcoded stadium bearing table (embedded in the feature engineering module)
3. Convert `games.weather_wind_dir` (e.g., "NW", "SE", "SSW") to degrees
4. Compute dot product with CF bearing to determine wind contribution
5. Return +1 (to CF), −1 (from CF), or 0 (crosswind, within ±45° of orthogonal)

If `park_is_dome = 1`, set `weather_wind_to_cf = 0`, `weather_wind_mph = 0`, `weather_temp_f = 72`.

---

## Data Gaps

| Gap | Impact | Priority |
|---|---|---|
| G1 (pitcher logs) | 26 features blocked | Critical |
| G2 (bullpen usage) | 10 features blocked | Critical |
| G3 (Statcast) | 4 features blocked; FIP is fallback | Important |
| G4 (team game logs) | 18 features blocked | Critical |
| G5 (park factors) | 5 features blocked; **hardest to impute** | Critical |

**Park factors note:** `park_factors` is a one-time static load from Statcast/Baseball Reference. It changes only at season start. Data engineer should load this table before any model training runs. It is small (~30 rows, one per MLB park).

---

## Feature Attribution Format

Example totals-specific attributions:

```json
{
  "feature_name": "weather_wind_factor",
  "feature_value": 18,
  "shap_value": 0.41,
  "direction": "positive",
  "label": "Wind: 18 mph blowing out to CF (offense-favored conditions)"
}
```

```json
{
  "feature_name": "park_run_factor",
  "feature_value": 114,
  "shap_value": 0.29,
  "direction": "positive",
  "label": "Park Run Factor: 114 (well above average — Coors Field effect)"
}
```

```json
{
  "feature_name": "combined_sp_fip_season",
  "feature_value": 6.82,
  "shap_value": 0.23,
  "direction": "positive",
  "label": "Combined Starter FIP: 6.82 (both pitchers below average run prevention)"
}
```

```json
{
  "feature_name": "weather_temp_f",
  "feature_value": 41,
  "shap_value": -0.19,
  "direction": "negative",
  "label": "Temperature: 41°F (cold air suppresses home run distance)"
}
```
