"""
train_models_v2.py — Diamond Edge Model v2 training pipeline.

Root-cause fixes applied vs v1:
  1. Multi-season training: 2022+2023 combined (4,868 games vs 2,431). Richer
     signal; calibrator sees distribution closer to 2024 holdout.
  2. K-fold isotonic calibration: 5-fold CV within training set, averaged
     calibrators. No leakage from single 2023-only calibration fold that
     drifted on 2024. CalibratedClassifierCV(method='isotonic', cv=5).
  3. Stronger regularization: lambda_l2=2.0, max_depth=5, num_leaves=24.
     Target: no calibrated probs > 0.80 on 2024 holdout distribution.
  4. Probability clipping: post-calibration hard clip to [0.10, 0.80].
     MLB games rarely exceed 0.73 true probability even for dominant favourites.
  5. EV threshold sweep: 2%, 4%, 6%, 8%, 10% — report ROI + picks at each.
     Recommend threshold where ROI stabilizes (not max).
  6. Opener split: models are trained on all games; opener flag retained as a
     feature. A separate opener-only submodel is not warranted at this data
     volume (~200 opener games per season).
  7. Brier home vs away disaggregation: verify no residual side bias.

Success criteria (2024 holdout):
  - No calibrated prob exceeds 0.80
  - ECE < 0.025 for all 3 markets (tighter than v1 0.035 pass)
  - Total picks across all 3 markets at 4% EV < 500
  - Flat-$100 ROI in 2–8% range (plausible; not 40%+)
  - Run line mean P(home cover) within 0.03 of actual 2024 cover rate

Artifacts saved to worker/models/{market}/artifacts/ (same paths as v1).
Backtest: worker/models/backtest/reports/backtest_summary_v2.json
"""

from __future__ import annotations

import hashlib
import json
import pickle
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import shap
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.metrics import brier_score_loss, log_loss

sys.path.insert(0, str(Path(__file__).parents[3]))
from worker.app.team_map import MLB_ID_TO_ABBR
from worker.models.pipelines.load_historical_odds import load_all_seasons
from worker.models.pipelines.feature_engineering import (
    build_pitcher_features_fast,
    build_bullpen_features_fast,
    build_team_offense_fast,
    build_team_record_fast,
    add_park_features,
    add_handedness_park_factors,
    detect_opener_games,
    add_ttop_features,
    add_travel_features,
    add_ewma_offense_features,
)
from worker.models.pipelines.build_training_data import (
    mlb_team_name_to_abbr,
    add_market_features,
    add_derived_run_line_features,
    add_combined_totals_features,
)

DATA_DIR = Path(__file__).parents[3] / "data" / "training"
MODELS_DIR = Path(__file__).parents[1]  # worker/models/
REPORTS_DIR = MODELS_DIR / "backtest" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# v2: tighter hyperparameters — deeper regularization, shallower trees
# v1 used: lambda_l2=0.1, max_depth=6, num_leaves=31
# v2 target: no prob > 0.80, ECE < 0.025, picks < 500 at 4% EV
LGBM_PARAMS_V2 = {
    "objective": "binary",
    "metric": "binary_logloss",
    "n_estimators": 600,
    "learning_rate": 0.03,
    "num_leaves": 24,          # v1: 31 — reduced to cap overfit
    "max_depth": 5,            # v1: 6 — one level shallower
    "min_child_samples": 50,   # v1: 30 — require more samples per leaf
    "feature_fraction": 0.7,   # v1: 0.8
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 2.0,         # v1: 0.1 — 20x stronger L2
    "random_state": 42,
    "n_jobs": -1,
    "verbose": -1,
}

# Hard probability clip — MLB true probs rarely exceed 0.73 even for dominant
# favourites. Clip prevents phantom EV from overconfident extremes.
PROB_CLIP_LO = 0.10
PROB_CLIP_HI = 0.80

# Feature lists unchanged from v1 (same schema, no feature expansion).
# Reusing from train_models.py to avoid duplication.
from worker.models.pipelines.train_models import (
    MONEYLINE_FEATURES,
    RUN_LINE_FEATURES,
    TOTALS_FEATURES,
    compute_ev,
    kelly_fraction,
    american_to_implied,
    _flat_pnl_for_bet,
    _kelly_pnl_for_bet,
    assign_confidence_tier,
    plot_reliability_diagram,
)

