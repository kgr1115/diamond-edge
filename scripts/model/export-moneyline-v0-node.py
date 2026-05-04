"""
Export the trained moneyline-v0 artifact (model.joblib + scaler.joblib +
feature-coefficients.json) into a single Node-friendly JSON for serve-time
inference from `apps/web/app/api/cron/pick-pipeline/route.ts`.

The Node serving path mirrors what sklearn does at predict time:
    z = intercept
        + anchor_coef * raw_anchor
        + Σ residual_coef_i * ((raw_residual_i - scaler_mean_i) / scaler_scale_i)
    p_home = sigmoid(z)

If isotonic_applied = true (not in v0), the Node code also applies the
isotonic step-function table to p_home before tier mapping.

Output: models/moneyline/current/serving-params.json
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import joblib

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ARTIFACT_DIR = REPO_ROOT / "models" / "moneyline" / "current"
# Source-of-truth copy stays alongside the joblib artifacts.
OUT_PATH = ARTIFACT_DIR / "serving-params.json"
# Deploy copy lives inside apps/web so Vercel bundles it with the function.
WEB_OUT_PATH = REPO_ROOT / "apps" / "web" / "lib" / "models" / "serving-params.json"

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


def main() -> None:
    model = joblib.load(ARTIFACT_DIR / "model.joblib")
    scaler = joblib.load(ARTIFACT_DIR / "scaler.joblib")
    metrics = json.loads((ARTIFACT_DIR / "metrics.json").read_text())

    # sklearn coef_ is shape (1, n_features). [0] = anchor (raw), [1:] = residuals (scaled).
    intercept = float(model.intercept_[0])
    anchor_coef = float(model.coef_[0][0])
    residual_coefs_scaled = [float(c) for c in model.coef_[0][1:]]

    if len(residual_coefs_scaled) != len(RESIDUAL_FEATURES):
        raise SystemExit(
            f"residual coefficient count mismatch: {len(residual_coefs_scaled)} vs {len(RESIDUAL_FEATURES)}"
        )

    scaler_mean = [float(m) for m in scaler.mean_]
    scaler_scale = [float(s) for s in scaler.scale_]

    isotonic_applied = bool(metrics["calibration"]["isotonic_applied"])

    payload: dict = {
        "model_id": "moneyline-v0",
        "trained_at_utc": metrics["trained_at_utc"],
        "holdout_declaration_id": metrics["holdout_declaration_id"],
        "intercept": intercept,
        "anchor": {
            "feature": ANCHOR_FEATURE,
            "coefficient": anchor_coef,
        },
        "residual_features": RESIDUAL_FEATURES,
        "residual_coefficients_scaled": residual_coefs_scaled,
        "scaler": {
            "mean": scaler_mean,
            "scale": scaler_scale,
        },
        "isotonic_applied": isotonic_applied,
        "isotonic_table": None,
    }

    if isotonic_applied:
        cal_path = ARTIFACT_DIR / "calibrator.joblib"
        if not cal_path.exists():
            raise SystemExit("isotonic_applied=true but calibrator.joblib not present")
        cal = joblib.load(cal_path)
        # IsotonicRegression exposes X_thresholds_ and y_thresholds_; reproduce
        # the predict step in Node via a piecewise linear interpolation.
        payload["isotonic_table"] = {
            "x_thresholds": [float(x) for x in cal.X_thresholds_],
            "y_thresholds": [float(y) for y in cal.y_thresholds_],
            "out_of_bounds": "clip",
        }

    rendered = json.dumps(payload, indent=2) + "\n"
    OUT_PATH.write_text(rendered)
    WEB_OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    WEB_OUT_PATH.write_text(rendered)
    print(f"[export] wrote {OUT_PATH}  intercept={intercept:.4f}  anchor_coef={anchor_coef:.4f}")
    print(f"[export] wrote {WEB_OUT_PATH} (deploy copy for the route bundle)")
    print(f"[export] residual coefs (scaled): {len(residual_coefs_scaled)}")
    print(f"[export] scaler dim: mean={len(scaler_mean)} scale={len(scaler_scale)}")
    print(f"[export] isotonic applied: {isotonic_applied}")


if __name__ == "__main__":
    main()
