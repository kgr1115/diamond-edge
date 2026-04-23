"""
drift_audit.py — Feature distribution comparison: train (2022+2023) vs holdout (2024).

Hypothesis 1: run-line mean P(home cover) = 0.349 in v1 holdout vs true ~0.43.
Hypothesis 2: moneyline probs reaching 0.90 (LightGBM overconfidence on thin data).

Outputs:
  worker/models/backtest/reports/drift_audit.json  — per-feature z-score table
  worker/models/backtest/reports/drift_audit_run_line_cover_rate.txt — smoking gun

Commit: chore(worker): drift audit — feature distribution comparison train vs 2024
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[3]))

REPORTS_DIR = Path(__file__).parents[1] / "backtest" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

DATA_DIR = Path(__file__).parents[3] / "data" / "training"


def run_drift_audit(df: pd.DataFrame) -> dict:
    """
    Compare feature means between train (2022+2023) and holdout (2024).
    Returns dict with per-feature delta, z-score, and flag if |z| > 2.
    """
    df = df.copy()
    df["season_dt"] = pd.to_datetime(df["game_date"]).dt.year

    train = df[df["season_dt"].isin([2022, 2023])].copy()
    hold = df[df["season_dt"] == 2024].copy()

    print(f"Drift audit: train n={len(train)}, holdout n={len(hold)}")

    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    # Exclude targets, identifiers, season marker
    exclude = {
        "season_dt", "game_pk", "home_score", "away_score",
        "home_win", "home_covers_run_line", "over_hits",
        "home_team_id", "away_team_id", "season",
    }
    feature_cols = [c for c in numeric_cols if c not in exclude]

    results = {}
    flagged = []

    for col in feature_cols:
        tr_vals = train[col].dropna()
        ho_vals = hold[col].dropna()

        if len(tr_vals) < 10 or len(ho_vals) < 10:
            continue

        tr_mean = float(tr_vals.mean())
        ho_mean = float(ho_vals.mean())
        tr_std = float(tr_vals.std())
        delta = ho_mean - tr_mean

        # Pooled z-score (mean difference / pooled SE)
        se = np.sqrt(tr_vals.var() / len(tr_vals) + ho_vals.var() / len(ho_vals))
        z = delta / se if se > 0 else 0.0

        results[col] = {
            "train_mean": round(tr_mean, 6),
            "holdout_mean": round(ho_mean, 6),
            "delta": round(delta, 6),
            "train_std": round(tr_std, 6),
            "z_score": round(z, 3),
            "flagged": bool(abs(z) > 2.0),
        }

        if abs(z) > 2.0:
            flagged.append((col, round(z, 3), round(delta, 6)))

    flagged.sort(key=lambda x: abs(x[1]), reverse=True)
    print(f"\nFeatures with |z| > 2.0 (train vs holdout drift): {len(flagged)}")
    for col, z, delta in flagged[:20]:
        print(f"  {col:45s}  z={z:+.2f}  delta={delta:+.4f}")

    # Smoking gun: target variable cover rate by season
    cover_by_season = {}
    for yr in [2022, 2023, 2024]:
        sub = df[df["season_dt"] == yr]
        if "home_covers_run_line" in sub.columns:
            rate = sub["home_covers_run_line"].mean()
            cover_by_season[str(yr)] = round(float(rate), 4)
    print(f"\nHome covers run line rate by season: {cover_by_season}")

    win_by_season = {}
    for yr in [2022, 2023, 2024]:
        sub = df[df["season_dt"] == yr]
        if "home_win" in sub.columns:
            rate = sub["home_win"].mean()
            win_by_season[str(yr)] = round(float(rate), 4)
    print(f"Home win rate by season: {win_by_season}")

    over_by_season = {}
    for yr in [2022, 2023, 2024]:
        sub = df[df["season_dt"] == yr]
        if "over_hits" in sub.columns:
            rate = sub["over_hits"].dropna().mean()
            over_by_season[str(yr)] = round(float(rate), 4)
    print(f"Over hit rate by season: {over_by_season}")

    return {
        "train_n": int(len(train)),
        "holdout_n": int(len(hold)),
        "n_features_checked": len(results),
        "n_flagged_z2": len(flagged),
        "flagged_features": [
            {"feature": col, "z_score": z, "delta": d}
            for col, z, d in flagged
        ],
        "target_rates": {
            "home_covers_run_line": cover_by_season,
            "home_win": win_by_season,
            "over_hits": over_by_season,
        },
        "all_features": results,
    }


def main():
    """
    Load the processed training dataset and run drift audit.
    Falls back to building from raw parquet if processed not found.
    """
    processed_path = DATA_DIR / "games_v1_processed.parquet"

    if processed_path.exists():
        print(f"Loading processed dataset: {processed_path}")
        df = pd.read_parquet(processed_path)
    else:
        print("Processed dataset not found. Building from raw data...")
        # Import train pipeline to get the feature-engineered df
        from worker.models.pipelines.train_models import load_and_build_features
        df = load_and_build_features()
        df.to_parquet(processed_path, index=False)
        print(f"Saved processed dataset to {processed_path}")

    audit = run_drift_audit(df)

    class _NumpyEncoder(json.JSONEncoder):
        def default(self, obj):
            import numpy as np
            if isinstance(obj, np.integer):
                return int(obj)
            if isinstance(obj, np.floating):
                return float(obj)
            if isinstance(obj, np.bool_):
                return bool(obj)
            if isinstance(obj, np.ndarray):
                return obj.tolist()
            return super().default(obj)

    out_path = REPORTS_DIR / "drift_audit.json"
    with open(out_path, "w") as f:
        json.dump(audit, f, indent=2, cls=_NumpyEncoder)
    print(f"\nDrift audit saved: {out_path}")

    # Human-readable summary
    summary_path = REPORTS_DIR / "drift_audit_summary.txt"
    with open(summary_path, "w") as f:
        f.write("DRIFT AUDIT SUMMARY — train (2022+2023) vs holdout (2024)\n")
        f.write("=" * 70 + "\n\n")
        f.write(f"Train games: {audit['train_n']}\n")
        f.write(f"Holdout games: {audit['holdout_n']}\n")
        f.write(f"Features checked: {audit['n_features_checked']}\n")
        f.write(f"Features flagged (|z|>2): {audit['n_flagged_z2']}\n\n")

        f.write("TARGET RATES BY SEASON (root cause investigation)\n")
        f.write("-" * 50 + "\n")
        for target, rates in audit["target_rates"].items():
            f.write(f"  {target}:\n")
            for yr, rate in rates.items():
                f.write(f"    {yr}: {rate:.4f}\n")

        f.write("\nTOP 20 DRIFTED FEATURES (|z| > 2.0)\n")
        f.write("-" * 50 + "\n")
        for item in audit["flagged_features"][:20]:
            f.write(
                f"  {item['feature']:45s}  z={item['z_score']:+.2f}  "
                f"delta={item['delta']:+.4f}\n"
            )

    print(f"Drift summary: {summary_path}")
    return audit


if __name__ == "__main__":
    main()