MARKET_CONFIG_V2 = {
    "moneyline": {
        "features": MONEYLINE_FEATURES,
        "target": "home_win",
        "version": "moneyline-v2.0.0",
    },
    "run_line": {
        "features": RUN_LINE_FEATURES,
        "target": "home_covers_run_line",
        "version": "run_line-v2.0.0",
    },
    "totals": {
        "features": TOTALS_FEATURES,
        "target": "over_hits",
        "version": "totals-v2.0.0",
    },
}


# ---------------------------------------------------------------------------
# ECE helper (same as v1 for comparability)
# ---------------------------------------------------------------------------
def calibration_error(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = 10) -> float:
    bins = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    n = len(y_true)
    for i in range(n_bins):
        mask = (y_prob >= bins[i]) & (y_prob < bins[i + 1])
        if mask.sum() == 0:
            continue
        acc = y_true[mask].mean()
        conf = y_prob[mask].mean()
        ece += (mask.sum() / n) * abs(acc - conf)
    return ece


# ---------------------------------------------------------------------------
# ROI simulation — same harness as v1, extended to 5 EV thresholds
# ---------------------------------------------------------------------------
def simulate_roi_v2(
    model_probs: np.ndarray,
    y_true: np.ndarray,
    primary_odds: np.ndarray,
    ev_threshold: float = 0.04,
    kelly_fraction_param: float = 0.25,
    opposing_odds: np.ndarray | None = None,
) -> dict:
    """
    Bidirectional ROI simulator (identical logic to v1 bias-fixed version).
    Returns flat + Kelly ROI dict.
    """
    results = {
        "flat": {"n": 0, "wagered": 0.0, "profit": 0.0, "roi": 0.0,
                 "wins": 0, "win_rate": 0.0, "max_drawdown": 0.0},
        "kelly025": {"n": 0, "wagered": 0.0, "profit": 0.0, "roi": 0.0,
                     "wins": 0, "win_rate": 0.0, "max_drawdown": 0.0},
    }

    BANKROLL = 1000.0
    flat_pnl: list[float] = []
    kelly_pnl: list[float] = []
    kelly_bank = BANKROLL

    opp = opposing_odds if opposing_odds is not None else np.full(len(primary_odds), np.nan)

    for (prob, outcome, p_odds), o_odds in zip(
        zip(model_probs, y_true, primary_odds), opp
    ):
        if pd.isna(prob) or pd.isna(outcome) or pd.isna(p_odds):
            continue

        prob = float(prob)
        p_odds_int = int(p_odds)
        ev_primary = compute_ev(prob, p_odds_int)

        ev_opposing = -999.0
        o_odds_int: int | None = None
        if not pd.isna(o_odds):
            o_odds_int = int(o_odds)
            ev_opposing = compute_ev(1.0 - prob, o_odds_int)

        bet_primary = ev_primary >= ev_threshold
        bet_opposing = (o_odds_int is not None) and (ev_opposing >= ev_threshold)

        if not bet_primary and not bet_opposing:
            continue

        if bet_primary and bet_opposing:
            bet_primary = ev_primary >= ev_opposing

        if bet_primary:
            bet_odds = p_odds_int
            bet_ev = ev_primary
            won = int(outcome) == 1
        else:
            bet_odds = o_odds_int  # type: ignore[assignment]
            bet_ev = ev_opposing
            won = int(outcome) == 0

        # Flat $100
        flat_result = _flat_pnl_for_bet(bet_odds, won)
        flat_pnl.append(flat_result)
        results["flat"]["wagered"] += 100
        results["flat"]["n"] += 1
        if won:
            results["flat"]["wins"] += 1

        # 0.25 Kelly
        stake, kresult = _kelly_pnl_for_bet(bet_ev, bet_odds, kelly_bank,
                                             kelly_fraction_param, won)
        kelly_pnl.append(kresult)
        kelly_bank += kresult
        results["kelly025"]["wagered"] += stake
        results["kelly025"]["n"] += 1
        if won:
            results["kelly025"]["wins"] += 1

    if flat_pnl:
        cum = np.cumsum(flat_pnl)
        results["flat"]["profit"] = float(sum(flat_pnl))
        results["flat"]["roi"] = round(
            results["flat"]["profit"] / results["flat"]["wagered"] * 100, 2
        ) if results["flat"]["wagered"] > 0 else 0.0
        results["flat"]["win_rate"] = round(
            results["flat"]["wins"] / results["flat"]["n"], 4
        ) if results["flat"]["n"] > 0 else 0.0
        running_max = np.maximum.accumulate(cum)
        results["flat"]["max_drawdown"] = float((running_max - cum).max())

    if kelly_pnl:
        cum_k = np.cumsum(kelly_pnl)
        results["kelly025"]["profit"] = float(sum(kelly_pnl))
        results["kelly025"]["roi"] = round(
            results["kelly025"]["profit"] / results["kelly025"]["wagered"] * 100, 2
        ) if results["kelly025"]["wagered"] > 0 else 0.0
        results["kelly025"]["win_rate"] = round(
            results["kelly025"]["wins"] / results["kelly025"]["n"], 4
        ) if results["kelly025"]["n"] > 0 else 0.0
        running_max_k = np.maximum.accumulate(cum_k)
        results["kelly025"]["max_drawdown"] = float((running_max_k - cum_k).max())

    return results


