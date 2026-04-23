"""
run_roi_backtest.py — Rerun ROI simulation using existing model artifacts.

Loads the pickled LightGBM+calibrator artifacts from training, re-scores the
2024 holdout split, and runs the corrected bidirectional simulate_roi (which
evaluates both home/primary and away/opposing sides per game instead of
home-only).

Does NOT retrain any model. Safe to run after the home-side EV bias fix.

Usage:
    python worker/models/backtest/run_roi_backtest.py
"""
from __future__ import annotations

import json
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT))

from worker.models.pipelines.train_models import (
    simulate_roi,
    compute_ev,
    assign_confidence_tier,
    MARKET_CONFIG,
    load_and_build_features,
)

MODELS_DIR = ROOT / "worker" / "models"
REPORTS_DIR = MODELS_DIR / "backtest" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

PRIMARY_ODDS_COLS = {
    "moneyline": ("dk_ml_home", "fd_ml_home"),
    "run_line": ("dk_rl_home_price", "fd_rl_home_price"),
    "totals": ("dk_over_price", "fd_over_price"),
}
OPPOSING_ODDS_COLS = {
    "moneyline": ("dk_ml_away", "fd_ml_away"),
    "run_line": ("dk_rl_away_price", "fd_rl_away_price"),
    "totals": ("dk_under_price", "fd_under_price"),
}


def get_best_odds(df: pd.DataFrame, cols: tuple[str, str],
                  default: int = -110) -> np.ndarray:
    c1, c2 = cols
    v1 = df.get(c1, pd.Series([default] * len(df))).fillna(default).values
    v2 = df.get(c2, pd.Series([default] * len(df))).fillna(default).values
    return np.maximum(v1, v2)


def load_model(market: str) -> dict:
    pkl_path = MODELS_DIR / market / "artifacts" / "model.pkl"
    with open(pkl_path, "rb") as f:
        return pickle.load(f)


def load_manifest(market: str) -> dict:
    p = MODELS_DIR / market / "artifacts" / "manifest.json"
    with open(p) as f:
        return json.load(f)


def run_backtest_for_market(market: str, df: pd.DataFrame) -> dict:
    print(f"\n--- {market.upper()} ---")
    cfg = MARKET_CONFIG[market]
    target_col = cfg["target"]
    feature_cols = cfg["features"]

    artifact = load_model(market)
    lgbm_model = artifact["model"]
    calibrator = artifact["calibrator"]
    available_features = artifact["features"]

    manifest = load_manifest(market)

    # Reconstruct 2024 holdout split (same logic as train_market)
    valid = df.dropna(subset=[target_col]).copy()
    valid["season_dt"] = pd.to_datetime(valid["game_date"]).dt.year
    holdout = valid[valid["season_dt"] == 2024].copy()

    if market == "totals":
        holdout = holdout[holdout[target_col] != 0.5].copy()

    print(f"  Holdout rows: {len(holdout)}")

    # Impute any missing features
    for f in available_features:
        if f not in holdout.columns:
            holdout[f] = 0.0

    X_hold = holdout[available_features].fillna(0).values
    y_hold = holdout[target_col].astype(float).values

    # Score with existing model
    raw_hold = lgbm_model.predict_proba(X_hold)[:, 1]
    cal_hold = calibrator.predict(raw_hold)

    # Odds for both sides
    primary_odds = get_best_odds(holdout, PRIMARY_ODDS_COLS[market])
    opposing_odds = get_best_odds(holdout, OPPOSING_ODDS_COLS[market])

    # Corrected ROI simulation (bidirectional)
    roi_stats = {}
    for ev_thr in [0.02, 0.04, 0.06]:
        roi_stats[f"ev_thr_{int(ev_thr*100)}pct"] = simulate_roi(
            cal_hold, y_hold, primary_odds,
            ev_threshold=ev_thr,
            opposing_odds=opposing_odds,
        )
        n = roi_stats[f"ev_thr_{int(ev_thr*100)}pct"]["flat"]["n"]
        roi = roi_stats[f"ev_thr_{int(ev_thr*100)}pct"]["flat"]["roi"]
        print(f"  EV>{int(ev_thr*100)}%: {n} picks, flat ROI {roi:.1f}%")

    # Tier EV — best of primary or opposing side
    evs = np.array([
        max(
            compute_ev(float(p), int(po)),
            compute_ev(1.0 - float(p), int(oo)),
        )
        for p, po, oo in zip(cal_hold, primary_odds, opposing_odds)
    ])
    tiers = np.array([assign_confidence_tier(ev) for ev in evs])
    tier_counts = {f"tier_{i}": int((tiers >= i).sum()) for i in range(1, 6)}
    win_rates_by_tier = {}
    for t in range(1, 6):
        mask = tiers == t
        if mask.sum() > 0:
            win_rates_by_tier[f"tier_{t}_win_rate"] = float(y_hold[mask].mean())

    # Merge corrected ROI into existing manifest (preserving all other fields)
    updated = dict(manifest)
    updated["roi_simulation"] = roi_stats
    updated["tier_pick_counts"] = tier_counts
    updated["win_rates_by_tier"] = win_rates_by_tier
    updated["backtest_rerun_at"] = datetime.now(timezone.utc).isoformat()
    updated["backtest_bias_fix"] = "bidirectional EV — evaluates both primary and opposing side per game"

    return updated


def main() -> None:
    print("Diamond Edge — ROI Backtest Rerun (bias fix)")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")

    print("\nLoading feature dataset...")
    df = load_and_build_features()

    all_metrics: dict = {}
    for market in ["moneyline", "run_line", "totals"]:
        try:
            result = run_backtest_for_market(market, df)
            all_metrics[market] = result

            # Update per-market manifest
            manifest_path = MODELS_DIR / market / "artifacts" / "manifest.json"
            with open(manifest_path, "w") as f:
                json.dump(result, f, indent=2)
            print(f"  manifest updated: {manifest_path}")

        except Exception as e:
            import traceback
            print(f"ERROR for {market}: {e}")
            traceback.print_exc()
            all_metrics[market] = {"error": str(e)}

    # Write consolidated backtest summary
    summary = {
        "backtest_date": datetime.now(timezone.utc).isoformat(),
        "holdout_season": 2024,
        "bias_fix_applied": "bidirectional EV (both home/away or over/under evaluated per game)",
        "markets": all_metrics,
    }
    summary_path = REPORTS_DIR / "backtest_summary.json"
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\nBacktest summary written: {summary_path}")
    print("\n--- HEADLINE RESULTS (2024 holdout, 4% EV threshold, flat $100) ---")
    for market, m in all_metrics.items():
        if "error" in m:
            print(f"  {market}: ERROR")
            continue
        roi4 = m.get("roi_simulation", {}).get("ev_thr_4pct", {}).get("flat", {})
        k_roi = m.get("roi_simulation", {}).get("ev_thr_4pct", {}).get("kelly025", {})
        cal_pass = "PASS" if m.get("calibration_pass") else "FAIL"
        print(
            f"  {market:10s}: flat ROI={roi4.get('roi','?')}% n={roi4.get('n','?')} "
            f"| kelly ROI={k_roi.get('roi','?')}% | cal={cal_pass}"
        )


if __name__ == "__main__":
    main()
