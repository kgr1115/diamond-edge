"""
One-shot side-by-side comparison helper for moneyline-v0 vs candidate-retrain-2026-05-04.

Reads holdout-predictions.parquet from both artifacts and computes:
  - Per-EV-threshold ROI with i.i.d. + 5d/7d/10d block-bootstrap CIs
  - Pulled from the same pinned holdout declaration, so directly comparable
    on the v0 slice (post-ASB-2024 date range), but the candidate has more
    games due to October re-pull coverage gain.

Block bootstrap mirrors scripts/model/validate-moneyline-v0.py.

Output: docs/audits/moneyline-v0-candidate-retrain-2026-05-04-roi-block-bootstrap.json

Pick-implementer note (2026-05-04): this is a single-run helper, not a
permanent pipeline script. Block-ROI bootstrap belongs in
backtest-finalize-moneyline-v0.py as a follow-up; doing that as part of this
candidate cycle would be scope creep.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

V0_PRED = REPO_ROOT / "models" / "moneyline" / "current" / "holdout-predictions.parquet"
CAND_PRED = REPO_ROOT / "models" / "moneyline" / "candidate-retrain-2026-05-04" / "holdout-predictions.parquet"
OUT = REPO_ROOT / "docs" / "audits" / "moneyline-v0-candidate-retrain-2026-05-04-roi-block-bootstrap.json"

EV_THRESHOLDS = [0.01, 0.02, 0.03]
BLOCK_SIZES = [5, 7, 10]
N_BOOTSTRAP = 1000
SEED = 20260504


def market_implied_p(log_odds: float) -> float:
    return 1.0 / (1.0 + math.exp(-log_odds))


def p_to_american(p: float) -> int:
    p = max(min(p, 0.999999), 1e-6)
    if p >= 0.5:
        return int(round(-100 * p / (1 - p)))
    return int(round(100 * (1 - p) / p))


def expected_value_unit(p: float, american_price: int) -> float:
    if american_price >= 100:
        payout = american_price / 100.0
    else:
        payout = 100.0 / abs(american_price)
    return p * payout - (1 - p)


def compute_picks_and_profits(
    p: np.ndarray,
    log_odds_home: np.ndarray,
    y_home_win: np.ndarray,
    ev_threshold: float,
) -> tuple[np.ndarray, np.ndarray]:
    n = len(p)
    p_close = np.array([market_implied_p(lo) for lo in log_odds_home])
    home_prices = np.array([p_to_american(pc) for pc in p_close])
    away_prices = np.array([p_to_american(1 - pc) for pc in p_close])

    ev_home = np.array([expected_value_unit(float(p[i]), int(home_prices[i])) for i in range(n)])
    ev_away = np.array([expected_value_unit(1 - float(p[i]), int(away_prices[i])) for i in range(n)])

    pick_home_mask = ev_home > ev_threshold
    pick_away_mask = (ev_away > ev_threshold) & (~pick_home_mask)

    profit_home = np.where(
        home_prices >= 100,
        (home_prices / 100.0) * (y_home_win == 1) - 1 * (y_home_win == 0),
        (100.0 / np.where(home_prices != 0, np.abs(home_prices), 1)) * (y_home_win == 1) - 1 * (y_home_win == 0),
    )
    profit_away = np.where(
        away_prices >= 100,
        (away_prices / 100.0) * (y_home_win == 0) - 1 * (y_home_win == 1),
        (100.0 / np.where(away_prices != 0, np.abs(away_prices), 1)) * (y_home_win == 0) - 1 * (y_home_win == 1),
    )

    home_idx = np.where(pick_home_mask)[0]
    away_idx = np.where(pick_away_mask)[0]
    profits = np.concatenate([profit_home[home_idx], profit_away[away_idx]])
    indices = np.concatenate([home_idx, away_idx])
    return profits, indices


def iid_bootstrap_ci(values: np.ndarray, n_iter: int = N_BOOTSTRAP, seed: int = SEED) -> tuple[float, float]:
    if len(values) == 0:
        return float("nan"), float("nan")
    rng = np.random.default_rng(seed=seed)
    n = len(values)
    means = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n, size=n)
        means[i] = float(np.mean(values[idx]))
    return float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))


def block_bootstrap_ci(
    per_pick_profit: np.ndarray,
    pick_dates: np.ndarray,
    block_size_days: int,
    n_iter: int = N_BOOTSTRAP,
    seed: int = SEED,
) -> tuple[float, float]:
    if len(per_pick_profit) == 0:
        return float("nan"), float("nan")
    n = len(per_pick_profit)
    df = pd.DataFrame({"profit": per_pick_profit, "date": pd.to_datetime(pick_dates)})
    df = df.sort_values("date").reset_index(drop=True)
    if df.empty:
        return float("nan"), float("nan")
    min_date = df["date"].min()
    df["block_id"] = ((df["date"] - min_date).dt.days // block_size_days).astype(int)
    blocks = [g["profit"].to_numpy() for _, g in df.groupby("block_id", sort=True)]
    if not blocks:
        return float("nan"), float("nan")
    rng = np.random.default_rng(seed=seed)
    n_blocks = len(blocks)
    means = np.empty(n_iter)
    for i in range(n_iter):
        chosen = []
        total = 0
        while total < n:
            bidx = rng.integers(0, n_blocks)
            chosen.append(blocks[bidx])
            total += len(blocks[bidx])
        sample = np.concatenate(chosen)[:n]
        means[i] = float(np.mean(sample))
    return float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))


def evaluate(label: str, pred_path: Path) -> dict:
    df = pq.read_table(str(pred_path)).to_pandas()
    print(f"[{label}] n={len(df)} from {pred_path}")
    p = df["p_calibrated"].to_numpy(dtype=np.float64)
    log_odds = df["market_log_odds_home"].to_numpy(dtype=np.float64)
    y = df["y_home_win"].to_numpy(dtype=np.int64)
    dates = df["game_date"].to_numpy()

    out = {"label": label, "n_holdout": int(len(df)), "ev_threshold_sweep": {}}
    for thr in EV_THRESHOLDS:
        profits, indices = compute_picks_and_profits(p, log_odds, y, thr)
        n_picks = int(len(profits))
        roi = float(np.mean(profits)) if n_picks > 0 else float("nan")
        iid_lo, iid_hi = iid_bootstrap_ci(profits, seed=SEED)
        block_cis = {}
        for bs in BLOCK_SIZES:
            lo, hi = block_bootstrap_ci(profits, dates[indices], block_size_days=bs, seed=SEED + bs)
            block_cis[f"{bs}d"] = {"ci_lo": lo, "ci_hi": hi, "binding": bs == 7}
        print(f"[{label}] +{int(thr*100)}% EV  n={n_picks}  ROI={roi:+.4f}  iid_CI=({iid_lo:+.4f},{iid_hi:+.4f})  7d_CI=({block_cis['7d']['ci_lo']:+.4f},{block_cis['7d']['ci_hi']:+.4f})")
        out["ev_threshold_sweep"][f"+{int(thr*100)}pct"] = {
            "ev_threshold": thr,
            "n_picks": n_picks,
            "roi_unit_mean": roi,
            "roi_ci_iid_lo": iid_lo,
            "roi_ci_iid_hi": iid_hi,
            "roi_ci_block_bootstrap": block_cis,
        }
    return out


def main() -> None:
    v0 = evaluate("v0_current", V0_PRED)
    cand = evaluate("v0.1_candidate_retrain", CAND_PRED)
    bundle = {
        "computed_at_utc": datetime.now(timezone.utc).isoformat(),
        "n_bootstrap": N_BOOTSTRAP,
        "seed": SEED,
        "block_sizes_days": BLOCK_SIZES,
        "block_bootstrap_binding": "7d",
        "comparison_method": "Same pinned holdout declaration (post-ASB-2024). Candidate has more games (~980 vs 609) due to October re-pull coverage gain. Both use raw p_calibrated from their own holdout-predictions.parquet.",
        "v0_current": v0,
        "candidate_v0_1_retrain_2026_05_04": cand,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(bundle, indent=2))
    print(f"\n[done] wrote {OUT}")


if __name__ == "__main__":
    main()
