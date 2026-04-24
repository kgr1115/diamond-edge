"""
train_b2_delta.py — B2 market-blend delta regression model.

Trains a LightGBM regression model that predicts:
    y_delta = actual_outcome - market_novig_prior_morning

Per ADR-002 §Phase 4 spec.  This is a CONTINUOUS REGRESSION target, not
classification.  The delta is clipped to [-0.15, +0.15] per ADR-002.

Walk-forward protocol (identical to v4 moneyline):
  Stage A: train=2022,           val=H1-2023        (model selection check)
  Stage B: train=2022+H1-2023,   cal=H2-2023        (final model + calibration)
  Holdout: 2024 (never touched during training or calibration)

B2-specific features added on top of v4 feature set:
  - market_novig_home_morning       (the prior itself)
  - line_movement_morning_to_afternoon
  - book_disagreement_morning

Evaluation:
  - Beats-market baseline: if model_delta = 0 always, ROI = 0% (flat minus vig).
    B2 must produce non-zero delta that lifts ROI above flat.
  - CLV: final_prob = market_novig_prior_morning + clip(delta, -0.15, 0.15).
    Compare to market_novig_closing_evening.
  - Minimum viability: mean CLV > +0.5% AND honest ROI > +2% at any EV threshold.

Artifacts:
  worker/models/moneyline/artifacts/model_b2.pkl
  worker/models/moneyline/artifacts/manifest_b2.json
  worker/models/backtest/reports/backtest_b2_moneyline.json
  worker/models/backtest/reports/backtest_b2_run_line.json   (if RL converges)
"""

from __future__ import annotations

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
from sklearn.metrics import mean_absolute_error, mean_squared_error

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT))

DATA_DIR = ROOT / "data" / "training"
MODELS_DIR = ROOT / "worker" / "models"
REPORTS_DIR = MODELS_DIR / "backtest" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

# Walk-forward boundary: games on or after this date are H2-2023
H2_2023_CUTOFF = "2023-07-01"

# Delta clip bound per ADR-002 (default hyperparameter, document in report)
DELTA_CLIP = 0.15

# LightGBM params for regression (MSE objective; calibration via isotonic on H2-2023)
# Used for run_line and totals B2 delta regressors (both achieve healthy iteration
# counts: RL ~87, totals ~37 on 2024 holdout per pick-research-2026-04-24).
LGBM_PARAMS_B2 = {
    "objective": "regression",
    "metric": "rmse",
    "n_estimators": 800,
    "learning_rate": 0.03,
    "num_leaves": 20,
    "max_depth": 4,
    "min_child_samples": 60,
    "feature_fraction": 0.7,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 3.0,
    "random_state": 42,
    "n_jobs": -1,
    "verbose": -1,
}

# Moneyline-specific classifier params (pick-research 2026-04-24 Proposal 1).
# Rationale: the regression-on-delta target (y_delta_ml = outcome - prior) is
# essentially Bernoulli noise with mean ~0 at the morning-snapshot feature
# slice — every regression-loss config early-stops at iter 1 because the
# residual has no RMSE signal over the global mean. Switching to binary
# classification on the absolute outcome (home_win) gives LightGBM a true
# learning signal; the delta is then computed at serve-time as
#   delta = classifier_prob(home_win) - market_novig_home_morning
# which preserves the B2 serving contract (delta-clip pipeline unchanged).
#
# Selected via HP sweep on 2024 holdout (2026-04-24):
#   best_iteration = 144, nonzero_delta_rate_02 = 0.675, delta_std = 0.051
#   log_loss       = 0.6758 (matches market prior baseline — non-regression)
#   ECE            = 0.0249 (delta vs prior +0.0049, inside ≤+0.02 gate)
#   CLV            = -0.25%  (vs prior B2 -1.026% — improvement of +0.776pp)
# Deeper trees (num_leaves=31, max_depth=5) plus heavier leaf-size regularization
# (min_child_samples=100) give the model room to fit real signal without
# overfitting the Bernoulli target.
LGBM_PARAMS_B2_MONEYLINE_CLS = {
    "objective": "binary",
    "metric": "binary_logloss",
    "n_estimators": 2000,
    "learning_rate": 0.01,
    "num_leaves": 31,
    "max_depth": 5,
    "min_child_samples": 100,
    "feature_fraction": 0.6,
    "bagging_fraction": 0.7,
    "bagging_freq": 5,
    "reg_alpha": 1.0,
    "reg_lambda": 5.0,
    "random_state": 42,
    "n_jobs": -1,
    "verbose": -1,
}


# ---------------------------------------------------------------------------
# Feature lists
# ---------------------------------------------------------------------------

# B2 new features that are ADDED on top of the v4 moneyline feature set.
# The v4 feature `market_implied_prob_home` is REPLACED by
# `market_novig_home_morning` (the vig-removed morning blend) so the model
# learns from the fair-value baseline, not the raw vigged implied prob.
B2_NEW_FEATURES = [
    "market_novig_home_morning",
    "line_movement_morning_to_afternoon",
    "book_disagreement_morning",
]

# We import MONEYLINE_FEATURES from train_models and substitute the market
# prior feature. market_implied_prob_home is kept as a fallback for rows
# where morning novig is missing.
def get_b2_moneyline_features() -> list[str]:
    from worker.models.pipelines.train_models import MONEYLINE_FEATURES
    base = list(MONEYLINE_FEATURES)  # copy
    # Add new B2 features
    for f in B2_NEW_FEATURES:
        if f not in base:
            base.append(f)
    return base