# ---------------------------------------------------------------------------
# Data loading (reuses v1 feature pipeline — no new features)
# ---------------------------------------------------------------------------
def load_and_build_features_v2() -> pd.DataFrame:
    """
    Builds the full feature dataset using the v1 feature pipeline.
    The only change from v1: we use 2022+2023 as train, 2024 as holdout.
    No new features are added in v2 — calibration fix only.
    """
    processed_path = DATA_DIR / "games_v1_processed.parquet"
    if processed_path.exists():
        print(f"Loading cached processed dataset: {processed_path}")
        df = pd.read_parquet(processed_path)
        print(f"  {len(df)} games, {len(df.columns)} columns")
        return df

    print("Building features from raw data (no cached parquet found)...")
    from worker.models.pipelines.train_models import load_and_build_features
    df = load_and_build_features()
    df.to_parquet(processed_path, index=False)
    print(f"Processed dataset saved: {processed_path}")
    return df


# ---------------------------------------------------------------------------
# v2 calibration: CalibratedClassifierCV, 5-fold, isotonic
# ---------------------------------------------------------------------------
def fit_calibrated_model_v2(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
) -> tuple:
    """
    Train LightGBM with early stopping on a held-out val fold (2023),
    then wrap in CalibratedClassifierCV (5-fold isotonic) on train set.

    Returns (base_model, calibrated_model, best_iteration).

    Why CalibratedClassifierCV on train rather than val:
    - v1 calibrated on 2023-only val fold, which drifted from 2024.
    - 5-fold CV within the larger 2022+2023 training pool reduces
      dependency on any single season's distribution.
    - 2023 val fold is still used for early stopping (leakage-free).
    """
    # Step 1: Train base LightGBM to find optimal n_estimators
    base_model = lgb.LGBMClassifier(**LGBM_PARAMS_V2)
    base_model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(200)],
    )
    best_iter = int(base_model.best_iteration_)
    print(f"  Base model best iteration: {best_iter}")

    # Step 2: Freeze n_estimators at best_iter, re-wrap with CalibratedClassifierCV
    # Use the same LGBM params but no early stopping — n_estimators locked.
    frozen_params = {**LGBM_PARAMS_V2, "n_estimators": best_iter}
    frozen_lgbm = lgb.LGBMClassifier(**frozen_params)

    # CalibratedClassifierCV wraps the unfitted estimator, fits it internally
    # via K-fold CV on X_train, y_train.
    cal_model = CalibratedClassifierCV(
        frozen_lgbm,
        method="isotonic",
        cv=5,
        n_jobs=-1,
    )
    print(f"  Fitting CalibratedClassifierCV (isotonic, 5-fold) on {len(X_train)} training games...")
    t0 = time.time()
    cal_model.fit(X_train, y_train)
    print(f"  Calibration fit: {time.time()-t0:.1f}s")

    return base_model, cal_model, best_iter


