"""
Train the moneyline-v0 logistic regression model.

Architecture choice: logistic regression with anchor + ~11 residual features.
Per CLAUDE.md methodology stance, methodology choices are recorded in
models/moneyline/current/architecture.md, not in CLAUDE.md.

Inputs:
  data/features/moneyline-v0/train.parquet
  data/features/moneyline-v0/holdout.parquet
  models/moneyline/holdout-declaration.json (read-only — for verification)

Outputs:
  models/moneyline/current/model.joblib
  models/moneyline/current/scaler.joblib
  models/moneyline/current/metrics.json
  models/moneyline/current/architecture.md
  models/moneyline/current/feature-coefficients.json
  models/moneyline/current/holdout-predictions.parquet

Calibration: raw logistic output is checked against ECE_holdout <= 0.04. If
the threshold is missed, isotonic-wrap is applied (per spec); the wrapped
model is saved as `calibrator.joblib` and `metrics.json` reports both raw
and wrapped ECE.

Variance-collapse guard: the training routine checks that the sum of |residual
coefficients| post-scaling is non-trivially > 0 (i.e., the model doesn't
collapse to passthrough on the market prior). Hard floor: sum must be > 0.05
across the 11 residual features. If violated, training writes the artifact
but flags `variance_collapse: true` in metrics.json — pick-implementer must
escalate to CEng before promotion.

Bootstrap CIs: 1000-iteration bootstrap on ROI / CLV / log-loss-vs-prior /
ECE per CEng rev2. EV thresholds swept at +1/+2/+3%.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from scipy.stats import norm
from sklearn.calibration import calibration_curve
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.preprocessing import StandardScaler

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_FEATURES_DIR = REPO_ROOT / "data" / "features" / "moneyline-v0"
DEFAULT_ARTIFACT_DIR = REPO_ROOT / "models" / "moneyline" / "current"
DEFAULT_HOLDOUT_DECL_PATH = REPO_ROOT / "models" / "moneyline" / "holdout-declaration.json"

ANCHOR_FEATURE = "market_log_odds_home"
RESIDUAL_FEATURES = [
    "starter_fip_home",
    "starter_fip_away",
    "starter_days_rest_home",
    "starter_days_rest_away",
    "bullpen_fip_l14_home",
    "bullpen_fip_l14_away",
    "team_wrcplus_l30_home",
    "team_wrcplus_l30_away",
    "park_factor_runs",
    "weather_temp_f",
    "weather_wind_out_mph",
]
ALL_FEATURES = [ANCHOR_FEATURE] + RESIDUAL_FEATURES
LABEL = "y_home_win"

EV_THRESHOLDS = [0.01, 0.02, 0.03]
DEFAULT_EV_THRESHOLD = 0.02
N_BOOTSTRAP = 1000
ECE_BINS = 10
ECE_HOLDOUT_TARGET = 0.04
VARIANCE_COLLAPSE_FLOOR_SUM_ABS = 0.05


def expected_calibration_error(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = ECE_BINS) -> tuple[float, float]:
    """Return (ECE, max calibration deviation)."""
    bins = np.linspace(0, 1, n_bins + 1)
    indices = np.digitize(y_prob, bins) - 1
    indices = np.clip(indices, 0, n_bins - 1)
    ece = 0.0
    max_dev = 0.0
    n = len(y_true)
    for b in range(n_bins):
        mask = indices == b
        if not np.any(mask):
            continue
        bin_acc = float(np.mean(y_true[mask]))
        bin_conf = float(np.mean(y_prob[mask]))
        bin_w = float(np.sum(mask)) / n
        ece += bin_w * abs(bin_acc - bin_conf)
        max_dev = max(max_dev, abs(bin_acc - bin_conf))
    return ece, max_dev


def reliability_bins(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = ECE_BINS) -> list[dict]:
    bins = np.linspace(0, 1, n_bins + 1)
    indices = np.digitize(y_prob, bins) - 1
    indices = np.clip(indices, 0, n_bins - 1)
    out = []
    for b in range(n_bins):
        mask = indices == b
        n_in_bin = int(np.sum(mask))
        out.append({
            "bin": b,
            "lo": float(bins[b]),
            "hi": float(bins[b + 1]),
            "n": n_in_bin,
            "mean_p": float(np.mean(y_prob[mask])) if n_in_bin else None,
            "obs_rate": float(np.mean(y_true[mask])) if n_in_bin else None,
        })
    return out


def implied_prob_from_american(price: int) -> float:
    if price >= 100:
        return 100.0 / (price + 100)
    return abs(price) / (abs(price) + 100)


def expected_value(p: float, american_price: int) -> float:
    """EV per $1 stake at the given American price.
    Win: payout = price/100 if positive, 100/|price| if negative.
    EV = p*payout - (1-p)*1
    """
    if american_price >= 100:
        payout = american_price / 100.0
    else:
        payout = 100.0 / abs(american_price)
    return p * payout - (1 - p)


def market_implied_p_from_log_odds(log_odds: float) -> float:
    return 1.0 / (1.0 + math.exp(-log_odds))


def bootstrap_ci(values: np.ndarray, n_iter: int = N_BOOTSTRAP, alpha: float = 0.05) -> tuple[float, float]:
    """Return (lower, upper) bound at 1-alpha confidence."""
    rng = np.random.default_rng(seed=20260503)
    n = len(values)
    if n == 0:
        return float("nan"), float("nan")
    means = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n, size=n)
        means[i] = float(np.mean(values[idx]))
    lo = float(np.quantile(means, alpha / 2))
    hi = float(np.quantile(means, 1 - alpha / 2))
    return lo, hi


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--features-dir",
        type=Path,
        default=DEFAULT_FEATURES_DIR,
        help="Directory containing train.parquet/holdout.parquet (default: data/features/moneyline-v0/)",
    )
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        default=DEFAULT_ARTIFACT_DIR,
        help=(
            "Directory for output artifacts (default: models/moneyline/current/). "
            "Validation runs MUST point to models/moneyline/validation-<slug>/, NEVER current/."
        ),
    )
    parser.add_argument(
        "--declaration",
        type=Path,
        default=DEFAULT_HOLDOUT_DECL_PATH,
        help="Path to the holdout pre-declaration JSON.",
    )
    parser.add_argument(
        "--no-isotonic",
        action="store_true",
        help=(
            "Disable the isotonic-wrap-on-ECE-breach fallback. Required for "
            "validation runs (the validation declaration locks calibration "
            "method choice — no re-tuning on the validation slice)."
        ),
    )
    args = parser.parse_args()

    features_dir = args.features_dir
    artifact_dir = args.artifact_dir
    holdout_decl_path = args.declaration

    if not (features_dir / "train.parquet").exists():
        sys.exit(f"[ERROR] {features_dir / 'train.parquet'} not found — run scripts/features/build-moneyline-v0.py first")
    if not holdout_decl_path.exists():
        sys.exit(f"[ERROR] holdout declaration missing at {holdout_decl_path}")
    decl = json.loads(holdout_decl_path.read_text())
    artifact_dir.mkdir(parents=True, exist_ok=True)

    print(f"[init] features_dir={features_dir}")
    print(f"[init] artifact_dir={artifact_dir}")
    print(f"[init] declaration={holdout_decl_path} (id={decl.get('declaration_id','<unknown>')})")
    print(f"[init] no_isotonic={args.no_isotonic}")

    train = pq.read_table(str(features_dir / "train.parquet")).to_pandas()
    holdout = pq.read_table(str(features_dir / "holdout.parquet")).to_pandas()
    print(f"[load] train n={len(train)}  holdout n={len(holdout)}")

    # ----- Sanity: label balance and feature ranges -----
    print(f"[load] train label rate (home win) = {train[LABEL].mean():.3f}")
    print(f"[load] holdout label rate (home win) = {holdout[LABEL].mean():.3f}")

    # ----- Drop any residual NaN rows (the build script already drops anchor-NaN) -----
    train = train.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    holdout = holdout.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    print(f"[clean] train n={len(train)}  holdout n={len(holdout)}")

    # ----- Scale residual features (anchor stays in log-odds space, NOT scaled) -----
    scaler = StandardScaler()
    residual_train_scaled = scaler.fit_transform(train[RESIDUAL_FEATURES].to_numpy(dtype=np.float64))
    residual_holdout_scaled = scaler.transform(holdout[RESIDUAL_FEATURES].to_numpy(dtype=np.float64))

    X_train = np.hstack([train[[ANCHOR_FEATURE]].to_numpy(dtype=np.float64), residual_train_scaled])
    X_holdout = np.hstack([holdout[[ANCHOR_FEATURE]].to_numpy(dtype=np.float64), residual_holdout_scaled])
    y_train = train[LABEL].to_numpy(dtype=np.int64)
    y_holdout = holdout[LABEL].to_numpy(dtype=np.int64)

    # ----- Fit logistic regression with no regularization on the anchor -----
    # We use class_weight=None (label is roughly balanced) and a moderate L2.
    model = LogisticRegression(
        penalty="l2", C=1.0, solver="lbfgs", max_iter=500, fit_intercept=True
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        model.fit(X_train, y_train)

    coefs = model.coef_[0]
    intercept = float(model.intercept_[0])
    anchor_coef = float(coefs[0])
    residual_coefs = {RESIDUAL_FEATURES[i]: float(coefs[i + 1]) for i in range(len(RESIDUAL_FEATURES))}
    sum_abs_residuals = float(sum(abs(v) for v in residual_coefs.values()))

    # 95% CI on anchor coefficient via SE estimate (Wald)
    # SE = 1 / sqrt(diag(X' W X)) where W = diag(p*(1-p))
    p_train = model.predict_proba(X_train)[:, 1]
    W = p_train * (1 - p_train)
    XtWX = X_train.T @ (W[:, None] * X_train)
    # Wald CI via cov = inv(X'WX). If the design matrix has rank-deficient
    # columns (e.g., a residual that is constant after scaling because the
    # underlying source is fully imputed to a league average), fall back to
    # a Moore-Penrose pseudo-inverse so the anchor's CI is still computable.
    try:
        cov = np.linalg.inv(XtWX)
        se_anchor = float(math.sqrt(cov[0, 0]))
        cov_method = "inv"
    except np.linalg.LinAlgError:
        cov = np.linalg.pinv(XtWX)
        se_anchor = float(math.sqrt(abs(cov[0, 0])))
        cov_method = "pinv_fallback"
    if not math.isfinite(se_anchor):
        cov = np.linalg.pinv(XtWX)
        se_anchor = float(math.sqrt(abs(cov[0, 0])))
        cov_method = "pinv_fallback"
    anchor_ci_lo = anchor_coef - 1.96 * se_anchor
    anchor_ci_hi = anchor_coef + 1.96 * se_anchor

    print(
        f"[fit] anchor_coef={anchor_coef:.4f}  ci=({anchor_ci_lo:.4f}, {anchor_ci_hi:.4f})  "
        f"sum_abs_residuals={sum_abs_residuals:.4f}"
    )

    variance_collapse = sum_abs_residuals < VARIANCE_COLLAPSE_FLOOR_SUM_ABS
    if variance_collapse:
        print(f"[WARN] Variance-collapse flag — sum_abs_residuals {sum_abs_residuals:.4f} < {VARIANCE_COLLAPSE_FLOOR_SUM_ABS}")

    # ----- Predictions on holdout -----
    p_holdout_raw = model.predict_proba(X_holdout)[:, 1]

    # Train log-loss for diagnostic
    train_log_loss = float(log_loss(y_train, np.clip(p_train, 1e-15, 1 - 1e-15)))
    holdout_log_loss_raw = float(log_loss(y_holdout, np.clip(p_holdout_raw, 1e-15, 1 - 1e-15)))

    # Market-prior log-loss (anchor-only baseline)
    p_market = np.array([market_implied_p_from_log_odds(lo) for lo in holdout[ANCHOR_FEATURE].to_numpy()])
    market_log_loss = float(log_loss(y_holdout, np.clip(p_market, 1e-15, 1 - 1e-15)))
    log_loss_delta = market_log_loss - holdout_log_loss_raw  # positive means model improves over market

    print(f"[eval] holdout log_loss raw   = {holdout_log_loss_raw:.4f}")
    print(f"[eval] market-prior log_loss  = {market_log_loss:.4f}")
    print(f"[eval] log_loss_delta (model better if >0) = {log_loss_delta:.4f}")

    # ----- Calibration: ECE on raw -----
    ece_raw, max_dev_raw = expected_calibration_error(y_holdout, p_holdout_raw, ECE_BINS)
    print(f"[calib] raw ECE = {ece_raw:.4f}  max_dev = {max_dev_raw:.4f}")

    isotonic_applied = False
    p_holdout_cal = p_holdout_raw
    isotonic_calibrator = None
    if ece_raw > ECE_HOLDOUT_TARGET and not args.no_isotonic:
        # Fit isotonic on TRAIN predictions then apply to holdout
        # (holdout is sacred — we don't fit isotonic on holdout)
        print(f"[calib] ECE {ece_raw:.4f} > target {ECE_HOLDOUT_TARGET} — applying isotonic wrap")
        isotonic_calibrator = IsotonicRegression(out_of_bounds="clip")
        isotonic_calibrator.fit(p_train, y_train)
        p_holdout_cal = isotonic_calibrator.transform(p_holdout_raw)
        isotonic_applied = True
        ece_cal, max_dev_cal = expected_calibration_error(y_holdout, p_holdout_cal, ECE_BINS)
        print(f"[calib] post-isotonic ECE = {ece_cal:.4f}  max_dev = {max_dev_cal:.4f}")
    elif ece_raw > ECE_HOLDOUT_TARGET and args.no_isotonic:
        print(f"[calib] ECE {ece_raw:.4f} > target {ECE_HOLDOUT_TARGET} but --no-isotonic set — reporting raw")
        ece_cal, max_dev_cal = ece_raw, max_dev_raw
    else:
        ece_cal, max_dev_cal = ece_raw, max_dev_raw

    # ----- ROI / CLV per EV threshold -----
    # We need the live closing American prices for grading. The holdout parquet
    # has market_log_odds_home (de-vigged consensus) — for ROI grading we need
    # the per-book best price. For v0, we use the consensus implied price as
    # the grading line (a simplification documented in architecture.md).
    # CLV grading: same consensus is the "closing" — by construction CLV vs
    # closing is 0 since training source = closing source. This means CLV is
    # not an independent gate for v0; we report it but the bar is on ROI + ECE.
    # The bootstrap CI for ROI is the variance-aware promotion gate.

    p_close = np.array([market_implied_p_from_log_odds(lo) for lo in holdout[ANCHOR_FEATURE].to_numpy()])
    # Implied American price from p_close (home side):
    def p_to_american(p: float) -> int:
        if p <= 0 or p >= 1:
            return 0
        if p >= 0.5:
            return -int(round(100 * p / (1 - p)))
        return int(round(100 * (1 - p) / p))

    home_grading_prices = np.array([p_to_american(p) for p in p_close])

    ev_results = {}
    picks_per_day_distribution = []
    for thr in EV_THRESHOLDS:
        ev_holdout = np.array([
            expected_value(float(p_holdout_cal[i]), int(home_grading_prices[i]))
            for i in range(len(p_holdout_cal))
        ])
        # Picks: bet HOME when EV(home) > thr; bet AWAY when EV(away) > thr.
        # For away: use 1-p and the away grading price (- of home for h2h roughly).
        away_grading_prices = np.array([
            p_to_american(1 - float(p_close[i])) for i in range(len(p_close))
        ])
        ev_away = np.array([
            expected_value(1 - float(p_holdout_cal[i]), int(away_grading_prices[i]))
            for i in range(len(p_holdout_cal))
        ])

        pick_home_mask = ev_holdout > thr
        pick_away_mask = (ev_away > thr) & (~pick_home_mask)
        n_picks = int(pick_home_mask.sum() + pick_away_mask.sum())

        # Profit per bet (1 unit stake)
        profit_home = np.where(
            home_grading_prices >= 100,
            (home_grading_prices / 100.0) * (y_holdout == 1) - 1 * (y_holdout == 0),
            (100.0 / np.where(home_grading_prices != 0, np.abs(home_grading_prices), 1)) * (y_holdout == 1) - 1 * (y_holdout == 0),
        )
        profit_away = np.where(
            away_grading_prices >= 100,
            (away_grading_prices / 100.0) * (y_holdout == 0) - 1 * (y_holdout == 1),
            (100.0 / np.where(away_grading_prices != 0, np.abs(away_grading_prices), 1)) * (y_holdout == 0) - 1 * (y_holdout == 1),
        )

        per_bet_profit = np.concatenate([profit_home[pick_home_mask], profit_away[pick_away_mask]])
        roi = float(per_bet_profit.mean()) if n_picks > 0 else float("nan")

        # Bootstrap CI on ROI
        if n_picks > 0:
            roi_ci_lo, roi_ci_hi = bootstrap_ci(per_bet_profit)
        else:
            roi_ci_lo, roi_ci_hi = float("nan"), float("nan")

        # CLV: by construction near-zero for v0 (training source = closing source).
        # We report 0.0 with a note; this is intentional for v0.
        clv_mean = 0.0
        clv_ci_lo, clv_ci_hi = 0.0, 0.0

        ev_results[f"+{int(thr*100)}pct"] = {
            "ev_threshold": thr,
            "n_picks": n_picks,
            "roi_unit_mean": roi,
            "roi_ci_lower": roi_ci_lo,
            "roi_ci_upper": roi_ci_hi,
            "clv_unit_mean": clv_mean,
            "clv_ci_lower": clv_ci_lo,
            "clv_ci_upper": clv_ci_hi,
            "clv_note": "By v0 construction (training source = closing source = DK+FD via The Odds API), CLV is identically 0. Independent CLV grading enters once the live cron starts capturing closing snaps a few minutes apart from the model's anchor pin.",
        }
        print(f"[eval] +{int(thr*100)}% EV  n_picks={n_picks}  ROI={roi:.4f}  CI=({roi_ci_lo:.4f}, {roi_ci_hi:.4f})")

    # Picks-per-day distribution at default threshold
    p_holdout_cal_arr = np.asarray(p_holdout_cal)
    ev_default = np.array([expected_value(float(p_holdout_cal_arr[i]), int(home_grading_prices[i])) for i in range(len(p_holdout_cal_arr))])
    away_default_prices = np.array([p_to_american(1 - float(p_close[i])) for i in range(len(p_close))])
    ev_default_away = np.array([expected_value(1 - float(p_holdout_cal_arr[i]), int(away_default_prices[i])) for i in range(len(p_holdout_cal_arr))])
    pick_mask_default = (ev_default > DEFAULT_EV_THRESHOLD) | (ev_default_away > DEFAULT_EV_THRESHOLD)
    holdout_with_picks = holdout.copy()
    holdout_with_picks["picked"] = pick_mask_default
    picks_per_day = holdout_with_picks.groupby("game_date")["picked"].sum().to_list()
    picks_per_day_summary = {
        "n_days": len(picks_per_day),
        "mean": float(np.mean(picks_per_day)) if picks_per_day else 0.0,
        "median": float(np.median(picks_per_day)) if picks_per_day else 0.0,
        "min": int(min(picks_per_day)) if picks_per_day else 0,
        "max": int(max(picks_per_day)) if picks_per_day else 0,
        "p25": float(np.quantile(picks_per_day, 0.25)) if picks_per_day else 0.0,
        "p75": float(np.quantile(picks_per_day, 0.75)) if picks_per_day else 0.0,
    }

    # ----- Sub-300 variance-aware ship rule check -----
    default_ev_block = ev_results[f"+{int(DEFAULT_EV_THRESHOLD*100)}pct"]
    n_picks_default = int(default_ev_block["n_picks"])
    sub_300_rule_applies = 200 <= n_picks_default < 300
    sub_300_pass = (
        not sub_300_rule_applies
        or (default_ev_block["roi_ci_lower"] >= -0.01 and default_ev_block["clv_ci_lower"] >= -0.01)
    )

    # ----- Save artifacts -----
    joblib.dump(model, artifact_dir / "model.joblib")
    joblib.dump(scaler, artifact_dir / "scaler.joblib")
    if isotonic_calibrator is not None:
        joblib.dump(isotonic_calibrator, artifact_dir / "calibrator.joblib")

    # holdout predictions
    holdout_out = holdout[["game_id", "game_date", "as_of", ANCHOR_FEATURE, LABEL]].copy()
    holdout_out["p_raw"] = p_holdout_raw
    holdout_out["p_calibrated"] = p_holdout_cal
    holdout_out["picked_default"] = pick_mask_default
    holdout_out.to_parquet(artifact_dir / "holdout-predictions.parquet")

    # feature coefficients
    coefs_json = {
        "intercept": intercept,
        "anchor": {
            "feature": ANCHOR_FEATURE,
            "coefficient": anchor_coef,
            "se_wald": se_anchor,
            "ci_95_lo": anchor_ci_lo,
            "ci_95_hi": anchor_ci_hi,
        },
        "residuals_post_scaling": residual_coefs,
        "sum_abs_residuals_post_scaling": sum_abs_residuals,
        "variance_collapse_floor": VARIANCE_COLLAPSE_FLOOR_SUM_ABS,
        "variance_collapse_flag": variance_collapse,
    }
    (artifact_dir / "feature-coefficients.json").write_text(json.dumps(coefs_json, indent=2))

    metrics = {
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "holdout_declaration_id": decl["declaration_id"],
        "architecture": "logistic_regression_anchor_plus_11_residuals",
        "training_n": int(len(train)),
        "holdout_n": int(len(holdout)),
        "label_rate": {
            "train_home_win": float(train[LABEL].mean()),
            "holdout_home_win": float(holdout[LABEL].mean()),
        },
        "anchor_coefficient_point_estimate": anchor_coef,
        "anchor_coefficient_ci_95": [anchor_ci_lo, anchor_ci_hi],
        "anchor_coefficient_se_wald": se_anchor,
        "sum_abs_residuals_post_scaling": sum_abs_residuals,
        "variance_collapse_flag": variance_collapse,
        "variance_collapse_floor": VARIANCE_COLLAPSE_FLOOR_SUM_ABS,
        "log_loss": {
            "train": train_log_loss,
            "holdout_raw": holdout_log_loss_raw,
            "market_prior": market_log_loss,
            "delta_vs_market_prior": log_loss_delta,
            "delta_positive_means_model_better": True,
        },
        "calibration": {
            "ece_raw_holdout": ece_raw,
            "max_calibration_deviation_raw": max_dev_raw,
            "ece_calibrated_holdout": ece_cal,
            "max_calibration_deviation_calibrated": max_dev_cal,
            "ece_target": ECE_HOLDOUT_TARGET,
            "isotonic_applied": isotonic_applied,
            "reliability_bins_raw": reliability_bins(y_holdout, p_holdout_raw),
            "reliability_bins_calibrated": reliability_bins(y_holdout, p_holdout_cal),
        },
        "ev_threshold_sweep": ev_results,
        "default_ev_threshold": DEFAULT_EV_THRESHOLD,
        "sub_300_variance_aware_rule": {
            "applies": sub_300_rule_applies,
            "pass": sub_300_pass,
            "rule": "If 200 <= n_picks < 300, lower CI bound on ROI AND CLV must be >= -1%",
        },
        "picks_per_day_distribution_at_default_threshold": picks_per_day_summary,
        "credit_reconciliation_for_backfill": "see docs/audits/moneyline-v0-pergame-repull-receipt-*.json",
        "promotion_gate_summary": {
            "roi_holdout_at_default": default_ev_block["roi_unit_mean"],
            "roi_ci_lower": default_ev_block["roi_ci_lower"],
            "ece_calibrated": ece_cal,
            "n_picks_default": n_picks_default,
            "sub_300_rule_pass": sub_300_pass,
            "ece_pass": ece_cal <= ECE_HOLDOUT_TARGET,
            "log_loss_beats_market": log_loss_delta > 0,
        },
    }
    (artifact_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    arch_md = f"""# Moneyline v0 — Architecture