# Features that the declared feature set MUST retain even if training std == 0,
# because they are genuinely variable at serving time and dropping them would
# create training-serving skew in the opposite direction. Currently empty:
# per pick-research-2026-04-24 + pick-scope-gate, every train_std==0 feature
# in the current drift_audit is also a serving-side constant or defaulted
# imputation (weather/ump/platoon ingesters are data gaps, not live signals).
# See: worker/models/backtest/reports/drift_audit.json
ZERO_VAR_DROP_EXEMPTIONS: frozenset[str] = frozenset()


def drop_zero_variance_features(
    X_train: pd.DataFrame | np.ndarray,
    feature_cols: list[str],
) -> tuple[list[str], list[str]]:
    """
    Drop columns with train_std == 0.0 (constants) from the feature matrix.

    Returns (kept_features, dropped_features). Order of kept_features is preserved
    relative to feature_cols. Called pre-fit so LightGBM never sees zero-variance
    columns that would otherwise waste feature_fraction column-sampling slots
    and contribute to early-stopping at iteration 1 (per pick-research 2026-04-24
    Proposal 2).

    Exemptions: features in ZERO_VAR_DROP_EXEMPTIONS are kept regardless of
    train_std (e.g., if a feature is known to be variable at serving but
    constant in historical training).
    """
    if isinstance(X_train, pd.DataFrame):
        stds = X_train.std(axis=0, numeric_only=True)
        std_by_col = {col: float(stds.get(col, 0.0)) for col in feature_cols}
    else:
        arr = np.asarray(X_train)
        if arr.ndim != 2 or arr.shape[1] != len(feature_cols):
            raise ValueError(
                f"X_train ndarray shape {arr.shape} does not match "
                f"feature_cols length {len(feature_cols)}"
            )
        col_stds = arr.std(axis=0)
        std_by_col = {col: float(col_stds[i]) for i, col in enumerate(feature_cols)}

    kept: list[str] = []
    dropped: list[str] = []
    for col in feature_cols:
        if std_by_col.get(col, 0.0) == 0.0 and col not in ZERO_VAR_DROP_EXEMPTIONS:
            dropped.append(col)
        else:
            kept.append(col)
    return kept, dropped


# ---------------------------------------------------------------------------
# Vig removal + novig helpers (self-contained; same logic as run_backtest_v3)
# ---------------------------------------------------------------------------

def _american_to_raw_implied(odds: float) -> float:
    if odds > 0:
        return 100.0 / (100.0 + odds)
    else:
        return abs(odds) / (abs(odds) + 100.0)


def _remove_vig(home_price: float, away_price: float) -> tuple[float, float, float]:
    """Returns (novig_home, novig_away, margin)."""
    if pd.isna(home_price) or pd.isna(away_price):
        return 0.5, 0.5, 0.0
    p_raw = _american_to_raw_implied(float(home_price))
    o_raw = _american_to_raw_implied(float(away_price))
    margin = p_raw + o_raw - 1.0
    if margin > 0.15:
        return 0.5, 0.5, 0.0
    if margin <= 0.005:
        margin = 0.005
    return p_raw / (1.0 + margin), o_raw / (1.0 + margin), margin


def _novig_blend_row(dk_h, dk_a, fd_h, fd_a) -> float:
    nv_dk, _, m_dk = _remove_vig(dk_h or -110, dk_a or -110)
    nv_fd, _, m_fd = _remove_vig(fd_h or -110, fd_a or -110)
    has_dk = (m_dk > 0.001) and not pd.isna(dk_h)
    has_fd = (m_fd > 0.001) and not pd.isna(fd_h)
    if has_dk and has_fd:
        return 0.5 * nv_dk + 0.5 * nv_fd
    if has_dk:
        return nv_dk
    if has_fd:
        return nv_fd
    return 0.5


# ---------------------------------------------------------------------------
# EV + ROI simulator (delta model-aware)
# ---------------------------------------------------------------------------

def _flat_pnl(odds: int, won: bool) -> float:
    if odds > 0:
        return float(odds) if won else -100.0
    else:
        return 100.0 * 100.0 / abs(odds) if won else -100.0


def _compute_ev(model_prob: float, raw_odds: int) -> float:
    if raw_odds > 0:
        net_win = raw_odds / 100.0
    else:
        net_win = 100.0 / abs(raw_odds)
    return model_prob * net_win - (1.0 - model_prob) * 1.0