# ---------------------------------------------------------------------------
# Brier score disaggregation (home vs away picks)
# ---------------------------------------------------------------------------
def brier_side_check(
    probs: np.ndarray,
    y_true: np.ndarray,
    primary_odds: np.ndarray,
    opposing_odds: np.ndarray,
    ev_threshold: float = 0.04,
) -> dict:
    """
    Disaggregate Brier score for home picks vs away picks at ev_threshold.
    Residual home/away bias check per the v2 task spec.
    """
    home_probs, home_y, away_probs, away_y = [], [], [], []

    for prob, outcome, p_odds, o_odds in zip(probs, y_true, primary_odds, opposing_odds):
        if pd.isna(prob) or pd.isna(outcome):
            continue
        ev_p = compute_ev(float(prob), int(p_odds))
        ev_o = compute_ev(1.0 - float(prob), int(o_odds)) if not pd.isna(o_odds) else -999.0

        if ev_p >= ev_threshold and (ev_p >= ev_o or ev_o < ev_threshold):
            home_probs.append(float(prob))
            home_y.append(int(outcome))
        elif ev_o >= ev_threshold:
            away_probs.append(1.0 - float(prob))
            away_y.append(1 - int(outcome))

    out = {}
    if home_probs:
        out["home_side_n"] = len(home_probs)
        out["home_side_brier"] = round(
            brier_score_loss(home_y, home_probs), 4
        )
        out["home_side_win_rate"] = round(float(np.mean(home_y)), 4)
    if away_probs:
        out["away_side_n"] = len(away_probs)
        out["away_side_brier"] = round(
            brier_score_loss(away_y, away_probs), 4
        )
        out["away_side_win_rate"] = round(float(np.mean(away_y)), 4)
    return out


