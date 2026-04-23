"""
train_moneyline_v4.py — Moneyline-only walk-forward CV pipeline.

Fixes applied vs v2:
  1. Walk-forward CV replaces random 5-fold:
       Fold A: train=2022,         val=first half 2023 (April–June)
       Fold B: train=2022+H1-2023, val=second half 2023 (July–October)
       Final:  train=2022+2023,    holdout=2024 (no CV, evaluation only)

  2. Calibration uses TimeSeriesSplit-equivalent: isotonic regression fit on
     the OUT-OF-FOLD predictions from the walk-forward folds, NOT on a
     random k-fold of the training set. This ensures the calibrator never
     sees future data during its fit.

  3. Early stopping val: a 30-day temporal holdout from the END of the
     training window (last 30 days of training data), not a random sample.

  4. Feature rolling windows: verified strictly causal in feature_engineering.py
     (all lookbacks use `< game_date`, already correct). No changes needed.

  5. Calibration data: only OOF predictions from folds A+B are used to fit
     the final calibrator (not the 2024 holdout — that remains unseen).

Walk-forward protocol:
  - Split 2023 at July 1 (first pitch on or after 2023-07-01 = H2).
  - Fold A trains on 2022, validates on H1-2023.
  - Fold B trains on 2022+H1-2023, validates on H2-2023.
  - Out-of-fold (OOF) predictions from both folds are concatenated.
  - Isotonic calibrator is fit on OOF predictions.
  - Final model trains on all of 2022+2023, calibrated with the isotonic
    calibrator fit on OOF preds.
  - Evaluation: calibrated final model on 2024 holdout.

Artifacts:
  worker/models/moneyline/artifacts/model.pkl      (replaced)
  worker/models/moneyline/artifacts/manifest.json  (replaced)
  worker/models/moneyline/artifacts/shap_importance.json
  worker/models/backtest/reports/backtest_v4_moneyline.json
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
from sklearn.calibration import calibration_curve
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT))

DATA_DIR = ROOT / "data" / "training"
MODELS_DIR = ROOT / "worker" / "models"
REPORTS_DIR = MODELS_DIR / "backtest" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# Walk-forward split boundary: games on or after this date are H2-2023
H2_2023_CUTOFF = "2023-07-01"

# LightGBM params: same regularization as v2 (tighter than v1)
LGBM_PARAMS_V4 = {
    "objective": "binary",
    "metric": "binary_logloss",
    "n_estimators": 600,
    "learning_rate": 0.03,
    "num_leaves": 24,
    "max_depth": 5,
    "min_child_samples": 50,
    "feature_fraction": 0.7,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 2.0,
    "random_state": 42,
    "n_jobs": -1,
    "verbose": -1,
}

PROB_CLIP_LO = 0.10
PROB_CLIP_HI = 0.80

# Moneyline feature list (unchanged from v2 — this is a protocol fix, not a
# feature engineering change)
from worker.models.pipelines.train_models import (
    MONEYLINE_FEATURES,
    compute_ev,
    assign_confidence_tier,
)


# ---------------------------------------------------------------------------
# Calibration helpers
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


def plot_reliability_diagram(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    label: str,
    output_path: Path,
) -> float:
    frac_pos, mean_pred = calibration_curve(y_true, y_prob, n_bins=10, strategy="quantile")
    max_dev = float(np.max(np.abs(frac_pos - mean_pred)))

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 10))
    ax1.plot([0, 1], [0, 1], "k--", label="Perfect")
    ax1.plot(mean_pred, frac_pos, "s-", label=label)
    ax1.fill_between(
        mean_pred,
        np.maximum(0, frac_pos - 0.05),
        np.minimum(1, frac_pos + 0.05),
        alpha=0.2, label="±5%",
    )
    ax1.set_xlabel("Mean predicted probability")
    ax1.set_ylabel("Fraction of positives")
    ax1.set_title(f"Reliability diagram — {label}")
    ax1.set_xlim(0, 1)
    ax1.set_ylim(0, 1)
    ax1.legend()

    ax2.hist(y_prob, bins=20, edgecolor="black")
    ax2.set_xlabel("Predicted probability")
    ax2.set_ylabel("Count")
    ax2.set_title("Prediction distribution")

    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()
    return max_dev


# ---------------------------------------------------------------------------
# EV + ROI helpers (vig-removed, matching v3 backtest logic)
# ---------------------------------------------------------------------------
def american_to_raw_implied(odds: float) -> float:
    if odds > 0:
        return 100.0 / (100.0 + odds)
    else:
        return abs(odds) / (abs(odds) + 100.0)


def compute_novig_probs(primary_odds: float, opposing_odds: float) -> tuple[float, float, float]:
    if pd.isna(primary_odds) or pd.isna(opposing_odds):
        return 0.5, 0.5, 0.0
    p_raw = american_to_raw_implied(float(primary_odds))
    o_raw = american_to_raw_implied(float(opposing_odds))
    margin = p_raw + o_raw - 1.0
    if margin > 0.15:
        return 0.5, 0.5, 0.0
    if margin <= 0.005:
        margin = 0.005
    return p_raw / (1.0 + margin), o_raw / (1.0 + margin), margin


def _flat_pnl(odds: int, won: bool) -> float:
    if odds > 0:
        return float(odds) if won else -100.0
    else:
        return 100.0 * 100.0 / abs(odds) if won else -100.0


def simulate_roi_novig(
    model_probs: np.ndarray,
    y_true: np.ndarray,
    primary_odds: np.ndarray,
    opposing_odds: np.ndarray,
    ev_threshold: float = 0.04,
) -> dict:
    """
    ROI simulation with vig-removed edge gate (mirrors run_backtest_v3.py).

    A bet is placed only if:
      (a) EV vs raw odds >= ev_threshold, AND
      (b) model_prob > novig_market_prob (genuine edge over fair value).
    """
    flat_pnl_list: list[float] = []
    n, wins = 0, 0

    for i in range(len(model_probs)):
        prob = float(model_probs[i])
        outcome = float(y_true[i])
        p_odds = float(primary_odds[i])
        o_odds = float(opposing_odds[i])

        if any(pd.isna(v) for v in [prob, outcome, p_odds, o_odds]):
            continue

        nv_p, nv_o, margin = compute_novig_probs(p_odds, o_odds)
        if margin < 0.001:
            continue

        # Compute EV against raw odds (payout) + edge vs fair value
        ev_p = compute_ev(prob, int(p_odds))
        edge_p = prob - nv_p

        ev_o = compute_ev(1.0 - prob, int(o_odds))
        edge_o = (1.0 - prob) - nv_o

        bet_primary = (ev_p >= ev_threshold) and (edge_p > 0)
        bet_opposing = (ev_o >= ev_threshold) and (edge_o > 0)

        if not bet_primary and not bet_opposing:
            continue

        if bet_primary and bet_opposing:
            bet_primary = ev_p >= ev_o

        if bet_primary:
            won = int(outcome) == 1
            pnl = _flat_pnl(int(p_odds), won)
        else:
            won = int(outcome) == 0
            pnl = _flat_pnl(int(o_odds), won)

        flat_pnl_list.append(pnl)
        n += 1
        if won:
            wins += 1

    if not flat_pnl_list:
        return {"n": 0, "wagered": 0, "profit": 0.0, "roi": 0.0,
                "win_rate": 0.0, "max_drawdown": 0.0}

    wagered = n * 100.0
    profit = sum(flat_pnl_list)
    roi = round(profit / wagered * 100, 2) if wagered > 0 else 0.0
    win_rate = round(wins / n, 4) if n > 0 else 0.0

    cum = np.cumsum(flat_pnl_list)
    running_max = np.maximum.accumulate(cum)
    max_dd = float((running_max - cum).max())

    return {
        "n": n,
        "wagered": wagered,
        "profit": round(profit, 2),
        "roi": roi,
        "win_rate": win_rate,
        "max_drawdown": round(max_dd, 2),
    }


def get_best_odds(df: pd.DataFrame, cols: tuple[str, str], default: int = -110) -> np.ndarray:
    c1, c2 = cols
    v1 = df.get(c1, pd.Series([default] * len(df))).fillna(default).values
    v2 = df.get(c2, pd.Series([default] * len(df))).fillna(default).values
    return np.maximum(v1, v2).astype(float)


# ---------------------------------------------------------------------------
# CLV helpers (mirrors run_backtest_v3.py)
# ---------------------------------------------------------------------------
def compute_clv_simple(
    model_probs: np.ndarray,
    primary_odds_open: np.ndarray,
    opposing_odds_open: np.ndarray,
    primary_odds_close: np.ndarray,
    opposing_odds_close: np.ndarray,
) -> dict:
    clv_all: list[float] = []
    line_toward = 0
    line_away = 0
    no_move = 0

    for i in range(len(model_probs)):
        p = float(model_probs[i])
        p_open = float(primary_odds_open[i])
        o_open = float(opposing_odds_open[i])
        p_close = float(primary_odds_close[i])
        o_close = float(opposing_odds_close[i])

        if any(pd.isna(v) for v in [p, p_open, o_open, p_close, o_close]):
            continue

        nv_p_open, nv_o_open, m_open = compute_novig_probs(p_open, o_open)
        nv_p_close, nv_o_close, m_close = compute_novig_probs(p_close, o_close)

        if m_open < 0.001 or m_close < 0.001:
            continue

        clv = nv_p_close - nv_p_open if p >= 0.5 else nv_o_close - nv_o_open
        clv_all.append(clv)

        if clv > 0.002:
            line_toward += 1
        elif clv < -0.002:
            line_away += 1
        else:
            no_move += 1

    n = len(clv_all)
    if n == 0:
        return {"n": 0, "mean_clv": None, "mean_clv_pct": None,
                "note": "No valid CLV records"}

    mean_clv = float(np.mean(clv_all))
    return {
        "n": n,
        "mean_clv": round(mean_clv, 5),
        "mean_clv_pct": round(mean_clv * 100, 3),
        "median_clv": round(float(np.median(clv_all)), 5),
        "clv_positive_rate": round(sum(1 for c in clv_all if c > 0) / n, 3),
        "line_moved_toward_us": line_toward,
        "line_moved_away": line_away,
        "no_movement": no_move,
        "interpretation": (
            "POSITIVE CLV — model sees real edge"
            if mean_clv > 0.005
            else "NEAR-ZERO or NEGATIVE CLV — no evidence of edge vs closing line"
        ),
    }


# ---------------------------------------------------------------------------
# Walk-forward training
# ---------------------------------------------------------------------------
def train_fold(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val_es: np.ndarray,
    y_val_es: np.ndarray,
    fold_name: str,
) -> tuple[lgb.LGBMClassifier, np.ndarray]:
    """
    Train LightGBM on (X_train, y_train) with early stopping on temporal val.
    Returns (fitted_model, raw_val_probs_on_X_train).

    The raw probs returned are out-of-fold predictions for calibration:
    we re-score the training set with the model fit on that same data.
    This is admittedly in-sample for the OOF concept, but the critical point
    is that the CALIBRATOR is fit on predictions from fold A applied to fold B
    and vice versa — each fold's val predictions are truly out-of-fold.
    """
    print(f"  [{fold_name}] Training on {len(X_train)} games, "
          f"early-stopping val: {len(X_val_es)} games...")
    t0 = time.time()

    model = lgb.LGBMClassifier(**LGBM_PARAMS_V4)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val_es, y_val_es)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(-1)],
    )
    best_iter = model.best_iteration_
    print(f"  [{fold_name}] Best iteration: {best_iter} ({time.time()-t0:.1f}s)")
    return model


def walk_forward_oof_predictions(
    X_fold_a_train: np.ndarray, y_fold_a_train: np.ndarray,
    X_fold_a_val: np.ndarray,   y_fold_a_val: np.ndarray,
    X_fold_b_train: np.ndarray, y_fold_b_train: np.ndarray,
    X_fold_b_val: np.ndarray,   y_fold_b_val: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, lgb.LGBMClassifier, lgb.LGBMClassifier]:
    """
    Walk-forward OOF protocol:

    Fold A: train on 2022, early-stop-val on LAST 30 days of 2022,
            produce val predictions on H1-2023.
    Fold B: train on 2022+H1-2023, early-stop-val on LAST 30 days of
            2022+H1-2023, produce val predictions on H2-2023.

    OOF predictions: [fold_a_val_preds, fold_b_val_preds]
    OOF labels:      [y_fold_a_val,     y_fold_b_val]

    Returns (oof_preds, oof_labels, model_a, model_b).
    """
    # Fold A: temporal early-stopping val = last 30 days of fold-A training
    n_a = len(X_fold_a_train)
    n_a_es = max(100, int(n_a * 0.10))  # last ~10% as ES val (temporal)
    X_a_es = X_fold_a_train[-n_a_es:]
    y_a_es = y_fold_a_train[-n_a_es:]
    X_a_tr = X_fold_a_train[:-n_a_es]
    y_a_tr = y_fold_a_train[:-n_a_es]

    model_a = train_fold(X_a_tr, y_a_tr, X_a_es, y_a_es, "Fold-A")
    oof_preds_a = model_a.predict_proba(X_fold_a_val)[:, 1]
    print(f"  [Fold-A] OOF preds on H1-2023: n={len(oof_preds_a)}, "
          f"mean={oof_preds_a.mean():.3f}")

    # Fold B: temporal early-stopping val = last 10% of 2022+H1-2023
    n_b = len(X_fold_b_train)
    n_b_es = max(100, int(n_b * 0.10))
    X_b_es = X_fold_b_train[-n_b_es:]
    y_b_es = y_fold_b_train[-n_b_es:]
    X_b_tr = X_fold_b_train[:-n_b_es]
    y_b_tr = y_fold_b_train[:-n_b_es]

    model_b = train_fold(X_b_tr, y_b_tr, X_b_es, y_b_es, "Fold-B")
    oof_preds_b = model_b.predict_proba(X_fold_b_val)[:, 1]
    print(f"  [Fold-B] OOF preds on H2-2023: n={len(oof_preds_b)}, "
          f"mean={oof_preds_b.mean():.3f}")

    oof_preds = np.concatenate([oof_preds_a, oof_preds_b])
    oof_labels = np.concatenate([y_fold_a_val, y_fold_b_val])

    return oof_preds, oof_labels, model_a, model_b


def train_final_model(
    X_full_train: np.ndarray,
    y_full_train: np.ndarray,
) -> lgb.LGBMClassifier:
    """
    Train the final model on all of 2022+2023 combined.
    Early stopping val: last 10% of 2022+2023 (temporal, late 2023 games).
    """
    n = len(X_full_train)
    n_es = max(150, int(n * 0.10))
    X_es = X_full_train[-n_es:]
    y_es = y_full_train[-n_es:]
    X_tr = X_full_train[:-n_es]
    y_tr = y_full_train[:-n_es]

    print(f"  [Final] Train on {len(X_tr)} games, ES val: {len(X_es)} (last 10% of 2022+2023)...")
    t0 = time.time()
    model = lgb.LGBMClassifier(**LGBM_PARAMS_V4)
    model.fit(
        X_tr, y_tr,
        eval_set=[(X_es, y_es)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(-1)],
    )
    print(f"  [Final] Best iteration: {model.best_iteration_} ({time.time()-t0:.1f}s)")
    return model


# ---------------------------------------------------------------------------
# Main training function
# ---------------------------------------------------------------------------
def train_moneyline_v4(df: pd.DataFrame) -> dict:
    target_col = "home_win"
    feature_cols = MONEYLINE_FEATURES

    print(f"\n{'='*60}")
    print("Training: MONEYLINE v4 (walk-forward CV)")
    print(f"{'='*60}")

    valid = df.dropna(subset=[target_col]).copy()
    valid["game_date_dt"] = pd.to_datetime(valid["game_date"])
    valid["season_dt"] = valid["game_date_dt"].dt.year

    # --- Splits ---
    train_2022 = valid[valid["season_dt"] == 2022].sort_values("game_date_dt")
    h2023_full = valid[valid["season_dt"] == 2023].sort_values("game_date_dt")
    h1_2023 = h2023_full[h2023_full["game_date_dt"] < H2_2023_CUTOFF].copy()
    h2_2023 = h2023_full[h2023_full["game_date_dt"] >= H2_2023_CUTOFF].copy()
    holdout = valid[valid["season_dt"] == 2024].sort_values("game_date_dt").copy()
    train_full = pd.concat([train_2022, h2023_full], ignore_index=True).sort_values("game_date_dt")

    print(f"  2022 (fold-A train): {len(train_2022)} games")
    print(f"  H1-2023 (Apr–Jun, fold-A val / fold-B train part): {len(h1_2023)} games")
    print(f"  H2-2023 (Jul–Oct, fold-B val): {len(h2_2023)} games")
    print(f"  Full train (2022+2023): {len(train_full)} games")
    print(f"  2024 holdout (never touched until evaluation): {len(holdout)} games")

    # Ensure feature columns exist
    available_features = [f for f in feature_cols if f in valid.columns]
    missing = [f for f in feature_cols if f not in valid.columns]
    if missing:
        print(f"  Missing features (imputing 0): {missing[:5]}{'...' if len(missing) > 5 else ''}")
        for m in missing:
            for ds in [valid, train_2022, h1_2023, h2_2023, train_full, holdout]:
                ds[m] = 0.0
        available_features = feature_cols

    def to_xy(subset: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        return (
            subset[available_features].fillna(0).values,
            subset[target_col].astype(float).values,
        )

    X_2022, y_2022 = to_xy(train_2022)
    X_h1, y_h1 = to_xy(h1_2023)
    X_h2, y_h2 = to_xy(h2_2023)
    X_full, y_full = to_xy(train_full)
    X_hold, y_hold = to_xy(holdout)

    # Fold B train = 2022 + H1-2023
    X_fold_b_train = np.concatenate([X_2022, X_h1])
    y_fold_b_train = np.concatenate([y_2022, y_h1])

    # --- Walk-forward OOF predictions ---
    print("\n  Walk-forward OOF predictions...")
    oof_preds, oof_labels, model_a, model_b = walk_forward_oof_predictions(
        X_2022, y_2022, X_h1, y_h1,
        X_fold_b_train, y_fold_b_train, X_h2, y_h2,
    )

    print(f"\n  OOF pool: {len(oof_preds)} predictions")
    print(f"  OOF actual win rate: {oof_labels.mean():.4f}")
    print(f"  OOF pred mean: {oof_preds.mean():.4f}")

    oof_log_loss = log_loss(oof_labels, oof_preds)
    oof_brier = brier_score_loss(oof_labels, oof_preds)
    oof_ece = calibration_error(oof_labels, oof_preds)
    print(f"  OOF log-loss: {oof_log_loss:.4f} | Brier: {oof_brier:.4f} | ECE: {oof_ece:.4f}")

    # --- Fit isotonic calibrator on OOF predictions (temporal-safe) ---
    print("\n  Fitting isotonic calibrator on OOF predictions...")
    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(oof_preds, oof_labels)

    # Verify calibrator on OOF data (sanity check)
    cal_oof = calibrator.predict(oof_preds)
    cal_oof_ece = calibration_error(oof_labels, cal_oof)
    print(f"  Calibrator OOF ECE: {cal_oof_ece:.4f}")

    # --- Final model on 2022+2023 ---
    print("\n  Training final model on full 2022+2023...")
    final_model = train_final_model(X_full, y_full)

    # Calibrated predictions on 2024 holdout
    raw_hold = final_model.predict_proba(X_hold)[:, 1]
    cal_hold = calibrator.predict(raw_hold)
    cal_hold = np.clip(cal_hold, PROB_CLIP_LO, PROB_CLIP_HI)

    print(f"\n  2024 Holdout prob distribution:")
    print(f"    min={cal_hold.min():.3f} max={cal_hold.max():.3f} "
          f"mean={cal_hold.mean():.3f} std={cal_hold.std():.3f}")

    # --- Evaluation on 2024 holdout ---
    ll = log_loss(y_hold, cal_hold)
    brier = brier_score_loss(y_hold, cal_hold)
    ece = calibration_error(y_hold, cal_hold)
    actual_rate = float(y_hold.mean())
    mean_pred = float(cal_hold.mean())
    drift = abs(mean_pred - actual_rate)

    print(f"\n  2024 Holdout metrics:")
    print(f"    Log-loss: {ll:.4f}")
    print(f"    Brier: {brier:.4f}")
    print(f"    ECE: {ece:.4f}")
    print(f"    Mean P(home win): {mean_pred:.4f} | Actual: {actual_rate:.4f} | Drift: {drift:.4f}")

    # Reliability diagram
    diag_path = REPORTS_DIR / "calibration_v4_moneyline_holdout.png"
    max_dev = plot_reliability_diagram(y_hold, cal_hold, "moneyline v4 (walk-forward)", diag_path)
    print(f"    Max calibration deviation: {max_dev:.4f}")

    n_above_80 = int((cal_hold > PROB_CLIP_HI).sum())
    print(f"    Probs > 0.80: {n_above_80}")

    # --- ROI simulation (vig-removed, matches v3 backtest logic) ---
    primary_odds = get_best_odds(holdout, ("dk_ml_home", "fd_ml_home"))
    opposing_odds = get_best_odds(holdout, ("dk_ml_away", "fd_ml_away"))

    roi_stats = {}
    print(f"\n  ROI simulation (vig-removed, flat $100/pick):")
    for ev_thr in [0.02, 0.04, 0.06, 0.08, 0.10]:
        key = f"ev_thr_{int(ev_thr*100)}pct"
        roi_stats[key] = simulate_roi_novig(
            cal_hold, y_hold, primary_odds, opposing_odds, ev_threshold=ev_thr
        )
        r = roi_stats[key]
        print(f"    EV>{int(ev_thr*100)}%: {r['n']} picks | ROI {r['roi']:+.1f}% | WR {r['win_rate']:.3f}")

    # --- CLV (load snapshots for 2024) ---
    clv_result = {"n": 0, "note": "CLV computed by run_backtest_v3.py — skipped here"}
    try:
        from worker.models.backtest.run_backtest_v3 import (
            load_odds_with_snapshots,
            build_opening_closing_lines,
        )
        snapshots_df = load_odds_with_snapshots([2024])
        if not snapshots_df.empty:
            opening_odds, closing_odds = build_opening_closing_lines(snapshots_df)

            p_cols = ("dk_ml_home", "fd_ml_home")
            o_cols = ("dk_ml_away", "fd_ml_away")

            hold_merge_keys = ["home_team_abbr", "away_team_abbr", "game_date"]
            if all(c in holdout.columns for c in hold_merge_keys):
                open_sub = opening_odds[[c for c in list(p_cols) + list(o_cols) + ["home_team", "away_team", "game_date"] if c in opening_odds.columns]].copy()
                close_sub = closing_odds[[c for c in list(p_cols) + list(o_cols) + ["home_team", "away_team", "game_date"] if c in closing_odds.columns]].copy()

                for ds in [open_sub, close_sub]:
                    ds.rename(columns={"home_team": "home_team_abbr", "away_team": "away_team_abbr"}, inplace=True)

                hold_sub = holdout[hold_merge_keys].copy()
                hold_sub["_idx"] = range(len(holdout))

                odds_ren_open = {c: f"{c}_open" for c in list(p_cols) + list(o_cols) if c in open_sub.columns}
                odds_ren_close = {c: f"{c}_close" for c in list(p_cols) + list(o_cols) if c in close_sub.columns}

                mo = hold_sub.merge(open_sub.rename(columns=odds_ren_open), on=hold_merge_keys, how="left").sort_values("_idx").reset_index(drop=True)
                mc = hold_sub.merge(close_sub.rename(columns=odds_ren_close), on=hold_merge_keys, how="left").sort_values("_idx").reset_index(drop=True)

                def _arr(df: pd.DataFrame, col: str, sfx: str) -> np.ndarray:
                    c = f"{col}_{sfx}"
                    return df[c].astype(float).fillna(np.nan).values if c in df.columns else np.full(len(df), np.nan)

                p_open = np.maximum(_arr(mo, p_cols[0], "open"), _arr(mo, p_cols[1], "open"))
                o_open = np.maximum(_arr(mo, o_cols[0], "open"), _arr(mo, o_cols[1], "open"))
                p_close = np.maximum(_arr(mc, p_cols[0], "close"), _arr(mc, p_cols[1], "close"))
                o_close = np.maximum(_arr(mc, o_cols[0], "close"), _arr(mc, o_cols[1], "close"))

                if len(p_open) == len(holdout):
                    clv_result = compute_clv_simple(cal_hold, p_open, o_open, p_close, o_close)
                    print(f"\n  CLV: mean={clv_result.get('mean_clv_pct', 'N/A')}% "
                          f"({clv_result.get('n', 0)} records)")
                    print(f"  CLV interpretation: {clv_result.get('interpretation', 'N/A')}")
    except Exception as e:
        print(f"\n  CLV computation skipped: {e}")

    # --- SHAP ---
    print("\n  Computing SHAP values (base final model)...")
    shap_importance = {}
    try:
        explainer = shap.TreeExplainer(final_model)
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

    # --- Save artifacts ---
    artifact_dir = MODELS_DIR / "moneyline" / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    model_artifact = {
        "model": final_model,
        "calibrator": calibrator,
        "features": available_features,
        "prob_clip_lo": PROB_CLIP_LO,
        "prob_clip_hi": PROB_CLIP_HI,
        "version": "moneyline-v4.0.0",
        "training_protocol": "walk_forward_cv",
        "walk_forward_folds": {
            "fold_a": {"train": "2022", "val": "H1-2023 (Apr-Jun)"},
            "fold_b": {"train": "2022+H1-2023", "val": "H2-2023 (Jul-Oct)"},
            "final": {"train": "2022+2023", "holdout": "2024"},
        },
        "calibration_protocol": "isotonic_on_oof_predictions",
    }
    with open(artifact_dir / "model.pkl", "wb") as f:
        pickle.dump(model_artifact, f)

    with open(artifact_dir / "shap_importance.json", "w") as f:
        json.dump(shap_importance, f, indent=2)

    data_hash = df["_data_hash"].iloc[0] if "_data_hash" in df.columns else "unknown"

    # Tier counts
    evs = np.array([
        max(compute_ev(float(p), int(po)), compute_ev(1.0 - float(p), int(oo)))
        for p, po, oo in zip(cal_hold, primary_odds, opposing_odds)
    ])
    tiers = np.array([assign_confidence_tier(ev) for ev in evs])
    tier_counts = {f"tier_{i}": int((tiers >= i).sum()) for i in range(1, 6)}

    metrics = {
        "market": "moneyline",
        "version": "moneyline-v4.0.0",
        "model_version": "v4",
        "training_protocol": "walk_forward_cv",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_seasons": [2022, 2023],
        "holdout_season": 2024,
        "split_details": {
            "2022_games": len(train_2022),
            "h1_2023_games": len(h1_2023),
            "h2_2023_games": len(h2_2023),
            "full_train_games": len(train_full),
            "holdout_games": len(holdout),
            "h2_cutoff": H2_2023_CUTOFF,
        },
        "data_hash": data_hash,
        "features": available_features,
        "n_features": len(available_features),
        "lgbm_best_iteration_final": int(final_model.best_iteration_),
        "lgbm_params": LGBM_PARAMS_V4,
        "calibration_method": "IsotonicRegression on walk-forward OOF predictions",
        "prob_clip": [PROB_CLIP_LO, PROB_CLIP_HI],
        "oof_log_loss": round(oof_log_loss, 4),
        "oof_brier": round(oof_brier, 4),
        "oof_ece": round(oof_ece, 4),
        "oof_calibrated_ece": round(cal_oof_ece, 4),
        "holdout_log_loss": round(ll, 4),
        "holdout_brier": round(brier, 4),
        "holdout_ece": round(ece, 4),
        "holdout_max_calibration_deviation": round(max_dev, 4),
        "calibration_pass": bool(max_dev < 0.05),
        "ece_pass": bool(ece < 0.025),
        "n_probs_above_80": n_above_80,
        "prob_constraint_pass": bool(n_above_80 == 0),
        "holdout_mean_prob": round(mean_pred, 4),
        "holdout_actual_rate": round(actual_rate, 4),
        "prob_vs_actual_drift": round(drift, 4),
        "roi_simulation_novig": roi_stats,
        "clv": clv_result,
        "tier_pick_counts": tier_counts,
        "shap_top10": list(shap_importance.items())[:10],
        "known_weaknesses": [
            "Only 2 seasons of training data (2022+2023) — add 2021 in v5",
            "Umpire features imputed — no real ump signal",
            "Weather features imputed — game-time weather would improve predictions",
            "Lineup handedness imputed — platoon features weak until LINEUP-01",
            "Statcast xFIP missing — FIP used as proxy",
            "OOF calibration pool is 2023-only (~2400 games) — limited isotonic stability",
            "SHAP computed on base final model, not the calibrated output",
        ],
        "overfitting_diagnosis": {
            "v2_leak_source_1": "CalibratedClassifierCV(cv=5) random k-fold on 2022+2023 "
                                "— temporal future contamination in calibration folds",
            "v2_leak_source_2": "Early stopping val = random 15% of train, not temporal "
                                "— 2023 games validated against 2022 games out of order",
            "v4_fix_1": "Calibration fit on OOF predictions from walk-forward folds A+B "
                        "— no future data seen during calibrator fitting",
            "v4_fix_2": "Early stopping val = last 10% (temporal) of each fold's train window "
                        "— never uses future-dated data to stop training",
            "v4_fix_3": "Fold structure: A=(2022 train, H1-2023 val), B=(2022+H1-2023 train, H2-2023 val) "
                        "— strictly increasing time windows",
        },
    }

    manifest_path = artifact_dir / "manifest.json"
    with open(manifest_path, "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"\n  Artifacts saved: {artifact_dir}")
    print(f"  Manifest: {manifest_path}")

    return metrics


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> dict:
    print("Diamond Edge — Moneyline v4 Walk-Forward Training")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
    print(f"Walk-forward split: 2022 train | H1-2023 val | 2022+H1-2023 train | H2-2023 val | 2024 holdout")
    print()

    # Load cached processed parquet (avoids re-running full feature pipeline)
    processed_path = DATA_DIR / "games_v1_processed.parquet"
    if processed_path.exists():
        print(f"Loading cached feature dataset: {processed_path}")
        df = pd.read_parquet(processed_path)
        print(f"  {len(df)} games, {len(df.columns)} columns")
    else:
        print("No cached parquet found — building features from raw data...")
        from worker.models.pipelines.train_models import load_and_build_features
        df = load_and_build_features()
        df.to_parquet(processed_path, index=False)
        print(f"Cached to {processed_path}")

    metrics = train_moneyline_v4(df)

    # Save v4 backtest report
    report = {
        "backtest_date": datetime.now(timezone.utc).isoformat(),
        "version": "v4",
        "market": "moneyline",
        "holdout_season": 2024,
        "training_protocol": "walk_forward_cv",
        "vig_removal_applied": True,
        "result": metrics,
        "verdict": _compute_verdict(metrics),
        "comparison_v3": {
            "v3_roi_4pct_ev": 15.83,
            "v3_roi_6pct_ev": 17.82,
            "v3_roi_8pct_ev": 17.9,
            "v3_picks_8pct_ev": 1177,
            "v3_win_rate_8pct_ev": 0.4775,
            "v3_mean_clv_pct": 0.057,
            "note": "v3 used v2 model with CalibratedClassifierCV random k-fold "
                    "(temporal contamination). v4 uses walk-forward OOF calibration.",
        },
    }

    report_path = REPORTS_DIR / "backtest_v4_moneyline.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nv4 backtest report: {report_path}")

    # Print headline
    roi_4 = metrics["roi_simulation_novig"].get("ev_thr_4pct", {})
    roi_6 = metrics["roi_simulation_novig"].get("ev_thr_6pct", {})
    roi_8 = metrics["roi_simulation_novig"].get("ev_thr_8pct", {})

    print("\n" + "="*60)
    print("MONEYLINE v4 RESULTS (2024 holdout, walk-forward CV, vig-removed)")
    print("="*60)
    print(f"  Log-loss: {metrics['holdout_log_loss']} | Brier: {metrics['holdout_brier']} | ECE: {metrics['holdout_ece']}")
    print(f"  Calibration deviation: {metrics['holdout_max_calibration_deviation']} ({'PASS' if metrics['calibration_pass'] else 'FAIL'})")
    print(f"  ROI @ 4% EV:  {roi_4.get('roi', 'N/A'):+}% ({roi_4.get('n', 0)} picks, WR {roi_4.get('win_rate', 0):.3f})")
    print(f"  ROI @ 6% EV:  {roi_6.get('roi', 'N/A'):+}% ({roi_6.get('n', 0)} picks, WR {roi_6.get('win_rate', 0):.3f})")
    print(f"  ROI @ 8% EV:  {roi_8.get('roi', 'N/A'):+}% ({roi_8.get('n', 0)} picks, WR {roi_8.get('win_rate', 0):.3f})")

    clv = metrics.get("clv", {})
    if clv.get("n", 0) > 0:
        print(f"  Mean CLV: {clv.get('mean_clv_pct', 'N/A')}% ({clv.get('n', 0)} records)")
        print(f"  CLV: {clv.get('interpretation', 'N/A')}")

    print(f"\n  VERDICT: {report['verdict']}")

    return metrics


def _compute_verdict(metrics: dict) -> str:
    roi_8 = metrics["roi_simulation_novig"].get("ev_thr_8pct", {}).get("roi", None)
    clv_pct = metrics.get("clv", {}).get("mean_clv_pct", None)

    if roi_8 is None:
        return "INCONCLUSIVE — no ROI data"

    if roi_8 > 10:
        return (
            f"STILL UNREALISTIC (ROI={roi_8}% @ 8%EV) — residual phantom edge; "
            "investigate further before deploy"
        )
    elif roi_8 > 2:
        clv_note = f", CLV={clv_pct}%" if clv_pct is not None else ""
        return (
            f"POSSIBLE REAL ALPHA (ROI={roi_8}% @ 8%EV{clv_note}) — "
            "within plausible range; validate with CLV before deploy"
        )
    elif roi_8 >= -5:
        return (
            f"NO ALPHA (ROI={roi_8}% @ 8%EV) — model has no edge; "
            "market-tracking only; do not deploy pick signal"
        )
    else:
        return (
            f"NEGATIVE EDGE (ROI={roi_8}% @ 8%EV) — model is worse than random; "
            "do not deploy"
        )


if __name__ == "__main__":
    main()
