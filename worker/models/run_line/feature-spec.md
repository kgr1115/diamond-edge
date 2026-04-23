# Run Line Model — Feature Specification

**Model:** Run line cover probability
**Target:** `P(home team covers −1.5 run line)` — binary, calibrated
**Date:** 2026-04-22
**Author:** mlb-ml-engineer

---

## Market-Specific Context

The run line in MLB is almost always set at ±1.5 runs. The home team covers −1.5 only if they win by 2+ runs. This market is structurally different from moneyline:

- A team winning 55% of games does **not** cover −1.5 55% of the time. Run-margin distribution matters.
- Home underdogs on the run line (+1.5) cover if they win OR lose by exactly 1 run.
- The run line is priced close to −110/−110 (coin-flip vig), making it harder to find edge but more stable than moneyline pricing.
- **Starter quality gap** is more predictive here than overall team quality — blowout potential requires dominant pitching.

---

## Leak Audit Protocol

Identical to `moneyline/feature-spec.md`. All features must be available at bet placement time. No outcome data from today's game is used.

---

## Shared Features from Moneyline

The run line model **reuses all 87 moneyline features** (see `moneyline/feature-spec.md`). The feature names and source tables are identical. Only the model training target changes: `home_covers_run_line` (1 if home wins by 2+, 0 otherwise).

Below are the **run-line-specific additional features** (features 88–107) that add predictive power for the margin-of-victory question.

---

## Run Line-Specific Features

### Category 14 — Pitcher Quality Gap

Difference between home and away pitcher quality. A large gap → higher probability of a blowout → run line cover more likely for the better-pitching team.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 88 | `sp_fip_gap` | `pitcher_game_logs` (G1) | `home_sp_fip_season − away_sp_fip_season`. Positive = away SP worse. | **PASS** |
| 89 | `sp_era_last_30d_gap` | `pitcher_game_logs` (G1) | `home_sp_era_last_30d − away_sp_era_last_30d` | **PASS** |
| 90 | `sp_k9_gap` | `pitcher_game_logs` (G1) | `home_sp_k9_season − away_sp_k9_season` | **PASS** |

### Category 15 — Run Margin Distribution Proxies

Features that predict whether a team wins *big* rather than just *whether* they win.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 91 | `home_team_run_margin_avg` | `team_game_logs` (G4) | Average run margin of home team wins this season (positive = wins by X runs on average) | **PASS** |
| 92 | `away_team_run_margin_avg` | `team_game_logs` (G4) | Average run margin of away team wins | **PASS** |
| 93 | `home_team_blowout_rate` | `team_game_logs` (G4) | Fraction of home team games decided by 3+ runs | **PASS** |
| 94 | `away_team_blowout_rate` | `team_game_logs` (G4) | Fraction of away team games decided by 3+ runs | **PASS** |
| 95 | `home_team_one_run_game_rate` | `team_game_logs` (G4) | Fraction of games decided by exactly 1 run (high = fragile, risky for −1.5) | **PASS** |
| 96 | `away_team_one_run_game_rate` | `team_game_logs` (G4) | Same for away team | **PASS** |

### Category 16 — ATS (Against The Spread) Historical Record

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 97 | `home_team_ats_home_win_pct` | Derived from `games` + historical outcomes (G8) | Home team's historical run-line cover rate in home games this season | **PASS** — prior games only |
| 98 | `away_team_ats_road_win_pct` | Derived from `games` + historical outcomes (G8) | Away team's run-line cover rate in road games | **PASS** |
| 99 | `home_team_rl_last10_cover_pct` | Derived from `games` (G8) | Run-line cover rate in last 10 games | **PASS** |

### Category 17 — Bullpen Depth for Lead Protection

The run line requires sustaining a 2-run lead. Bullpen quality and depth is especially critical.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 100 | `home_bp_save_rate_season` | `bullpen_usage` (G2) | Successful save conversions / total save opportunities | **PASS** |
| 101 | `away_bp_save_rate_season` | `bullpen_usage` (G2) | Away team save conversion rate | **PASS** |
| 102 | `home_bp_high_leverage_era` | `bullpen_usage` (G2) | Bullpen ERA in high-leverage situations (7th–9th inning, within 2 runs) | **PASS** — [DATA GAP G2: requires LI split] |
| 103 | `away_bp_high_leverage_era` | `bullpen_usage` (G2) | Same for away bullpen | **PASS** |

### Category 18 — Offense vs Run Prevention Matchup

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 104 | `home_ops_vs_away_sp_handedness` | `team_game_logs` (G4) + `players.throws` | Home team OPS split vs pitcher handedness (L or R) matching away SP | **PASS** — requires split stats from G4 |
| 105 | `away_ops_vs_home_sp_handedness` | `team_game_logs` (G4) + `players.throws` | Away team OPS split vs home SP handedness | **PASS** |

### Category 19 — Game Total (Market Prior for Margin)

The posted totals line encodes the market's expectation of total run scoring — a proxy for how many runs will be scored, which relates to blowout potential.

| # | `feature_name` | Source | Transformation | Leak Audit |
|---|---|---|---|---|
| 106 | `posted_total_line` | `odds` table (latest before prediction) | The actual over/under line (e.g., 8.5) | **PASS** |
| 107 | `moneyline_implied_run_line_prob` | `odds` table | Theoretical run-line cover probability derived from moneyline prices using Bradley-Terry model approximation | **PASS** — mathematical transformation of observable odds |

---

## Feature Count Summary

| Source | Features |
|---|---|
| Shared with moneyline | 87 |
| Run line-specific | 20 |
| **Total** | **107** |

---

## Target Variable Construction (for Training)

During backtesting and training, the `home_covers_run_line` label is computed from historical game results:

```python
def compute_run_line_cover(home_score: int, away_score: int, spread: float = -1.5) -> int:
    """
    Home team covers -1.5 if they win by 2 or more.
    Away team covers +1.5 if they win or lose by exactly 1.
    Returns 1 if home covers, 0 if not.
    """
    run_margin = home_score - away_score
    return int(run_margin + spread > 0)  # home_score - away_score - 1.5 > 0 → win by 2+
```

No pushes on ±1.5 run line (fractional spread eliminates push). Binary target is clean.

---

## Data Gaps

Inherits all gaps from moneyline (G1–G10), plus:

| Gap | Feature | Notes |
|---|---|---|
| G2 (extended) | `home_bp_high_leverage_era`, `away_bp_high_leverage_era` | Requires leverage-situation split from play-by-play data — v1.1 if unavailable |
| G4 (extended) | `home_ops_vs_away_sp_handedness` (platoon split OPS) | Requires L/R platoon OPS splits per team; add to `team_game_logs` spec |

---

## Feature Attribution Format

Same as moneyline. Example run-line-specific attributions:

```json
{
  "feature_name": "sp_fip_gap",
  "feature_value": 1.42,
  "shap_value": 0.27,
  "direction": "positive",
  "label": "Pitcher FIP Gap (Home vs Away): +1.42 (home SP advantage)"
}
```

```json
{
  "feature_name": "home_team_one_run_game_rate",
  "feature_value": 0.38,
  "shap_value": -0.14,
  "direction": "negative",
  "label": "Home Team 1-Run Game Rate: 38% (risky for -1.5 cover)"
}
```
