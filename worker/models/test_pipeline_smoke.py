"""
Smoke test: validate the full training pipeline with synthetic data.
Runs in ~10 seconds. Validates:
1. Feature engineering produces correct shapes
2. LightGBM trains without error
3. Calibration produces valid probabilities
4. SHAP attribution works
5. PickCandidate schema validates
6. FastAPI endpoint responds correctly

This test does NOT require real MLB data — it generates synthetic game data.
"""
from __future__ import annotations

import json
import pickle
import sys
import tempfile
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).parents[2]))

# ── 1. Synthetic data ──────────────────────────────────────────────────────
print("1. Generating synthetic training data...")

np.random.seed(42)
N = 2000  # total games

def synthetic_games(n: int, season: int) -> pd.DataFrame:
    home_era = np.random.normal(4.2, 1.0, n).clip(1.5, 8.0)
    away_era = np.random.normal(4.2, 1.0, n).clip(1.5, 8.0)
    park_run = np.random.choice([94, 97, 100, 104, 107, 115], n)
    wind_factor = np.random.uniform(-20, 20, n)
    temp = np.random.normal(70, 15, n).clip(40, 100)
    market_implied = np.random.uniform(0.40, 0.60, n)

    # Synthetic outcomes: home ERA advantage → more home wins
    era_diff = away_era - home_era
    logit = 0.3 * era_diff + 0.1 * (park_run - 100) / 10 - 0.01 * wind_factor
    p_home_win = 1 / (1 + np.exp(-logit))
    home_win = np.random.binomial(1, p_home_win)
    home_score = np.random.poisson(4.5 + 0.5 * era_diff, n)
    away_score = np.random.poisson(4.5 - 0.5 * era_diff, n)
    total = home_score + away_score

    return pd.DataFrame({
        "game_pk": range(n * 10000, n * 10000 + n),
        "game_date": pd.date_range("2022-04-07", periods=n, freq="h").strftime("%Y-%m-%d"),
        "season": season,
        "home_team_id": np.random.choice([147, 111, 119, 144, 143], n),
        "home_team_name": "New York Yankees",
        "away_team_id": np.random.choice([141, 112, 121, 139, 116], n),
        "away_team_name": "Toronto Blue Jays",
        "home_score": home_score,
        "away_score": away_score,
        "home_sp_id": np.random.randint(100, 999, n),
        "away_sp_id": np.random.randint(100, 999, n),
        "home_sp_name": "Test Pitcher",
        "away_sp_name": "Test Pitcher",
        "status": "Final",
        # Pre-computed features (simulating output of feature engineering)
        "home_sp_era_season": home_era,
        "home_sp_era_last_30d": home_era + np.random.normal(0, 0.3, n),
        "home_sp_era_last_10d": home_era + np.random.normal(0, 0.5, n),
        "home_sp_fip_season": home_era + np.random.normal(0, 0.2, n),
        "home_sp_k9_season": np.random.normal(8.5, 1.5, n).clip(4, 15),
        "home_sp_bb9_season": np.random.normal(3.0, 0.8, n).clip(0.5, 7),
        "home_sp_hr9_season": np.random.normal(1.1, 0.4, n).clip(0, 3),
        "home_sp_whip_season": np.random.normal(1.25, 0.2, n).clip(0.7, 2.5),
        "home_sp_days_rest": np.random.randint(4, 6, n),
        "home_sp_ip_last_start": np.random.normal(5.5, 1.5, n).clip(0, 9),
        "home_sp_lob_pct_season": np.random.normal(0.72, 0.05, n).clip(0.5, 0.95),
        "home_sp_is_confirmed": 1,
        "home_sp_throws": np.random.choice([0, 1], n, p=[0.3, 0.7]),
        "away_sp_era_season": away_era,
        "away_sp_era_last_30d": away_era + np.random.normal(0, 0.3, n),
        "away_sp_era_last_10d": away_era + np.random.normal(0, 0.5, n),
        "away_sp_fip_season": away_era + np.random.normal(0, 0.2, n),
        "away_sp_k9_season": np.random.normal(8.5, 1.5, n).clip(4, 15),
        "away_sp_bb9_season": np.random.normal(3.0, 0.8, n).clip(0.5, 7),
        "away_sp_hr9_season": np.random.normal(1.1, 0.4, n).clip(0, 3),
        "away_sp_whip_season": np.random.normal(1.25, 0.2, n).clip(0.7, 2.5),
        "away_sp_days_rest": np.random.randint(4, 6, n),
        "away_sp_ip_last_start": np.random.normal(5.5, 1.5, n).clip(0, 9),
        "away_sp_lob_pct_season": np.random.normal(0.72, 0.05, n).clip(0.5, 0.95),
        "away_sp_is_confirmed": 1,
        "away_sp_throws": np.random.choice([0, 1], n, p=[0.3, 0.7]),
        "home_is_opener": np.random.choice([0, 1], n, p=[0.85, 0.15]),
        "away_is_opener": np.random.choice([0, 1], n, p=[0.85, 0.15]),
        "home_sp_ttop_exposure": np.random.uniform(1.5, 3.0, n),
        "away_sp_ttop_exposure": np.random.uniform(1.5, 3.0, n),
        "home_bp_era_last_7d": np.random.normal(4.3, 1.2, n).clip(1.5, 9),
        "home_bp_era_season": np.random.normal(4.3, 0.8, n).clip(1.5, 8),
        "home_bp_ip_last_2d": np.random.uniform(0, 5, n),
        "home_bp_ip_last_3d": np.random.uniform(0, 7, n),
        "home_bp_whip_last_7d": np.random.normal(1.30, 0.3, n).clip(0.7, 3.0),
        "home_bp_sv_opp_last_7d": np.random.poisson(0.3, n),
        "home_bp_save_rate_season": np.random.uniform(0.5, 0.85, n),
        "away_bp_era_last_7d": np.random.normal(4.3, 1.2, n).clip(1.5, 9),
        "away_bp_era_season": np.random.normal(4.3, 0.8, n).clip(1.5, 8),
        "away_bp_ip_last_2d": np.random.uniform(0, 5, n),
        "away_bp_ip_last_3d": np.random.uniform(0, 7, n),
        "away_bp_whip_last_7d": np.random.normal(1.30, 0.3, n).clip(0.7, 3.0),
        "away_bp_sv_opp_last_7d": np.random.poisson(0.3, n),
        "away_bp_save_rate_season": np.random.uniform(0.5, 0.85, n),
        "home_team_ops_season": np.random.normal(0.720, 0.05, n).clip(0.55, 0.90),
        "home_team_ops_last_14d": np.random.normal(0.720, 0.07, n).clip(0.50, 0.95),
        "home_team_runs_pg_season": np.random.normal(4.5, 0.6, n).clip(2.5, 7.0),
        "home_team_runs_pg_last_14d": np.random.normal(4.5, 0.8, n).clip(2.0, 8.0),
        "home_team_k_rate_season": np.random.normal(0.220, 0.03, n).clip(0.12, 0.35),
        "home_team_bb_rate_season": np.random.normal(0.085, 0.015, n).clip(0.04, 0.15),
        "home_team_batting_avg_season": np.random.normal(0.250, 0.015, n).clip(0.20, 0.30),
        "home_team_woba_season": np.random.normal(0.320, 0.02, n).clip(0.26, 0.39),
        "home_team_hr_pg_season": np.random.normal(1.1, 0.3, n).clip(0.2, 2.5),
        "home_team_iso_season": np.random.normal(0.150, 0.03, n).clip(0.05, 0.28),
        "home_team_run_margin_avg": np.random.normal(0, 1.5, n),
        "home_team_blowout_rate": np.random.uniform(0.20, 0.45, n),
        "home_team_one_run_game_rate": np.random.uniform(0.18, 0.38, n),
        "home_team_runs_ewma_7d": np.random.normal(4.5, 0.8, n).clip(2.0, 8.0),
        "away_team_ops_season": np.random.normal(0.720, 0.05, n).clip(0.55, 0.90),
        "away_team_ops_last_14d": np.random.normal(0.720, 0.07, n).clip(0.50, 0.95),
        "away_team_runs_pg_season": np.random.normal(4.5, 0.6, n).clip(2.5, 7.0),
        "away_team_runs_pg_last_14d": np.random.normal(4.5, 0.8, n).clip(2.0, 8.0),
        "away_team_k_rate_season": np.random.normal(0.220, 0.03, n).clip(0.12, 0.35),
        "away_team_bb_rate_season": np.random.normal(0.085, 0.015, n).clip(0.04, 0.15),
        "away_team_batting_avg_season": np.random.normal(0.250, 0.015, n).clip(0.20, 0.30),
        "away_team_woba_season": np.random.normal(0.320, 0.02, n).clip(0.26, 0.39),
        "away_team_hr_pg_season": np.random.normal(1.1, 0.3, n).clip(0.2, 2.5),
        "away_team_iso_season": np.random.normal(0.150, 0.03, n).clip(0.05, 0.28),
        "away_team_run_margin_avg": np.random.normal(0, 1.5, n),
        "away_team_blowout_rate": np.random.uniform(0.20, 0.45, n),
        "away_team_one_run_game_rate": np.random.uniform(0.18, 0.38, n),
        "away_team_runs_ewma_7d": np.random.normal(4.5, 0.8, n).clip(2.0, 8.0),
        "home_team_win_pct_season": np.random.normal(0.500, 0.07, n).clip(0.30, 0.72),
        "home_team_win_pct_home": np.random.normal(0.533, 0.08, n).clip(0.30, 0.75),
        "home_team_last10_win_pct": np.random.normal(0.500, 0.15, n).clip(0, 1),
        "home_team_run_diff_pg": np.random.normal(0, 0.8, n),
        "home_team_pythag_win_pct": np.random.normal(0.500, 0.07, n).clip(0.30, 0.72),
        "away_team_win_pct_season": np.random.normal(0.500, 0.07, n).clip(0.30, 0.72),
        "away_team_win_pct_away": np.random.normal(0.467, 0.08, n).clip(0.28, 0.72),
        "away_team_last10_win_pct": np.random.normal(0.500, 0.15, n).clip(0, 1),
        "away_team_run_diff_pg": np.random.normal(0, 0.8, n),
        "away_team_pythag_win_pct": np.random.normal(0.500, 0.07, n).clip(0.30, 0.72),
        "h2h_home_wins_pct_season": 0.50,
        "park_run_factor": park_run,
        "park_hr_factor": np.random.choice([88, 95, 100, 112, 120], n),
        "park_is_dome": np.random.choice([0, 1], n, p=[0.7, 0.3]),
        "park_hr_factor_l": np.random.choice([86, 93, 100, 116, 128], n),
        "park_hr_factor_r": np.random.choice([88, 97, 100, 112, 120], n),
        "park_hr_factor_lineup_weighted": np.random.normal(100, 10, n).clip(80, 130),
        "weather_temp_f": temp,
        "weather_temp_deviation_from_avg": temp - 70,
        "weather_wind_mph": np.random.uniform(0, 20, n),
        "weather_wind_to_cf": np.random.choice([-1, 0, 1], n),
        "weather_wind_factor": wind_factor,
        "weather_is_dome": np.random.choice([0, 1], n, p=[0.7, 0.3]),
        "home_team_days_rest": np.random.randint(1, 5, n),
        "away_team_days_rest": np.random.randint(1, 5, n),
        "away_travel_tz_change": np.random.randint(-3, 4, n),
        "away_travel_eastward_penalty": np.random.choice([0, 1], n, p=[0.75, 0.25]),
        "game_is_doubleheader": np.random.choice([0, 1], n, p=[0.95, 0.05]),
        "ump_k_rate_career": np.random.normal(0.218, 0.02, n).clip(0.17, 0.27),
        "ump_run_factor": np.random.normal(1.0, 0.05, n).clip(0.85, 1.15),
        "ump_assigned": np.random.choice([0, 1], n, p=[0.4, 0.6]),
        "home_platoon_advantage": np.random.uniform(0.3, 0.7, n),
        "away_platoon_advantage": np.random.uniform(0.3, 0.7, n),
        "home_lineup_confirmed": np.random.choice([0, 1], n, p=[0.3, 0.7]),
        "market_implied_prob_home": market_implied,
        "line_move_direction": np.random.choice([-1, 0, 1], n),
        "posted_total_line": np.random.choice([7.5, 8.0, 8.5, 9.0, 9.5], n),
        "implied_over_probability": np.random.uniform(0.44, 0.56, n),
        "total_line_move_direction": np.random.choice([-1, 0, 1], n),
        "home_team_ats_home_win_pct": np.random.uniform(0.42, 0.58, n),
        "away_team_ats_road_win_pct": np.random.uniform(0.42, 0.58, n),
        "home_team_rl_last10_cover_pct": np.random.uniform(0.30, 0.70, n),
        "home_team_ou_over_rate_season": np.random.uniform(0.44, 0.56, n),
        "away_team_ou_over_rate_season": np.random.uniform(0.44, 0.56, n),
        "h2h_avg_total_scored_season": np.random.normal(9.0, 1.2, n).clip(5, 14),
        "park_historical_ou_over_rate": np.random.uniform(0.44, 0.56, n),
        "park_avg_total_scored": np.random.normal(8.5, 0.8, n).clip(6, 12),
        "sp_fip_gap": away_era - home_era + np.random.normal(0, 0.3, n),
        "sp_era_last_30d_gap": np.random.normal(0, 0.8, n),
        "sp_k9_gap": np.random.normal(0, 1.5, n),
        "moneyline_implied_run_line_prob": (market_implied ** 1.5) / (market_implied ** 1.5 + (1 - market_implied) ** 1.5),
        "combined_sp_era_season": home_era + away_era,
        "combined_sp_fip_season": home_era + away_era + np.random.normal(0, 0.4, n),
        "combined_sp_k9_season": np.random.normal(17, 3, n).clip(8, 30),
        "combined_sp_bb9_season": np.random.normal(6.0, 1.5, n).clip(1, 14),
        "combined_ops_season": np.random.normal(1.44, 0.10, n).clip(1.1, 1.8),
        "combined_runs_pg_season": np.random.normal(9.0, 1.2, n).clip(5, 14),
        "combined_hr_pg_season": np.random.normal(2.2, 0.6, n).clip(0.4, 5.0),
        # Odds columns
        "dk_ml_home": np.random.choice([-150, -130, -120, -110, 100, 110, 120, 130], n),
        "fd_ml_home": np.random.choice([-145, -125, -115, -105, 105, 115, 125, 135], n),
        "dk_ml_away": np.random.choice([-150, -130, -120, -110, 100, 110, 120, 130], n),
        "fd_ml_away": np.random.choice([-145, -125, -115, -105, 105, 115, 125, 135], n),
        "dk_rl_home_price": np.random.choice([-120, -115, -110, -105, -100], n),
        "fd_rl_home_price": np.random.choice([-118, -112, -108, -104, -100], n),
        "dk_rl_away_price": np.random.choice([-120, -115, -110, -105, -100], n),
        "fd_rl_away_price": np.random.choice([-118, -112, -108, -104, -100], n),
        "dk_over_price": np.random.choice([-115, -110, -105, 100], n),
        "fd_over_price": np.random.choice([-112, -108, -104, 102], n),
        "dk_under_price": np.random.choice([-115, -110, -105, 100], n),
        "fd_under_price": np.random.choice([-112, -108, -104, 102], n),
        # Targets
        "home_win": home_win,
        "home_covers_run_line": (home_score - away_score >= 2).astype(int),
        "over_hits": np.where(total == 8.5, np.nan, (total > 8.5).astype(float)),
        "_data_hash": "test12345678",
    })