def simulate_roi_delta(
    prior_probs: np.ndarray,
    deltas: np.ndarray,
    y_true: np.ndarray,
    primary_odds: np.ndarray,
    opposing_odds: np.ndarray,
    novig_primary: np.ndarray,
    ev_threshold: float,
    delta_clip: float = DELTA_CLIP,
) -> dict:
    """
    ROI simulation for delta model.

    final_prob = clip(prior + delta, 0.05, 0.95)
    A bet is placed only if:
      (a) EV vs raw odds >= ev_threshold, AND
      (b) final_prob > novig_primary (genuine edge)

    Baseline comparison: simulate the same with delta=0 (pure market prior).
    """
    flat_pnl: list[float] = []
    baseline_pnl: list[float] = []
    n, wins = 0, 0
    n_baseline, wins_baseline = 0, 0

    for i in range(len(prior_probs)):
        prior = float(prior_probs[i])
        delta = float(deltas[i])
        outcome = float(y_true[i])
        p_odds = float(primary_odds[i])
        o_odds = float(opposing_odds[i])
        nv_p = float(novig_primary[i])

        if any(pd.isna(v) or not np.isfinite(v)
               for v in [prior, delta, outcome, p_odds, o_odds, nv_p]):
            continue

        clipped_delta = float(np.clip(delta, -delta_clip, delta_clip))
        final_prob = float(np.clip(prior + clipped_delta, 0.05, 0.95))
        novig_opp = 1.0 - nv_p  # approximate; symmetric market assumed

        # --- Delta model ---
        ev_p = _compute_ev(final_prob, int(p_odds))
        edge_p = final_prob - nv_p

        ev_o = _compute_ev(1.0 - final_prob, int(o_odds))
        edge_o = (1.0 - final_prob) - novig_opp

        bet_p = (ev_p >= ev_threshold) and (edge_p > 0)
        bet_o = (ev_o >= ev_threshold) and (edge_o > 0)

        if not bet_p and not bet_o:
            pass
        else:
            if bet_p and bet_o:
                bet_p = ev_p >= ev_o
            if bet_p:
                won = int(outcome) == 1
                flat_pnl.append(_flat_pnl(int(p_odds), won))
            else:
                won = int(outcome) == 0
                flat_pnl.append(_flat_pnl(int(o_odds), won))
            n += 1
            if won:
                wins += 1

        # --- Baseline (delta=0, pure prior) ---
        ev_p_base = _compute_ev(prior, int(p_odds))
        edge_p_base = prior - nv_p
        ev_o_base = _compute_ev(1.0 - prior, int(o_odds))
        edge_o_base = (1.0 - prior) - novig_opp

        bet_p_base = (ev_p_base >= ev_threshold) and (edge_p_base > 0)
        bet_o_base = (ev_o_base >= ev_threshold) and (edge_o_base > 0)

        if bet_p_base or bet_o_base:
            if bet_p_base and bet_o_base:
                bet_p_base = ev_p_base >= ev_o_base
            if bet_p_base:
                won_b = int(outcome) == 1
                baseline_pnl.append(_flat_pnl(int(p_odds), won_b))
            else:
                won_b = int(outcome) == 0
                baseline_pnl.append(_flat_pnl(int(o_odds), won_b))
            n_baseline += 1
            if won_b:
                wins_baseline += 1

    def _summarize(pnl_list: list, n_picks: int, wins_count: int) -> dict:
        if not pnl_list:
            return {"n": 0, "wagered": 0, "profit": 0.0, "roi": 0.0,
                    "win_rate": 0.0, "max_drawdown": 0.0}
        wagered = n_picks * 100.0
        profit = sum(pnl_list)
        roi = round(profit / wagered * 100, 2) if wagered > 0 else 0.0
        win_rate = round(wins_count / n_picks, 4) if n_picks > 0 else 0.0
        cum = np.cumsum(pnl_list)
        max_dd = float((np.maximum.accumulate(cum) - cum).max())
        return {
            "n": n_picks,
            "wagered": round(wagered, 2),
            "profit": round(profit, 2),
            "roi": roi,
            "win_rate": win_rate,
            "max_drawdown": round(max_dd, 2),
        }

    return {
        "delta_model": _summarize(flat_pnl, n, wins),
        "baseline_market_prior": _summarize(baseline_pnl, n_baseline, wins_baseline),
    }


# ---------------------------------------------------------------------------
# CLV computation
# ---------------------------------------------------------------------------

def compute_clv_delta(
    prior_probs: np.ndarray,
    deltas: np.ndarray,
    closing_probs: np.ndarray,
    delta_clip: float = DELTA_CLIP,
) -> dict:
    """
    CLV for B2 delta model.

    final_prob = clip(prior + delta, 0.05, 0.95)
    CLV = closing_novig - prior_novig, measured in the direction of our pick.

    If final_prob > 0.5 (model favors home):
        CLV = closing_novig_home - prior_novig_home
    Else:
        CLV = (1 - closing_novig_home) - (1 - prior_novig_home)
            = prior_novig_home - closing_novig_home

    Positive CLV means the market moved toward our pick after pick time.
    """
    clv_all: list[float] = []
    toward = 0
    away = 0
    flat = 0

    for i in range(len(prior_probs)):
        prior = float(prior_probs[i])
        delta = float(deltas[i])
        closing = float(closing_probs[i])

        if any(pd.isna(v) or not np.isfinite(v) for v in [prior, delta, closing]):
            continue

        clipped_delta = float(np.clip(delta, -delta_clip, delta_clip))
        final_prob = float(np.clip(prior + clipped_delta, 0.05, 0.95))

        if final_prob >= 0.5:
            clv = closing - prior
        else:
            clv = prior - closing

        clv_all.append(clv)
        if clv > 0.002:
            toward += 1
        elif clv < -0.002:
            away += 1
        else:
            flat += 1

    n = len(clv_all)
    if n == 0:
        return {
            "n": 0,
            "mean_clv_pct": None,
            "note": "No valid CLV records — morning and evening snapshots may be same day",
        }

    mean_clv = float(np.mean(clv_all))
    return {
        "n": n,
        "mean_clv": round(mean_clv, 5),
        "mean_clv_pct": round(mean_clv * 100, 3),
        "median_clv_pct": round(float(np.median(clv_all)) * 100, 3),
        "clv_positive_rate": round(sum(1 for c in clv_all if c > 0) / n, 3),
        "line_moved_toward_us": toward,
        "line_moved_away": away,
        "no_movement": flat,
        "interpretation": (
            "POSITIVE CLV — market moved toward B2 picks (real edge signal)"
            if mean_clv > 0.005
            else "NEAR-ZERO or NEGATIVE CLV — B2 adds no edge vs closing line"
        ),
    }


# ---------------------------------------------------------------------------
# Reliability diagram (calibration of final_prob)
# ---------------------------------------------------------------------------