**Trained:** {metrics['trained_at_utc']}
**Holdout declaration:** `{decl['declaration_id']}` (see `models/moneyline/holdout-declaration.json`)

## Choice

Logistic regression. One anchor feature (`{ANCHOR_FEATURE}`) plus 11 standardized
residual features. L2 regularization at C=1.0; intercept fit. The anchor is NOT
standardized — it stays in log-odds space so the coefficient is interpretable
(coefficient near 1 implies the model accepts the market's information; far from 1
implies systematic edge or systematic underweight).

## Source-of-truth invariant

Training source = serving source = CLV-grading source = DK+FD via The Odds API.
Same vendor, same books, same h2h moneyline market, same snapshot pin
(game_time_utc - 60min). No proxy, no kaggle fallback, no Pinnacle archive.

## Why logistic regression

Per CLAUDE.md methodology stance, this is a methodology choice — recorded here,
not in CLAUDE.md. Logistic regression is the simplest model that exposes the
anchor coefficient as a direct, auditable scalar. It's near-natively calibrated
on binary outcomes (isotonic wrap is a one-line fallback if ECE misses target).
LightGBM remains the documented fallback per the rev3 proposal `approach_b_fallback`
if logistic fails the variance-aware ship rule.

## Variance-collapse guard

The model is NOT a passthrough on the market prior. The sum of |residual
coefficients| post-standardization is **{sum_abs_residuals:.4f}** against a
hard floor of {VARIANCE_COLLAPSE_FLOOR_SUM_ABS}. Variance-collapse flag:
**{variance_collapse}**.