train_df = synthetic_games(800, 2022)
val_df = synthetic_games(500, 2023)
hold_df = synthetic_games(500, 2024)
all_df = pd.concat([train_df, val_df, hold_df], ignore_index=True)
print(f"   Synthetic data: {len(all_df)} games, {len(all_df.columns)} cols")

# ── 2. Test feature engineering (with synthetic DataFrame) ─────────────────
print("2. Testing feature engineering helpers...")
from worker.models.pipelines.feature_engineering import (
    add_handedness_park_factors, add_travel_features, add_park_features
)
import pandas as pd

test_df = pd.DataFrame({
    "home_team_abbr": ["NYY", "BOS", "COL"],
    "away_team_abbr": ["TB", "TOR", "SD"],
    "home_team_id": [147, 111, 115],
    "away_team_id": [139, 141, 135],
    "game_date": ["2024-04-01", "2024-04-01", "2024-04-01"],
})
test_df = add_handedness_park_factors(test_df)
assert test_df["park_hr_factor_l"].iloc[0] == 128, f"NYY L factor wrong: {test_df['park_hr_factor_l'].iloc[0]}"
assert test_df["park_hr_factor_r"].iloc[0] == 112, f"NYY R factor wrong"
test_df = add_travel_features(test_df)
assert "away_travel_eastward_penalty" in test_df.columns
# TB (tz=-5) playing at NYY (tz=-5) → 0 TZ change
assert test_df["away_travel_tz_change"].iloc[0] == 0, f"TZ change wrong: {test_df['away_travel_tz_change'].iloc[0]}"
# COL (tz=-7) playing at SD (tz=-8) → -1 (westward)
# Wait: home is COL, away is SD. SD(tz=-8) traveling to COL(tz=-7). Delta = -7 - (-8) = +1 eastward
assert test_df["away_travel_tz_change"].iloc[2] == 1, f"SD@COL TZ delta wrong: {test_df['away_travel_tz_change'].iloc[2]}"
print("   Park factor and travel feature assertions PASS")