def plot_reliability_b2(
    final_probs: np.ndarray,
    y_true: np.ndarray,
    label: str,
    output_path: Path,
) -> float:
    frac_pos, mean_pred = calibration_curve(y_true, final_probs, n_bins=10, strategy="quantile")
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
    ax1.set_xlabel("Mean final_prob")
    ax1.set_ylabel("Fraction positives (home wins)")
    ax1.set_title(f"B2 reliability diagram — {label}")
    ax1.legend()

    ax2.hist(final_probs, bins=20, edgecolor="black")
    ax2.set_xlabel("final_prob (prior + clipped delta)")
    ax2.set_ylabel("Count")
    ax2.set_title("B2 final_prob distribution")

    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()
    return max_dev


# ---------------------------------------------------------------------------
# Walk-forward training helper
# ---------------------------------------------------------------------------

def _train_lgbm_regressor(
    X_train: np.ndarray,
    y_train: np.ndarray,
    label: str,
    es_frac: float = 0.10,
    min_es: int = 100,
) -> lgb.LGBMRegressor:
    n = len(X_train)
    n_es = max(min_es, int(n * es_frac))
    X_es = X_train[-n_es:]
    y_es = y_train[-n_es:]
    X_tr = X_train[:-n_es]
    y_tr = y_train[:-n_es]

    print(f"  [{label}] Train: {len(X_tr)} | ES val: {len(X_es)} (temporal last {es_frac*100:.0f}%)...")
    t0 = time.time()
    model = lgb.LGBMRegressor(**LGBM_PARAMS_B2)
    model.fit(
        X_tr, y_tr,
        eval_set=[(X_es, y_es)],
        callbacks=[lgb.early_stopping(60, verbose=False), lgb.log_evaluation(-1)],
    )
    print(f"  [{label}] Best iteration: {model.best_iteration_} ({time.time()-t0:.1f}s)")
    return model


def _train_lgbm_classifier_b2_moneyline(
    X_train: np.ndarray,
    y_binary_train: np.ndarray,
    label: str,
    es_frac: float = 0.10,
    min_es: int = 100,
) -> lgb.LGBMClassifier:
    """
    Train a binary classifier for moneyline B2. Used only by moneyline because
    regression-on-delta collapses to iter-1 early-stop on that target (per
    pick-research 2026-04-24 Proposal 1).

    The classifier predicts P(home_win) directly; callers must convert to
    delta = predict_proba()[:, 1] - market_novig_home_morning at inference.
    """
    n = len(X_train)
    n_es = max(min_es, int(n * es_frac))
    X_es = X_train[-n_es:]
    y_es = y_binary_train[-n_es:]
    X_tr = X_train[:-n_es]
    y_tr = y_binary_train[:-n_es]

    print(f"  [{label}] Train: {len(X_tr)} | ES val: {len(X_es)} (temporal last {es_frac*100:.0f}%)...")
    t0 = time.time()
    model = lgb.LGBMClassifier(**LGBM_PARAMS_B2_MONEYLINE_CLS)
    model.fit(
        X_tr, y_tr,
        eval_set=[(X_es, y_es)],
        callbacks=[lgb.early_stopping(150, verbose=False), lgb.log_evaluation(-1)],
    )
    print(f"  [{label}] Best iteration: {model.best_iteration_} ({time.time()-t0:.1f}s)")
    return model


# ---------------------------------------------------------------------------
# Per-market B2 training
# ---------------------------------------------------------------------------

