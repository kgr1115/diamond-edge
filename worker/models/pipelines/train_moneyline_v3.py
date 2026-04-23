"""
train_moneyline_v3.py -- Anti-degeneracy moneyline B2 delta retrain.

Addresses lgbm_best_iteration=1 from the v20260423 retrain by reducing
regularization to allow splits at this data scale.

Key parameter changes vs v20260423 (LGBM_PARAMS_B2 in train_b2_delta.py):
  min_child_samples: 60  -> 10   (primary fix: allows splits on smaller leaf groups)
  num_leaves:        20  -> 31
  max_depth:         4   -> 6
  learning_rate:     0.03 -> 0.02 (slower = more iterations found)
  n_estimators:      800  -> 1000
  reg_alpha:         0.1  -> 0.05
  reg_lambda:        3.0  -> 1.0

Walk-forward protocol: identical to train_b2_delta.py
  Stage A: 2022 -> H1-2023 (validation check)
  Final:   2022+H1-2023 (model training)
  Holdout: 2024 (never touched)

Output:
  worker/models/moneyline/artifacts/v<ts>/model_b2.pkl
  worker/models/moneyline/artifacts/v<ts>/metrics.json
  worker/models/moneyline/artifacts/current_version.json
"""
from __future__ import annotations

import json
import pickle
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import mean_squared_error

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT))

DATA_DIR = ROOT / "data" / "training"
MODELS_DIR = ROOT / "worker" / "models"
REPORTS_DIR = MODELS_DIR / "backtest" / "reports"

H2_2023_CUTOFF = "2023-07-01"
DELTA_CLIP = 0.15

LGBM_PARAMS_V3 = {
    "objective": "regression",
    "metric": "rmse",
    "n_estimators": 1000,
    "learning_rate": 0.02,
    "num_leaves": 31,
    "max_depth": 6,
    "min_child_samples": 10,
    "min_split_gain": 0.0,
    "feature_fraction": 0.6,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.05,
    "reg_lambda": 1.0,
    "random_state": 42,
    "n_jobs": -1,
    "verbose": -1,
}

MONEYLINE_FEATURES_V3 = [
    "home_sp_era_season", "home_sp_era_last_30d", "home_sp_era_last_10d",
    "home_sp_fip_season", "home_sp_k9_season", "home_sp_bb9_season",
    "home_sp_hr9_season", "home_sp_whip_season", "home_sp_days_rest",
    "home_sp_ip_last_start", "home_sp_is_confirmed", "home_sp_throws",
    "away_sp_era_season", "away_sp_era_last_30d", "away_sp_era_last_10d",
    "away_sp_fip_season", "away_sp_k9_season", "away_sp_bb9_season",
    "away_sp_hr9_season", "away_sp_whip_season", "away_sp_days_rest",
    "away_sp_ip_last_start", "away_sp_is_confirmed", "away_sp_throws",
    "home_is_opener", "away_is_opener", "home_sp_ttop_exposure", "away_sp_ttop_exposure",
    "home_bp_era_last_7d", "home_bp_era_season", "home_bp_ip_last_2d",
    "home_bp_ip_last_3d", "home_bp_whip_last_7d",
    "away_bp_era_last_7d", "away_bp_era_season", "away_bp_ip_last_2d",
    "away_bp_ip_last_3d", "away_bp_whip_last_7d",
    "home_team_ops_season", "home_team_ops_last_14d",
    "home_team_runs_pg_season", "home_team_runs_pg_last_14d",
    "home_team_k_rate_season", "home_team_bb_rate_season", "home_team_batting_avg_season",
    "away_team_ops_season", "away_team_ops_last_14d",
    "away_team_runs_pg_season", "away_team_runs_pg_last_14d",
    "away_team_k_rate_season", "away_team_bb_rate_season", "away_team_batting_avg_season",
    "home_team_runs_ewma_7d", "away_team_runs_ewma_7d",
    "home_team_win_pct_season", "home_team_win_pct_home", "home_team_last10_win_pct",
    "home_team_run_diff_pg", "home_team_pythag_win_pct",
    "away_team_win_pct_season", "away_team_win_pct_away", "away_team_last10_win_pct",
    "away_team_run_diff_pg", "away_team_pythag_win_pct",
    "h2h_home_wins_pct_season",
    "park_run_factor", "park_hr_factor", "park_is_dome",
    "park_hr_factor_l", "park_hr_factor_r", "park_hr_factor_lineup_weighted",
    "weather_temp_f", "weather_wind_mph", "weather_wind_to_cf", "weather_wind_factor",
    "home_team_days_rest", "away_team_days_rest",
    "away_travel_tz_change", "away_travel_eastward_penalty",
    "ump_k_rate_career", "ump_run_factor", "ump_assigned",
    "home_platoon_advantage", "away_platoon_advantage", "home_lineup_confirmed",
    "market_implied_prob_home", "line_move_direction",
    "market_novig_home_morning", "line_movement_morning_to_afternoon", "book_disagreement_morning",
    # News features -- names match features.py inference path (canonical)
    # Absent from historical parquet; imputed 0 (no leakage for 2022-2024 training)
    "late_scratch_count", "late_scratch_war_impact_sum", "lineup_change_count",
    "injury_update_severity_max", "opener_announced", "weather_note_flag",
]