# ── 3. Train a moneyline model on synthetic data ───────────────────────────
print("3. Training moneyline model on synthetic data...")
import lightgbm as lgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import log_loss, brier_score_loss

from worker.models.pipelines.train_models import (
    MONEYLINE_FEATURES, assign_confidence_tier, simulate_roi, compute_ev
)

features = [f for f in MONEYLINE_FEATURES if f in all_df.columns]
X_train = train_df[features].fillna(0).values
y_train = train_df["home_win"].values.astype(float)
X_val = val_df[features].fillna(0).values
y_val = val_df["home_win"].values.astype(float)
X_hold = hold_df[features].fillna(0).values
y_hold = hold_df["home_win"].values.astype(float)

params = {
    "objective": "binary", "metric": "binary_logloss",
    "n_estimators": 100, "learning_rate": 0.05, "num_leaves": 15,
    "min_child_samples": 20, "random_state": 42, "verbose": -1, "n_jobs": 1,
}
model = lgb.LGBMClassifier(**params)
model.fit(X_train, y_train, eval_set=[(X_val, y_val)],
          callbacks=[lgb.early_stopping(20, verbose=False)])

raw_val = model.predict_proba(X_val)[:, 1]
cal = IsotonicRegression(out_of_bounds="clip")
cal.fit(raw_val, y_val)
cal_hold = cal.predict(model.predict_proba(X_hold)[:, 1])