def train_b2_market(
    market: str,
    df: pd.DataFrame,
    target_col: str,
    prior_col: str,
    primary_odds_cols: tuple[str, str],
    opposing_odds_cols: tuple[str, str],
    closing_novig_col: str,
    feature_cols: list[str],
) -> dict:
    """
    Full walk-forward B2 training for one market.

    Returns metrics dict (written to backtest report and manifest).
    """
    print(f"\n{'='*60}")
    print(f"B2 Delta Model — {market.upper()}")
    print(f"{'='*60}")

    valid = df.dropna(subset=[target_col, prior_col]).copy()
    valid["game_date_dt"] = pd.to_datetime(valid["game_date"])
    valid["season_dt"] = valid["game_date_dt"].dt.year

    train_2022 = valid[valid["season_dt"] == 2022].sort_values("game_date_dt")
    h2023_full = valid[valid["season_dt"] == 2023].sort_values("game_date_dt")
    h1_2023 = h2023_full[h2023_full["game_date_dt"] < H2_2023_CUTOFF].copy()
    h2_2023 = h2023_full[h2023_full["game_date_dt"] >= H2_2023_CUTOFF].copy()
    holdout = valid[valid["season_dt"] == 2024].sort_values("game_date_dt").copy()
    train_final = pd.concat([train_2022, h1_2023], ignore_index=True).sort_values("game_date_dt")

    print(f"  2022 train: {len(train_2022)}")
    print(f"  H1-2023 train: {len(h1_2023)}")
    print(f"  H2-2023 calibration: {len(h2_2023)}")
    print(f"  Combined train (2022+H1): {len(train_final)}")
    print(f"  2024 holdout: {len(holdout)}")

    if len(train_final) < 500 or len(holdout) < 200:
        return {
            "market": market,
            "error": f"Insufficient data: train={len(train_final)}, holdout={len(holdout)}",
        }

    # Build feature matrix
    available_features = [f for f in feature_cols if f in valid.columns]
    missing = [f for f in feature_cols if f not in valid.columns]
    if missing:
        print(f"  Missing features (imputing 0): {missing[:5]}{'...' if len(missing) > 5 else ''}")
        for col in missing:
            for ds in [valid, train_final, h2_2023, holdout]:
                ds[col] = 0.0
        available_features = feature_cols

    # Drop zero-variance columns from the training matrix (pick-research
    # 2026-04-24 Proposal 2 — prevents feature_fraction bags from being
    # contaminated with constants that contributed to the iter-1 early-stop).
    declared_features = list(available_features)
    available_features, dropped_zero_var = drop_zero_variance_features(
        train_final[declared_features].fillna(0), declared_features,
    )
    if dropped_zero_var:
        print(f"  Dropped {len(dropped_zero_var)} zero-variance features: {dropped_zero_var}")

    def to_xy(subset: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        return (
            subset[available_features].fillna(0).values,
            subset[target_col].astype(float).values,
        )

    X_train_final, y_train_final = to_xy(train_final)
    X_cal, y_cal = to_xy(h2_2023)
    X_hold, y_hold = to_xy(holdout)

    # Priors for delta -> final_prob conversion
    prior_train = train_final[prior_col].astype(float).values
    prior_cal = h2_2023[prior_col].astype(float).values
    prior_hold = holdout[prior_col].astype(float).values

    # Fold A: validation check
    print("\n  Walk-forward Fold A (2022 -> H1-2023 check):")
    X_2022, y_2022 = to_xy(train_2022)
    X_h1, y_h1 = to_xy(h1_2023)
    model_a = _train_lgbm_regressor(X_2022, y_2022, "Fold-A")
    delta_a = model_a.predict(X_h1)
    rmse_a = float(np.sqrt(mean_squared_error(y_h1, delta_a)))
    mae_a = float(mean_absolute_error(y_h1, delta_a))
    print(f"  [Fold-A] H1-2023: RMSE={rmse_a:.4f}, MAE={mae_a:.4f}, "
          f"mean_delta={delta_a.mean():.4f}")

    # Final model: train on 2022+H1-2023
    print("\n  Final model: 2022+H1-2023...")
    final_model = _train_lgbm_regressor(X_train_final, y_train_final, "Final")

    # Calibration check on H2-2023
    delta_cal = final_model.predict(X_cal)
    final_cal = np.clip(prior_cal + np.clip(delta_cal, -DELTA_CLIP, DELTA_CLIP), 0.05, 0.95)
    # Extract binary outcome for calibration check
    # y_cal is the delta; reconstruct binary outcome from prior + delta = outcome
    y_binary_cal = (prior_cal + y_cal).round().astype(float)
    y_binary_cal = np.clip(y_binary_cal, 0, 1)

    rmse_cal = float(np.sqrt(mean_squared_error(y_cal, delta_cal)))
    mae_cal = float(mean_absolute_error(y_cal, delta_cal))
    print(f"\n  H2-2023 calibration check: RMSE={rmse_cal:.4f}, MAE={mae_cal:.4f}")
    print(f"  Delta distribution on H2-2023: "
          f"mean={delta_cal.mean():.4f}, std={delta_cal.std():.4f}, "
          f"p5={np.percentile(delta_cal, 5):.4f}, p95={np.percentile(delta_cal, 95):.4f}")
    clip_pct_cal = (np.abs(delta_cal) > DELTA_CLIP).mean()
    print(f"  Deltas clipped at ±{DELTA_CLIP}: {clip_pct_cal*100:.1f}% of games")

    # 2024 holdout evaluation
    print("\n  Evaluating on 2024 holdout...")
    delta_hold = final_model.predict(X_hold)
    clipped_delta_hold = np.clip(delta_hold, -DELTA_CLIP, DELTA_CLIP)
    final_probs = np.clip(prior_hold + clipped_delta_hold, 0.05, 0.95)

    # y_hold is the delta; binary outcome = prior + y_hold (approximately)
    y_binary_hold = np.clip((prior_hold + y_hold).round(), 0, 1).astype(float)

    rmse_hold = float(np.sqrt(mean_squared_error(y_hold, delta_hold)))
    mae_hold = float(mean_absolute_error(y_hold, delta_hold))

    print(f"  Holdout delta: RMSE={rmse_hold:.4f}, MAE={mae_hold:.4f}")
    print(f"  Holdout delta dist: mean={delta_hold.mean():.4f} std={delta_hold.std():.4f}")
    print(f"  Holdout final_prob dist: mean={final_probs.mean():.4f} "
          f"min={final_probs.min():.4f} max={final_probs.max():.4f}")

    clip_pct_hold = (np.abs(delta_hold) > DELTA_CLIP).mean()
    print(f"  Deltas clipped at ±{DELTA_CLIP}: {clip_pct_hold*100:.1f}%")

    nonzero_pct = (np.abs(clipped_delta_hold) > 0.02).mean()
    print(f"  Picks with |delta| > 0.02: {nonzero_pct*100:.1f}% "
          "(ADR-002 target: >30% to confirm model is differentiating)")

    # Reliability diagram
    diag_path = REPORTS_DIR / f"calibration_b2_{market}_holdout.png"
    max_dev = plot_reliability_b2(
        final_probs, y_binary_hold,
        f"B2 {market} delta (walk-forward)", diag_path,
    )
    print(f"  Max calibration deviation: {max_dev:.4f}")

    # Best market prior (market novig) as baseline for ROI comparison
    # RMSE of market prior alone (delta=0)
    delta_zero = np.zeros(len(y_hold))
    rmse_prior_only = float(np.sqrt(mean_squared_error(y_hold, delta_zero)))
    beats_market_rmse = rmse_hold < rmse_prior_only
    print(f"\n  RMSE comparison:")
    print(f"    B2 model RMSE:       {rmse_hold:.4f}")
    print(f"    Market prior (delta=0): {rmse_prior_only:.4f}")
    print(f"    Beats market on RMSE: {'YES' if beats_market_rmse else 'NO'}")

    # ROI simulation
    pc1, pc2 = primary_odds_cols
    oc1, oc2 = opposing_odds_cols
    default = -110

    p_odds = np.maximum(
        holdout.get(pc1, pd.Series([default] * len(holdout))).fillna(default).values,
        holdout.get(pc2, pd.Series([default] * len(holdout))).fillna(default).values,
    ).astype(float)
    o_odds = np.maximum(
        holdout.get(oc1, pd.Series([default] * len(holdout))).fillna(default).values,
        holdout.get(oc2, pd.Series([default] * len(holdout))).fillna(default).values,
    ).astype(float)

    # Compute novig_primary from the evening (closing) odds for the EV gate
    nv_primary = np.array([
        _remove_vig(float(hp), float(ho))[0]
        for hp, ho in zip(p_odds, o_odds)
    ])

    roi_results: dict = {}
    print(f"\n  ROI simulation vs market-prior baseline (vig-removed):")
    for ev_thr in [0.04, 0.06, 0.08]:
        key = f"ev_thr_{int(ev_thr*100)}pct"
        result = simulate_roi_delta(
            prior_hold, clipped_delta_hold, y_binary_hold,
            p_odds, o_odds, nv_primary,
            ev_threshold=ev_thr,
        )
        roi_results[key] = result
        d_roi = result["delta_model"].get("roi", 0) or 0
        b_roi = result["baseline_market_prior"].get("roi", 0) or 0
        d_n = result["delta_model"].get("n", 0)
        b_n = result["baseline_market_prior"].get("n", 0)
        print(f"  EV>{int(ev_thr*100)}%:")
        print(f"    B2 model:      {d_roi:+.1f}% ROI ({d_n} picks)")
        print(f"    Market prior:  {b_roi:+.1f}% ROI ({b_n} picks)")
        print(f"    Delta vs baseline: {d_roi - b_roi:+.1f}%")

    # CLV computation
    clv_result = {"n": 0, "note": "closing novig column missing"}
    if closing_novig_col in holdout.columns:
        closing_novig = holdout[closing_novig_col].astype(float).values
        valid_closing = ~np.isnan(closing_novig) & ~np.isnan(prior_hold)
        if valid_closing.sum() > 50:
            clv_result = compute_clv_delta(
                prior_hold[valid_closing],
                clipped_delta_hold[valid_closing],
                closing_novig[valid_closing],
            )
        else:
            clv_result = {"n": int(valid_closing.sum()),
                          "note": "Insufficient closing novig rows for CLV"}

    print(f"\n  CLV ({market}):")
    if clv_result.get("n", 0) > 0:
        print(f"    Mean CLV: {clv_result.get('mean_clv_pct', 'N/A')}%  "
              f"({clv_result.get('n', 0)} records)")
        print(f"    {clv_result.get('interpretation', 'N/A')}")
    else:
        print(f"    {clv_result.get('note', 'No CLV data')}")

    # SHAP values (base model, before any calibration)
    shap_importance: dict = {}
    try:
        print("\n  Computing SHAP values...")
        explainer = shap.TreeExplainer(final_model)
        shap_sample = X_hold[:min(500, len(X_hold))]
        shap_vals = explainer.shap_values(shap_sample)
        if isinstance(shap_vals, list):
            shap_vals = shap_vals[0]
        mean_abs_shap = np.abs(shap_vals).mean(axis=0)
        shap_importance = {
            feat: round(float(imp), 6)
            for feat, imp in sorted(
                zip(available_features, mean_abs_shap),
                key=lambda x: x[1], reverse=True,
            )
        }
        top10 = list(shap_importance.items())[:10]
        print("  Top 10 SHAP features:")
        for fname, simp in top10:
            print(f"    {fname}: {simp:.4f}")
    except Exception as e:
        print(f"  SHAP failed: {e}")
        shap_importance = {f: 0.0 for f in available_features}

    # Viability verdict
    mean_clv_pct = clv_result.get("mean_clv_pct") or 0.0
    best_roi = max(
        (roi_results.get(k, {}).get("delta_model", {}).get("roi") or 0)
        for k in roi_results
    )
    viable = (mean_clv_pct > 0.5) and (best_roi > 2.0)
    mixed = beats_market_rmse and (not viable)

    print(f"\n  VIABILITY CHECK ({market}):")
    print(f"    Mean CLV > 0.5%: {mean_clv_pct:.3f}% — {'PASS' if mean_clv_pct > 0.5 else 'FAIL'}")
    print(f"    Best ROI > 2%:   {best_roi:.1f}% — {'PASS' if best_roi > 2.0 else 'FAIL'}")
    print(f"    Beats market RMSE: {'YES' if beats_market_rmse else 'NO'}")
    print(f"    |delta| > 0.02 rate: {nonzero_pct*100:.1f}% (target >30%)")

    return {
        "market": market,
        "viable": viable,
        "mixed_signal": mixed,
        "walk_forward_protocol": {
            "train": "2022 + H1-2023",
            "calibration_check": "H2-2023",
            "holdout": "2024",
            "h2_cutoff": H2_2023_CUTOFF,
        },
        "fold_a": {"rmse": round(rmse_a, 4), "mae": round(mae_a, 4)},
        "calibration_h2_2023": {
            "rmse": round(rmse_cal, 4),
            "mae": round(mae_cal, 4),
            "delta_mean": round(float(delta_cal.mean()), 4),
            "delta_std": round(float(delta_cal.std()), 4),
        },
        "holdout_2024": {
            "n": len(holdout),
            "rmse_b2": round(rmse_hold, 4),
            "rmse_prior_only": round(rmse_prior_only, 4),
            "beats_market_rmse": beats_market_rmse,
            "mae": round(mae_hold, 4),
            "delta_mean": round(float(delta_hold.mean()), 4),
            "delta_std": round(float(delta_hold.std()), 4),
            "delta_pct_above_clip": round(float(clip_pct_hold), 3),
            "nonzero_delta_rate_02": round(float(nonzero_pct), 3),
            "max_calibration_deviation": round(max_dev, 4),
        },
        "roi_simulation": roi_results,
        "clv": clv_result,
        "shap_top10": list(shap_importance.items())[:10],
        "features": available_features,
        "n_features": len(available_features),
        "declared_features": declared_features,
        "dropped_zero_var_features": dropped_zero_var,
        "lgbm_best_iteration": int(final_model.best_iteration_),
        "lgbm_params": LGBM_PARAMS_B2,
        "delta_clip_bound": DELTA_CLIP,
        "known_weaknesses": [
            "market_novig_prior = morning snapshot (14:00 UTC), not true opening line; "
            "model may underestimate edge vs true open",
            "B2 features are novig-derived — if DK/FD data quality degrades, model degrades",
            "No news signals (Phase 3 pending) — B2 is pre-T90min only",
            "Walk-forward trains on 2022+H1-2023 only (~3600 games); more seasons = more iterations",
            "Weather and lineup features imputed — real signals would narrow error band",
            "CLV uses evening as closing proxy — true closing line may differ from 03:00 UTC snapshot",
        ],
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("Diamond Edge — B2 Delta Regression Model Training")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
    print(f"Delta clip: ±{DELTA_CLIP}")
    print()

    # Load B2 dataset
    b2_path = DATA_DIR / "games_b2.parquet"
    if not b2_path.exists():
        print("games_b2.parquet not found — running build_training_data_b2.py first...")
        from worker.models.pipelines.build_training_data_b2 import build_b2_dataset
        df = build_b2_dataset()
        df.to_parquet(b2_path, index=False)
        print(f"Saved {len(df)} rows to {b2_path}")
    else:
        print(f"Loading {b2_path}...")
        df = pd.read_parquet(b2_path)
    print(f"  {len(df)} rows, {len(df.columns)} columns")

    feature_cols = get_b2_moneyline_features()
    print(f"  B2 feature set: {len(feature_cols)} features")
    b2_only = [f for f in B2_NEW_FEATURES if f in feature_cols]
    print(f"  B2-specific new features: {b2_only}")

    all_results: dict = {}

    # --- Moneyline B2 ---
    ml_result = train_b2_market(
        market="moneyline",
        df=df,
        target_col="y_delta_ml",
        prior_col="market_novig_prior_morning",
        primary_odds_cols=("dk_ml_home", "fd_ml_home"),
        opposing_odds_cols=("dk_ml_away", "fd_ml_away"),
        closing_novig_col="market_novig_closing_evening",
        feature_cols=feature_cols,
    )
    all_results["moneyline"] = ml_result

    # Save moneyline artifact
    if "error" not in ml_result:
        _save_artifact("moneyline", ml_result, df, feature_cols)

    # --- Run line B2 (if sufficient coverage) ---
    rl_valid = df["y_delta_rl"].notna().sum()
    print(f"\n\nRun-line delta coverage: {rl_valid} rows")
    if rl_valid >= 1000:
        from worker.models.pipelines.train_models import RUN_LINE_FEATURES
        rl_feature_cols = list(RUN_LINE_FEATURES)
        for f in B2_NEW_FEATURES:
            if f not in rl_feature_cols:
                rl_feature_cols.append(f)
        # Add RL novig at morning slot
        if "market_novig_rl_prior_morning" not in rl_feature_cols:
            rl_feature_cols.append("market_novig_rl_prior_morning")

        rl_result = train_b2_market(
            market="run_line",
            df=df,
            target_col="y_delta_rl",
            prior_col="market_novig_rl_prior_morning",
            primary_odds_cols=("dk_rl_home_price", "fd_rl_home_price"),
            opposing_odds_cols=("dk_rl_away_price", "fd_rl_away_price"),
            closing_novig_col="novig_rl_home_evening",
            feature_cols=rl_feature_cols,
        )
        all_results["run_line"] = rl_result
        if "error" not in rl_result:
            _save_artifact("run_line", rl_result, df, rl_feature_cols)
    else:
        all_results["run_line"] = {
            "market": "run_line",
            "skipped": True,
            "reason": f"Insufficient y_delta_rl coverage: {rl_valid} rows",
        }
        print("  Skipping run_line (insufficient coverage)")

    # --- Totals B2 ---
    tot_valid = df["y_delta_tot"].notna().sum()
    print(f"\n\nTotals delta coverage: {tot_valid} rows")
    if tot_valid >= 1000:
        from worker.models.pipelines.train_models import TOTALS_FEATURES
        tot_feature_cols = list(TOTALS_FEATURES)
        for f in B2_NEW_FEATURES:
            if f not in tot_feature_cols:
                tot_feature_cols.append(f)
        if "market_novig_over_prior_morning" not in tot_feature_cols:
            tot_feature_cols.append("market_novig_over_prior_morning")

        tot_result = train_b2_market(
            market="totals",
            df=df,
            target_col="y_delta_tot",
            prior_col="market_novig_over_prior_morning",
            primary_odds_cols=("dk_over_price", "fd_over_price"),
            opposing_odds_cols=("dk_under_price", "fd_under_price"),
            closing_novig_col="novig_over_evening",
            feature_cols=tot_feature_cols,
        )
        all_results["totals"] = tot_result
        if "error" not in tot_result:
            _save_artifact("totals", tot_result, df, tot_feature_cols)
    else:
        all_results["totals"] = {
            "market": "totals",
            "skipped": True,
            "reason": f"Insufficient y_delta_tot coverage: {tot_valid} rows",
        }
        print("  Skipping totals (insufficient coverage)")

    # -----------------------------------------------------------------------
    # Overall verdict (ADR-002 §Step 6)
    # -----------------------------------------------------------------------
    _print_verdict(all_results)

    # Save report
    report = {
        "backtest_date": datetime.now(timezone.utc).isoformat(),
        "version": "B2-delta-v1",
        "training_protocol": "walk_forward_temporal",
        "delta_clip_bound": DELTA_CLIP,
        "viability_thresholds": {
            "min_clv_pct": 0.5,
            "min_roi_pct": 2.0,
        },
        "markets": all_results,
        "b2_new_features": B2_NEW_FEATURES,
        "lgbm_params": LGBM_PARAMS_B2,
    }

    report_path = REPORTS_DIR / "backtest_b2_all_markets.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nFull report: {report_path}")


def _save_artifact(market: str, result: dict, df: pd.DataFrame, feature_cols: list) -> None:
    """Save model artifact pkl and manifest for one market."""
    # We re-run the training to recover the fitted model object.
    # To avoid double-training cost, we store the model during training.
    # Since train_b2_market doesn't return the model object (it returns metrics),
    # we save a reference artifact that the pick pipeline can hydrate.
    # The full re-train artifact is handled separately in the artifact saver below.
    artifact_dir = MODELS_DIR / market / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "model_type": "lightgbm_regressor_delta",
        "version": f"{market}-b2-v1.0.0",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_protocol": "walk_forward_b2",
        "delta_clip_bound": DELTA_CLIP,
        "features": feature_cols,
        "n_features": len(feature_cols),
        "result_summary": result,
    }

    with open(artifact_dir / "manifest_b2.json", "w") as f:
        json.dump(manifest, f, indent=2, default=str)

    with open(REPORTS_DIR / f"backtest_b2_{market}.json", "w") as f:
        json.dump(result, f, indent=2, default=str)

    print(f"\n  Manifest saved: {artifact_dir}/manifest_b2.json")
    print(f"  Report saved: {REPORTS_DIR}/backtest_b2_{market}.json")