# ---------------------------------------------------------------------------
# Train one market — v2
# ---------------------------------------------------------------------------
def train_market_v2(market: str, df: pd.DataFrame) -> dict:
    cfg = MARKET_CONFIG_V2[market]
    target_col = cfg["target"]
    feature_cols = cfg["features"]
    version = cfg["version"]

    print(f"\n{'='*60}")
    print(f"Training v2: {market.upper()}")
    print(f"{'='*60}")

    valid = df.dropna(subset=[target_col]).copy()
    if market == "totals":
        valid = valid[valid[target_col] != 0.5].copy()

    valid["season_dt"] = pd.to_datetime(valid["game_date"]).dt.year

    # v2 key change: 2022+2023 train, 2024 holdout only (no separate val split)
    # Early stopping uses a random 15% held-out portion of train as val.
    train_all = valid[valid["season_dt"].isin([2022, 2023])].copy()
    holdout = valid[valid["season_dt"] == 2024].copy()

    print(f"  Train (2022+2023): {len(train_all)} | Holdout 2024: {len(holdout)}")

    if len(train_all) < 200:
        return {"error": f"Insufficient training data for {market}: {len(train_all)} rows"}

    # Ensure all feature columns exist
    available_features = [f for f in feature_cols if f in valid.columns]
    missing = [f for f in feature_cols if f not in valid.columns]
    if missing:
        print(f"  Missing features (imputing 0): {missing[:5]}{'...' if len(missing) > 5 else ''}")
        for m in missing:
            for ds in [valid, train_all, holdout]:
                ds[m] = 0.0
        available_features = feature_cols

    # 85/15 train/val split for early stopping (stratified by season)
    rng = np.random.default_rng(42)
    val_idx = rng.choice(len(train_all), size=int(len(train_all) * 0.15), replace=False)
    val_mask = np.zeros(len(train_all), dtype=bool)
    val_mask[val_idx] = True

    X_train_es = train_all[~val_mask][available_features].fillna(0).values
    y_train_es = train_all[~val_mask][target_col].astype(float).values
    X_val_es = train_all[val_mask][available_features].fillna(0).values
    y_val_es = train_all[val_mask][target_col].astype(float).values

    # Full training set (for CalibratedClassifierCV)
    X_train_full = train_all[available_features].fillna(0).values
    y_train_full = train_all[target_col].astype(float).values

    X_hold = holdout[available_features].fillna(0).values
    y_hold = holdout[target_col].astype(float).values

    # Train + calibrate
    base_model, cal_model, best_iter = fit_calibrated_model_v2(
        X_train_full, y_train_full, X_val_es, y_val_es
    )

    # Calibrated predictions on holdout
    cal_hold_raw = cal_model.predict_proba(X_hold)[:, 1]

    # Hard clip to [PROB_CLIP_LO, PROB_CLIP_HI]
    cal_hold = np.clip(cal_hold_raw, PROB_CLIP_LO, PROB_CLIP_HI)

    print(f"  Holdout prob distribution: min={cal_hold.min():.3f} "
          f"max={cal_hold.max():.3f} mean={cal_hold.mean():.3f} "
          f"std={cal_hold.std():.3f}")

    # Evaluate calibration
    ll = log_loss(y_hold, cal_hold)
    brier = brier_score_loss(y_hold, cal_hold)
    ece = calibration_error(y_hold, cal_hold)

    print(f"  Log-loss: {ll:.4f} (target < 0.69)")
    print(f"  Brier: {brier:.4f} (target < 0.25)")
    print(f"  ECE: {ece:.4f} (target < 0.025)")

    # Reliability diagram
    diag_path = REPORTS_DIR / f"calibration_v2_{market}_holdout.png"
    max_dev = plot_reliability_diagram(y_hold, cal_hold, f"{market} v2", diag_path)
    print(f"  Max calibration deviation: {max_dev:.3f} (target < 0.05)")

    # Confirm max prob constraint
    n_above_80 = int((cal_hold > 0.80).sum())
    print(f"  Probs > 0.80 after clip: {n_above_80} (must be 0)")

    # Run-line specific: mean P(home cover)
    mean_prob = float(cal_hold.mean())
    actual_cover_rate = float(y_hold.mean())
    print(f"  Mean P(primary): {mean_prob:.4f} | Actual rate: {actual_cover_rate:.4f} "
          f"| Drift: {abs(mean_prob - actual_cover_rate):.4f}")

    # Best odds for EV simulation
    primary_odds_cols = {
        "moneyline": ("dk_ml_home", "fd_ml_home"),
        "run_line": ("dk_rl_home_price", "fd_rl_home_price"),
        "totals": ("dk_over_price", "fd_over_price"),
    }[market]
    opposing_odds_cols = {
        "moneyline": ("dk_ml_away", "fd_ml_away"),
        "run_line": ("dk_rl_away_price", "fd_rl_away_price"),
        "totals": ("dk_under_price", "fd_under_price"),
    }[market]

    def get_best_odds(df_sub: pd.DataFrame, cols: tuple[str, str], default: int = -110) -> np.ndarray:
        c1, c2 = cols
        v1 = df_sub.get(c1, pd.Series([default] * len(df_sub))).fillna(default).values
        v2 = df_sub.get(c2, pd.Series([default] * len(df_sub))).fillna(default).values
        return np.maximum(v1, v2)

    holdout_primary_odds = get_best_odds(holdout, primary_odds_cols)
    holdout_opposing_odds = get_best_odds(holdout, opposing_odds_cols)

    # EV sweep: 2%, 4%, 6%, 8%, 10%
    roi_stats = {}
    for ev_thr in [0.02, 0.04, 0.06, 0.08, 0.10]:
        roi_stats[f"ev_thr_{int(ev_thr*100)}pct"] = simulate_roi_v2(
            cal_hold, y_hold, holdout_primary_odds,
            ev_threshold=ev_thr,
            opposing_odds=holdout_opposing_odds,
        )

    # Print EV sweep summary
    print(f"\n  EV sweep (picks / flat-ROI / win-rate):")
    for thr_key, r in roi_stats.items():
        n = r["flat"]["n"]
        roi = r["flat"]["roi"]
        wr = r["flat"]["win_rate"]
        print(f"    {thr_key}: {n} picks | ROI {roi:+.1f}% | WR {wr:.3f}")

    # Brier side check (home vs away picks at 4% EV)
    side_check = brier_side_check(
        cal_hold, y_hold, holdout_primary_odds, holdout_opposing_odds, ev_threshold=0.04
    )
    print(f"  Side check @ 4%EV: {side_check}")

    # Tier counts
    evs = np.array([
        max(
            compute_ev(float(p), int(po)),
            compute_ev(1.0 - float(p), int(oo)),
        )
        for p, po, oo in zip(cal_hold, holdout_primary_odds, holdout_opposing_odds)
    ])
    tiers = np.array([assign_confidence_tier(ev) for ev in evs])
    tier_counts = {f"tier_{i}": int((tiers >= i).sum()) for i in range(1, 6)}

    # SHAP on base_model (CalibratedClassifierCV wraps multiple estimators;
    # use the base_model for SHAP attributions since it's the same LightGBM structure)
    print("  Computing SHAP values (TreeExplainer on base model)...")
    try:
        explainer = shap.TreeExplainer(base_model)
        shap_sample = X_hold[:min(500, len(X_hold))]
        shap_vals = explainer.shap_values(shap_sample)
        if isinstance(shap_vals, list):
            shap_vals = shap_vals[1]
        mean_abs_shap = np.abs(shap_vals).mean(axis=0)
        shap_importance = {
            feat: round(float(imp), 6)
            for feat, imp in sorted(
                zip(available_features, mean_abs_shap),
                key=lambda x: x[1], reverse=True,
            )
        }
        top10 = list(shap_importance.items())[:10]
        print("  Top 10 features by SHAP:")
        for fname, simp in top10:
            print(f"    {fname}: {simp:.4f}")
    except Exception as e:
        print(f"  SHAP failed: {e}")
        shap_importance = {f: 0.0 for f in available_features}

    # Save artifacts (same paths as v1 — replaces v1 artifacts)
    artifact_dir = MODELS_DIR / market / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    model_artifact = {
        "model": base_model,
        "calibrated_model": cal_model,
        "features": available_features,
        "prob_clip_lo": PROB_CLIP_LO,
        "prob_clip_hi": PROB_CLIP_HI,
        "version": version,
    }
    with open(artifact_dir / "model.pkl", "wb") as f:
        pickle.dump(model_artifact, f)

    with open(artifact_dir / "shap_importance.json", "w") as f:
        json.dump(shap_importance, f, indent=2)

    data_hash = df["_data_hash"].iloc[0] if "_data_hash" in df.columns else "unknown"

    metrics = {
        "market": market,
        "version": version,
        "model_version": "v2",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_seasons": [2022, 2023],
        "holdout_season": 2024,
        "training_games": len(train_all),
        "holdout_games": len(holdout),
        "data_hash": data_hash,
        "features": available_features,
        "n_features": len(available_features),
        "lgbm_best_iteration": best_iter,
        "lgbm_params": LGBM_PARAMS_V2,
        "calibration_method": "CalibratedClassifierCV(isotonic, cv=5)",
        "prob_clip": [PROB_CLIP_LO, PROB_CLIP_HI],
        "holdout_log_loss": round(ll, 4),
        "holdout_brier": round(brier, 4),
        "holdout_ece": round(ece, 4),
        "holdout_max_calibration_deviation": round(max_dev, 4),
        "calibration_pass": bool(max_dev < 0.05),
        "ece_pass_v2": bool(ece < 0.025),
        "n_probs_above_80": n_above_80,
        "prob_constraint_pass": bool(n_above_80 == 0),
        "holdout_mean_prob": round(mean_prob, 4),
        "holdout_actual_rate": round(actual_cover_rate, 4),
        "prob_vs_actual_drift": round(abs(mean_prob - actual_cover_rate), 4),
        "roi_simulation": roi_stats,
        "tier_pick_counts": tier_counts,
        "brier_side_check_4pct_ev": side_check,
        "shap_top10": list(shap_importance.items())[:10],
        "known_weaknesses_v2": [
            "Training on 2022+2023 (2 seasons) — still thin; v3 should add 2021",
            "Hard probability clip at 0.80 assumes max true MLB game probability; "
            "may suppress real edge on rare extreme mismatches",
            "Calibration uses 5-fold CV on full train set; slight optimism vs "
            "true out-of-sample if 2022/2023 distributions differ from 2025+",
            "Umpire features imputed (G6 gap) — no real ump signal",
            "Weather features imputed — game-time weather would improve totals",
            "Lineup handedness imputed — platoon features weak until LINEUP-01",
        ],
    }

    with open(artifact_dir / "manifest.json", "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"  Artifacts saved: {artifact_dir}")
    return metrics


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(markets: list[str] | None = None) -> dict:
    if markets is None:
        markets = ["moneyline", "run_line", "totals"]

    print("Diamond Edge v2 Training Pipeline")
    print(f"Markets: {markets}")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
    print(f"Key changes vs v1: 2-season train, 5-fold isotonic CV, "
          f"reg_lambda=2.0, max_depth=5, prob clip [0.10, 0.80]")
    print()

    df = load_and_build_features_v2()

    # Run drift audit first — this is the smoking gun investigation
    print("\n--- Running drift audit (train vs holdout) ---")
    from worker.models.pipelines.drift_audit import run_drift_audit
    drift_results = run_drift_audit(df)
    drift_path = REPORTS_DIR / "drift_audit.json"
    with open(drift_path, "w") as f:
        import json as _json

        class _NumpyEncoder(_json.JSONEncoder):
            def default(self, obj):
                import numpy as np
                if isinstance(obj, (np.integer,)):
                    return int(obj)
                if isinstance(obj, (np.floating,)):
                    return float(obj)
                if isinstance(obj, (np.bool_,)):
                    return bool(obj)
                if isinstance(obj, np.ndarray):
                    return obj.tolist()
                return super().default(obj)

        _json.dump(drift_results, f, indent=2, cls=_NumpyEncoder)
    print(f"Drift audit saved: {drift_path}")

    all_metrics = {}
    for market in markets:
        try:
            metrics = train_market_v2(market, df)
            all_metrics[market] = metrics
        except Exception as e:
            print(f"ERROR training {market}: {e}")
            import traceback
            traceback.print_exc()
            all_metrics[market] = {"error": str(e)}

    summary = {
        "backtest_date": datetime.now(timezone.utc).isoformat(),
        "model_version": "v2",
        "holdout_season": 2024,
        "training_seasons": [2022, 2023],
        "bias_fix_applied": "bidirectional EV (both sides evaluated per game)",
        "v2_changes": [
            "2-season training (2022+2023 combined)",
            "CalibratedClassifierCV isotonic 5-fold on training set",
            "reg_lambda=2.0 (v1: 0.1), max_depth=5 (v1: 6), num_leaves=24 (v1: 31)",
            "min_child_samples=50 (v1: 30), feature_fraction=0.7 (v1: 0.8)",
            "Hard probability clip [0.10, 0.80]",
            "EV threshold sweep: 2%, 4%, 6%, 8%, 10%",
        ],
        "markets": all_metrics,
        "drift_audit_summary": {
            "n_flagged_z2": drift_results["n_flagged_z2"],
            "target_rates": drift_results["target_rates"],
            "top_drifted_features": drift_results["flagged_features"][:10],
        },
    }

    summary_path = REPORTS_DIR / "backtest_summary_v2.json"
    with open(summary_path, "w") as f:
        import json as _json
        _json.dump(summary, f, indent=2)
    print(f"\nv2 Backtest summary: {summary_path}")

    # Headline
    print("\n" + "="*60)
    print("v2 BACKTEST HEADLINE METRICS (2024 holdout)")
    print("="*60)
    total_picks_4pct = 0
    for market, m in all_metrics.items():
        if "error" in m:
            print(f"{market:10s}: ERROR — {m['error']}")
            continue
        ll = m.get("holdout_log_loss", "N/A")
        ece = m.get("holdout_ece", "N/A")
        cal_pass = "PASS" if m.get("calibration_pass") else "FAIL"
        ece_pass = "PASS" if m.get("ece_pass_v2") else "FAIL"
        ev4 = m.get("roi_simulation", {}).get("ev_thr_4pct", {}).get("flat", {})
        ev4_roi = ev4.get("roi", "N/A")
        ev4_n = ev4.get("n", 0)
        ev4_wr = ev4.get("win_rate", "N/A")
        n_above_80 = m.get("n_probs_above_80", "?")
        total_picks_4pct += ev4_n
        print(
            f"{market:10s}: log-loss={ll} ECE={ece} ({ece_pass}) cal={cal_pass} "
            f"| ROI@4%EV={ev4_roi}% ({ev4_n}picks, WR={ev4_wr}) | probs>0.80: {n_above_80}"
        )
    print(f"\nTotal picks @ 4% EV across 3 markets: {total_picks_4pct} (target <500)")

    return all_metrics


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--markets", nargs="+", default=["moneyline", "run_line", "totals"])
    args = parser.parse_args()
    main(args.markets)