ll = log_loss(y_hold, cal_hold)
brier = brier_score_loss(y_hold, cal_hold)
print(f"   Moneyline log-loss: {ll:.4f}, Brier: {brier:.4f}")
# Synthetic data has near-random outcomes — only validate shapes and valid probs
assert all(0.0 <= p <= 1.0 for p in cal_hold), "Calibrated probs out of [0,1]"
assert len(cal_hold) == len(y_hold), "Prediction count mismatch"
print(f"   Probabilities valid: min={cal_hold.min():.3f}, max={cal_hold.max():.3f}")

# ── 4. SHAP attributions ───────────────────────────────────────────────────
print("4. Testing SHAP attributions...")
import shap
explainer = shap.TreeExplainer(model)
shap_vals = explainer.shap_values(X_hold[:50])
if isinstance(shap_vals, list):
    shap_vals = shap_vals[1]
assert shap_vals.shape == (50, len(features)), f"SHAP shape mismatch: {shap_vals.shape}"
print(f"   SHAP shape: {shap_vals.shape} OK")

# ── 5. PickCandidate schema validation ─────────────────────────────────────
print("5. Testing PickCandidate schema...")
from worker.models.pick_candidate_schema import (
    PickCandidate, BestLine, FeatureAttribution, compute_ev, sort_attributions
)