def main() -> None:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    print(f"Diamond Edge -- Moneyline v3 Anti-Degeneracy Retrain")
    print(f"Timestamp: {ts}")
    print(f"min_child_samples: 10 (was 60)  num_leaves: 31 (was 20)  max_depth: 6 (was 4)")

    b2_path = DATA_DIR / "games_b2.parquet"
    if not b2_path.exists():
        raise FileNotFoundError(f"games_b2.parquet not found at {b2_path}")

    df = pd.read_parquet(b2_path)
    df["game_date_dt"] = pd.to_datetime(df["game_date"])
    df["season_dt"] = df["game_date_dt"].dt.year
    print(f"Loaded {len(df)} rows")

    target_col = "y_delta_ml"
    prior_col = "market_novig_prior_morning"

    valid = df.dropna(subset=[target_col, prior_col]).copy()
    print(f"Valid rows (has target + prior): {len(valid)}")

    train_2022 = valid[valid["season_dt"] == 2022].sort_values("game_date_dt")
    h2023 = valid[valid["season_dt"] == 2023].sort_values("game_date_dt")
    h1_2023 = h2023[h2023["game_date_dt"] < H2_2023_CUTOFF]
    h2_2023 = h2023[h2023["game_date_dt"] >= H2_2023_CUTOFF]
    holdout = valid[valid["season_dt"] == 2024].sort_values("game_date_dt").copy()
    train_final = pd.concat([train_2022, h1_2023], ignore_index=True).sort_values("game_date_dt")

    print(f"2022: {len(train_2022)}  H1-2023: {len(h1_2023)}  H2-2023: {len(h2_2023)}  holdout: {len(holdout)}")

    available = [f for f in MONEYLINE_FEATURES_V3 if f in valid.columns]
    missing = [f for f in MONEYLINE_FEATURES_V3 if f not in valid.columns]
    if missing:
        print(f"Imputing 0 for {len(missing)} missing features: {missing[:5]}")
        for col in missing:
            valid[col] = 0.0
    # Re-slice after imputation so all subsets inherit the imputed columns
    train_2022 = valid[valid["season_dt"] == 2022].sort_values("game_date_dt")
    h2023 = valid[valid["season_dt"] == 2023].sort_values("game_date_dt")
    h1_2023 = h2023[h2023["game_date_dt"] < H2_2023_CUTOFF]
    h2_2023 = h2023[h2023["game_date_dt"] >= H2_2023_CUTOFF]
    holdout = valid[valid["season_dt"] == 2024].sort_values("game_date_dt").copy()
    train_final = pd.concat([train_2022, h1_2023], ignore_index=True).sort_values("game_date_dt")
    prior_hold = holdout[prior_col].astype(float).values
    all_features = MONEYLINE_FEATURES_V3

    def to_xy(subset: pd.DataFrame):
        return (
            subset[all_features].fillna(0).values,
            subset[target_col].astype(float).values,
        )

    X_train, y_train = to_xy(train_final)
    X_h2, y_h2 = to_xy(h2_2023)
    X_hold, y_hold = to_xy(holdout)

    # Walk-forward Fold A check
    print("\nFold A: 2022 -> H1-2023...")
    X_2022, y_2022 = to_xy(train_2022)
    X_h1, y_h1 = to_xy(h1_2023)
    n_es_a = max(100, int(len(X_2022) * 0.10))
    model_a = lgb.LGBMRegressor(**LGBM_PARAMS_V3)
    model_a.fit(
        X_2022[:-n_es_a], y_2022[:-n_es_a],
        eval_set=[(X_2022[-n_es_a:], y_2022[-n_es_a:])],
        callbacks=[lgb.early_stopping(150, verbose=False), lgb.log_evaluation(-1)],
    )
    delta_a = model_a.predict(X_h1)
    rmse_a = float(np.sqrt(mean_squared_error(y_h1, delta_a)))
    print(f"  Fold A best_iter={model_a.best_iteration_}  H1-2023 RMSE={rmse_a:.4f}  delta_std={delta_a.std():.4f}")

    # Final model
    print("\nFinal model: 2022+H1-2023...")
    n_es = max(150, int(len(X_train) * 0.10))
    t0 = time.time()
    model = lgb.LGBMRegressor(**LGBM_PARAMS_V3)
    model.fit(
        X_train[:-n_es], y_train[:-n_es],
        eval_set=[(X_train[-n_es:], y_train[-n_es:])],
        callbacks=[lgb.early_stopping(150, verbose=False), lgb.log_evaluation(-1)],
    )
    elapsed = time.time() - t0
    print(f"  best_iter={model.best_iteration_}  elapsed={elapsed:.1f}s")

    # H2-2023 check
    delta_h2 = model.predict(X_h2)
    rmse_h2 = float(np.sqrt(mean_squared_error(y_h2, delta_h2)))
    prior_h2 = h2_2023[prior_col].astype(float).values
    final_h2 = np.clip(prior_h2 + np.clip(delta_h2, -DELTA_CLIP, DELTA_CLIP), 0.05, 0.95)
    print(f"  H2-2023: RMSE={rmse_h2:.4f}  delta_std={delta_h2.std():.4f}  final_prob_std={final_h2.std():.4f}")

    # 2024 holdout
    delta_hold = model.predict(X_hold)
    clipped_delta = np.clip(delta_hold, -DELTA_CLIP, DELTA_CLIP)
    final_probs = np.clip(prior_hold + clipped_delta, 0.05, 0.95)

    rmse_hold = float(np.sqrt(mean_squared_error(y_hold, delta_hold)))
    rmse_prior = float(np.sqrt(mean_squared_error(y_hold, np.zeros(len(y_hold)))))
    nonzero_rate = float((np.abs(clipped_delta) > 0.02).mean())
    std_probs = float(final_probs.std())
    std_deltas = float(delta_hold.std())

    print(f"\n2024 holdout:")
    print(f"  RMSE (v3 model):   {rmse_hold:.4f}")
    print(f"  RMSE (prior only): {rmse_prior:.4f}")
    print(f"  Beats market RMSE: {rmse_hold < rmse_prior}")
    print(f"  |delta|>0.02 rate: {nonzero_rate*100:.1f}% (target >30%, old=0.0%)")
    print(f"  delta std:         {std_deltas:.4f} (old=0.0027)")
    print(f"  final_prob std:    {std_probs:.4f} (target >0.05, old=~0.0)")
    print(f"  final_prob range:  {final_probs.min():.4f} - {final_probs.max():.4f}")

    # Target check
    passes = std_probs > 0.05
    print(f"\n  Anti-degeneracy target (std > 0.05): {'PASS' if passes else 'FAIL'}")

    # Sample predictions
    print("\n  Sample final_probs (prior -> final):")
    for i in range(0, min(8, len(final_probs))):
        print(f"    prior={prior_hold[i]:.3f}  delta={clipped_delta[i]:+.3f}  final={final_probs[i]:.3f}")

    # Save artifact
    version_dir = MODELS_DIR / "moneyline" / "artifacts" / f"v{ts}"
    version_dir.mkdir(parents=True, exist_ok=True)

    artifact = {
        "model": model,
        "features": all_features,
        "delta_clip": DELTA_CLIP,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_protocol": "walk_forward_b2_v3_antidegeneracy",
        "model_version": f"moneyline-b2-v3-{ts}",
    }
    pkl_path = version_dir / "model_b2.pkl"
    with open(pkl_path, "wb") as f:
        pickle.dump(artifact, f, protocol=5)
    print(f"\nModel saved: {pkl_path}")

    metrics = {
        "market": "moneyline",
        "model_version": f"moneyline-b2-v3-{ts}",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "lgbm_params": LGBM_PARAMS_V3,
        "lgbm_best_iteration": int(model.best_iteration_),
        "fold_a": {"rmse": round(rmse_a, 4), "delta_std": round(float(delta_a.std()), 4)},
        "holdout_2024": {
            "n": len(holdout),
            "rmse_b2": round(rmse_hold, 4),
            "rmse_prior_only": round(rmse_prior, 4),
            "beats_market_rmse": bool(rmse_hold < rmse_prior),
            "nonzero_delta_rate_02": round(nonzero_rate, 3),
            "delta_std": round(std_deltas, 4),
            "final_prob_std": round(std_probs, 4),
            "anti_degeneracy_pass": bool(passes),
        },
        "features": all_features,
        "n_features": len(all_features),
        "missing_features_imputed": missing,
        "delta_clip_bound": DELTA_CLIP,
        "known_weaknesses": [
            "7 news features imputed 0 from historical parquet (no live news in 2022-2024)",
            "market_implied_prob_home is the highest-importance feature; absent odds degrade output",
            "Walk-forward trains on ~3600 games; more seasons = more iterations",
            "B2 regressor output is a delta; final_prob = prior + clip(delta, +-0.15)",
        ],
    }

    metrics_path = version_dir / "metrics.json"
    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2, default=str)
    print(f"Metrics saved: {metrics_path}")

    # Update current_version.json
    pointer = {
        "version": ts,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(version_dir),
        "log_loss": None,
        "best_roi_pct": None,
        "clv_pct": None,
        "final_prob_std": round(std_probs, 4),
        "nonzero_delta_rate": round(nonzero_rate, 3),
        "model_version": f"moneyline-b2-v3-{ts}",
    }
    pointer_path = MODELS_DIR / "moneyline" / "artifacts" / "current_version.json"
    with open(pointer_path, "w") as f:
        json.dump(pointer, f, indent=2, default=str)
    print(f"current_version.json updated: {pointer_path}")

    print(f"\nDone. Anti-degeneracy: {'PASS' if passes else 'FAIL'}")
    return metrics


if __name__ == "__main__":
    main()
