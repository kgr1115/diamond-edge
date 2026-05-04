"""
Bootstrap CIs on log-loss-vs-prior and ECE for moneyline-v0.

The training script already bootstraps ROI per EV threshold with 1000 iterations.
This script extends with bootstrap CIs on:
  - holdout_log_loss_raw (delta vs market prior)
  - ECE (raw + calibrated, but for v0 they're identical since no isotonic)

CLV for v0 is identically 0 by construction (training source = closing source =
DK + FD via The Odds API at T-60); bootstrap of 0 is 0. Documented as a note.

Output:
  docs/audits/moneyline-v0-backtest-bootstrap-2026-05-04.json
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from sklearn.metrics import log_loss

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ARTIFACT_DIR = REPO_ROOT / "models" / "moneyline" / "current"
PRED_PATH = ARTIFACT_DIR / "holdout-predictions.parquet"
METRICS_PATH = ARTIFACT_DIR / "metrics.json"
OUT_PATH = REPO_ROOT / "docs" / "audits" / "moneyline-v0-backtest-bootstrap-2026-05-04.json"

N_BOOTSTRAP = 1000
ECE_BINS = 10
SEED = 20260504


def market_implied_p_from_log_odds(log_odds: float) -> float:
    return 1.0 / (1.0 + math.exp(-log_odds))


def expected_calibration_error(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = ECE_BINS) -> float:
    bins = np.linspace(0, 1, n_bins + 1)
    indices = np.digitize(y_prob, bins) - 1
    indices = np.clip(indices, 0, n_bins - 1)
    ece = 0.0
    n = len(y_true)
    for b in range(n_bins):
        mask = indices == b
        if not np.any(mask):
            continue
        bin_acc = float(np.mean(y_true[mask]))
        bin_conf = float(np.mean(y_prob[mask]))
        bin_w = float(np.sum(mask)) / n
        ece += bin_w * abs(bin_acc - bin_conf)
    return ece


def bootstrap_log_loss_delta(y_true: np.ndarray, p_model: np.ndarray, p_market: np.ndarray, n_iter: int = N_BOOTSTRAP) -> tuple[float, float, float]:
    rng = np.random.default_rng(seed=SEED)
    n = len(y_true)
    deltas = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n, size=n)
        try:
            ll_model = log_loss(y_true[idx], np.clip(p_model[idx], 1e-15, 1 - 1e-15))
            ll_market = log_loss(y_true[idx], np.clip(p_market[idx], 1e-15, 1 - 1e-15))
            deltas[i] = ll_market - ll_model  # positive => model better
        except ValueError:
            deltas[i] = float("nan")
    deltas = deltas[np.isfinite(deltas)]
    return float(np.mean(deltas)), float(np.quantile(deltas, 0.025)), float(np.quantile(deltas, 0.975))


def bootstrap_ece(y_true: np.ndarray, p: np.ndarray, n_iter: int = N_BOOTSTRAP) -> tuple[float, float, float]:
    rng = np.random.default_rng(seed=SEED)
    n = len(y_true)
    eces = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n, size=n)
        eces[i] = expected_calibration_error(y_true[idx], p[idx])
    return float(np.mean(eces)), float(np.quantile(eces, 0.025)), float(np.quantile(eces, 0.975))


def main() -> None:
    pred = pq.read_table(str(PRED_PATH)).to_pandas()
    print(f"[load] holdout predictions n={len(pred)}")

    y = pred["y_home_win"].to_numpy(dtype=np.int64)
    p_model = pred["p_calibrated"].to_numpy(dtype=np.float64)
    p_market = np.array([market_implied_p_from_log_odds(lo) for lo in pred["market_log_odds_home"].to_numpy()])

    # Point estimates
    ll_model = float(log_loss(y, np.clip(p_model, 1e-15, 1 - 1e-15)))
    ll_market = float(log_loss(y, np.clip(p_market, 1e-15, 1 - 1e-15)))
    delta_point = ll_market - ll_model
    ece_point = expected_calibration_error(y, p_model)

    print(f"[point] log_loss model={ll_model:.4f}  market={ll_market:.4f}  delta={delta_point:+.4f}")
    print(f"[point] ECE={ece_point:.4f}")

    # Bootstrap log-loss delta vs market prior
    ll_mean, ll_lo, ll_hi = bootstrap_log_loss_delta(y, p_model, p_market)
    print(f"[boot] log_loss_delta vs market: mean={ll_mean:+.4f}  CI=({ll_lo:+.4f}, {ll_hi:+.4f})  ({N_BOOTSTRAP} iter)")

    # Bootstrap ECE
    ece_mean, ece_lo, ece_hi = bootstrap_ece(y, p_model)
    print(f"[boot] ECE: mean={ece_mean:.4f}  CI=({ece_lo:.4f}, {ece_hi:.4f})  ({N_BOOTSTRAP} iter)")

    # CLV note
    clv_note = (
        "CLV is identically 0 for v0 by construction: training source = closing "
        "source = DK+FD via The Odds API at T-60. Independent CLV grading enters "
        "once the live cron captures closing snaps a few minutes apart from the "
        "model's anchor pin. Bootstrap CI on a constant-zero series is degenerate "
        "(mean=0, CI=(0,0))."
    )

    # Pull existing ROI bootstrap from metrics.json for reference
    metrics = json.loads(METRICS_PATH.read_text())
    roi_sweep = metrics["ev_threshold_sweep"]

    out = {
        "computed_at_utc": datetime.now(timezone.utc).isoformat(),
        "holdout_n": int(len(pred)),
        "n_bootstrap": N_BOOTSTRAP,
        "seed": SEED,
        "log_loss_delta_vs_market": {
            "point_estimate": delta_point,
            "bootstrap_mean": ll_mean,
            "ci_95_lo": ll_lo,
            "ci_95_hi": ll_hi,
            "interpretation": "Positive delta means model improves over the anchor-only market baseline. CI lower bound > 0 supports 'model adds signal' claim.",
        },
        "ece": {
            "point_estimate": ece_point,
            "bootstrap_mean": ece_mean,
            "ci_95_lo": ece_lo,
            "ci_95_hi": ece_hi,
            "target": 0.04,
            "interpretation": "Sample-weighted absolute calibration error across 10 bins. Target <= 0.04. CI upper bound under target supports 'reliably calibrated' claim.",
        },
        "roi_bootstrap_per_ev_threshold": {
            k: {
                "n_picks": v["n_picks"],
                "roi_unit_mean": v["roi_unit_mean"],
                "roi_ci_lower": v["roi_ci_lower"],
                "roi_ci_upper": v["roi_ci_upper"],
            }
            for k, v in roi_sweep.items()
        },
        "clv_note": clv_note,
        "default_ev_threshold_summary": {
            "threshold": metrics["default_ev_threshold"],
            "n_picks": roi_sweep[f"+{int(metrics['default_ev_threshold']*100)}pct"]["n_picks"],
            "roi_unit_mean": roi_sweep[f"+{int(metrics['default_ev_threshold']*100)}pct"]["roi_unit_mean"],
            "roi_ci_lower": roi_sweep[f"+{int(metrics['default_ev_threshold']*100)}pct"]["roi_ci_lower"],
            "sub_300_rule_pass": metrics["sub_300_variance_aware_rule"]["pass"],
            "sub_300_rule_applies": metrics["sub_300_variance_aware_rule"]["applies"],
        },
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(f"\n[done] wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