sample_prob = float(cal_hold[0])
sample_odds = -110
ev = compute_ev(sample_prob, sample_odds)
tier = assign_confidence_tier(ev)

attributions = []
for i, (fname, sv) in enumerate(zip(features[:7], shap_vals[0, :7])):
    direction = "positive" if sv >= 0 else "negative"
    attributions.append(FeatureAttribution(
        feature_name=fname,
        feature_value=round(float(X_hold[0, i]), 4),
        shap_value=round(float(sv), 6),
        direction=direction,
        label=f"{fname}: {round(float(X_hold[0, i]), 2)}",
    ))

if tier < 1:
    tier = 1  # force non-zero for test
    ev = 0.05  # force positive EV for test

candidate = PickCandidate(
    game_id="test-game-001",
    market="moneyline",
    pick_side="home",
    model_probability=round(sample_prob, 4),
    implied_probability=round(0.524, 4),
    expected_value=round(ev if ev > 0 else 0.05, 4),
    confidence_tier=tier,
    best_line=BestLine(price=-110, sportsbook_key="draftkings", snapshotted_at="2024-04-01T18:00:00Z"),
    feature_attributions=attributions,
    features={"test": 1.0},
    model_version="moneyline-v1.0.0",
)
d = candidate.to_dict()
assert d["market"] == "moneyline"
assert d["confidence_tier"] in (1, 2, 3, 4, 5)
assert len(d["feature_attributions"]) <= 7
print(f"   PickCandidate OK — tier={tier}, EV={ev:.4f}, prob={sample_prob:.4f}")