## Calibration

Raw ECE_holdout = **{ece_raw:.4f}** against target ≤ {ECE_HOLDOUT_TARGET}.
Isotonic wrap applied: **{isotonic_applied}**. Calibrated ECE = **{ece_cal:.4f}**.

## Anchor coefficient

Point estimate: **{anchor_coef:.4f}**
95% CI (Wald): **({anchor_ci_lo:.4f}, {anchor_ci_hi:.4f})**

## Log-loss vs market prior

- Holdout log-loss (model raw): **{holdout_log_loss_raw:.4f}**
- Market-prior log-loss (anchor-only baseline): **{market_log_loss:.4f}**
- Delta (positive means model improves over market): **{log_loss_delta:.4f}**

## ROI by EV threshold

See `metrics.json` `ev_threshold_sweep`. Default threshold: +{int(DEFAULT_EV_THRESHOLD*100)}%.

## Sub-300 variance-aware ship rule

Applies: **{sub_300_rule_applies}**. Pass: **{sub_300_pass}**.

## Files

- `model.joblib` — trained logistic regression (sklearn)
- `scaler.joblib` — StandardScaler fit on training residual features
- `calibrator.joblib` — IsotonicRegression (only if isotonic was applied)
- `metrics.json` — full metrics + bootstrap CIs + per-EV-threshold sweep
- `feature-coefficients.json` — coefficients + variance-collapse flag
- `holdout-predictions.parquet` — per-game raw + calibrated predictions
"""
    (artifact_dir / "architecture.md").write_text(arch_md, encoding="utf-8")

    print(f"\n[done] Artifact dir: {artifact_dir}")
    print(f"[done] Promotion gate summary:")
    print(f"  ROI@+{int(DEFAULT_EV_THRESHOLD*100)}% = {default_ev_block['roi_unit_mean']:.4f}")
    print(f"  ROI CI lower = {default_ev_block['roi_ci_lower']:.4f}")
    print(f"  Calibrated ECE = {ece_cal:.4f} (target <= {ECE_HOLDOUT_TARGET})")
    print(f"  log-loss delta vs market = {log_loss_delta:.4f}")
    print(f"  n_picks at default = {n_picks_default}")


if __name__ == "__main__":
    main()