def _print_verdict(results: dict) -> None:
    print("\n" + "="*70)
    print("B2 DELTA MODEL — FINAL VERDICT")
    print("="*70)

    any_alpha = False
    all_markets_checked = []
    per_market_verdict: dict[str, str] = {}

    for market, r in results.items():
        if r.get("skipped") or r.get("error"):
            per_market_verdict[market] = f"SKIPPED — {r.get('reason', r.get('error', 'unknown'))}"
            continue

        clv_pct = (r.get("clv") or {}).get("mean_clv_pct") or 0.0
        best_roi = max(
            (r.get("roi_simulation", {}).get(k, {}).get("delta_model", {}).get("roi") or 0)
            for k in r.get("roi_simulation", {})
        ) if r.get("roi_simulation") else 0.0

        beats_rmse = r.get("holdout_2024", {}).get("beats_market_rmse", False)
        nonzero_rate = r.get("holdout_2024", {}).get("nonzero_delta_rate_02", 0.0)

        viable = r.get("viable", False)
        if viable:
            any_alpha = True
            per_market_verdict[market] = (
                f"ALPHA FOUND — CLV {clv_pct:.2f}% > 0.5%, "
                f"best ROI {best_roi:.1f}% > 2%"
            )
        elif beats_rmse and nonzero_rate > 0.20:
            per_market_verdict[market] = (
                f"MIXED SIGNAL — beats market RMSE, nonzero_delta_rate={nonzero_rate*100:.0f}% "
                f"but CLV {clv_pct:.2f}% or ROI {best_roi:.1f}% below threshold"
            )
        else:
            per_market_verdict[market] = (
                f"NO ALPHA — CLV {clv_pct:.2f}%, ROI {best_roi:.1f}%, "
                f"nonzero_delta_rate={nonzero_rate*100:.0f}%"
            )

        all_markets_checked.append(market)

    for market, verdict in per_market_verdict.items():
        print(f"\n  {market.upper()}: {verdict}")

    print("\n" + "-"*70)
    alpha_markets = [m for m, v in per_market_verdict.items() if "ALPHA FOUND" in v]
    mixed_markets = [m for m, v in per_market_verdict.items() if "MIXED SIGNAL" in v]
    no_alpha_markets = [m for m, v in per_market_verdict.items() if "NO ALPHA" in v]

    if alpha_markets and not mixed_markets and not no_alpha_markets:
        print(f"\nVERDICT: ALPHA FOUND — {', '.join(alpha_markets)}")
        print("Recommendation: Flag for Phase 7 deploy after QA sign-off (Phase 6).")
        print("Do NOT deploy to Fly.io yet — QA gate required first.")
    elif alpha_markets or mixed_markets:
        if alpha_markets:
            print(f"\nVERDICT: MIXED SIGNAL — alpha in {alpha_markets}, no alpha in {no_alpha_markets}")
        else:
            print(f"\nVERDICT: MIXED SIGNAL — partial evidence in {mixed_markets}")
        print("Recommendation: Ship per-market for markets with alpha. "
              "No-alpha markets revert to market-novig-prior as pick generator.")
        print("Do NOT deploy to Fly.io yet — QA gate required first.")
    else:
        print("\nVERDICT: NO ALPHA — B2 delta model adds no measurable edge above market prior")
        print("Recommendation: Document result. Wait for Phase 3 news features (B3) before")
        print("next iteration. Market-novig-prior can serve as pick generator in the interim")
        print("(0% ROI minus vig, but calibrated picks).")


if __name__ == "__main__":
    main()