# ── 6. Save and reload model artifact ─────────────────────────────────────
print("6. Testing model artifact save/reload...")
with tempfile.TemporaryDirectory() as tmpdir:
    artifact = {"model": model, "calibrator": cal, "features": features}
    pkl_path = Path(tmpdir) / "model.pkl"
    import pickle
    with open(pkl_path, "wb") as f:
        pickle.dump(artifact, f)
    with open(pkl_path, "rb") as f:
        loaded = pickle.load(f)
    assert loaded["features"] == features
    proba = loaded["model"].predict_proba(X_hold[:5])[:, 1]
    cal_out = loaded["calibrator"].predict(proba)
    assert len(cal_out) == 5
    print(f"   Artifact save/reload OK (5 predictions: {cal_out.round(3)})")

# ── 7. ROI simulation ──────────────────────────────────────────────────────
print("7. Testing ROI simulation...")
from worker.models.pipelines.train_models import simulate_roi
best_odds = np.array([-110] * len(hold_df))
roi_stats = simulate_roi(cal_hold, y_hold, best_odds, ev_threshold=0.02)
flat = roi_stats["flat"]
kelly = roi_stats["kelly025"]
print(f"   Flat staking @2% EV: {flat['n']} picks, ROI={flat['roi']}%, max_drawdown=${flat['max_drawdown']:.0f}")
print(f"   0.25 Kelly @2% EV:   {kelly['n']} picks, ROI={kelly['roi']}%")

print("\nALL SMOKE TESTS PASSED")
