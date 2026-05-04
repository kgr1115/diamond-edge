"""
Validation driver for moneyline-v0.

Implements steps 4 + 5 of the moneyline-v0 validation plan
(docs/research/moneyline-v0-validation-path-2026-05-04.md).

Produces a 4-model x 2-holdout cell table:

  rows:    v0  +  3 baselines (market-prior-only, anchor-only logistic,
                                anchor + favorite-winpct logistic)
  cols:    holdout_post_asb_2024  (existing models/moneyline/current/ artifact)
           holdout_pre_asb_2024   (validation models/moneyline/validation-pre-asb-2024/)

For each cell, computes:
  - n_picks at +1/+2/+3% EV (default +2%)
  - ROI per cell (i.i.d. bootstrap CI + 7-day-block bootstrap CI + 5d/10d sensitivity)
  - log-loss vs market-prior baseline
  - ECE (raw, no isotonic)

The v0 cells use the OWN-TRAINING-WINDOW model:
  - v0_current was trained on 2023-04-01 -> 2024-07-15 and evaluated on
    2024-07-19 -> 2024-09-29 — that is THE existing v0.
  - v0_walkforward was trained on 2023-04-01 -> 2024-03-28 and evaluated on
    2024-04-01 -> 2024-07-15 — that is the validation v0 just trained.

For comparison, the script ALSO predicts v0_current on the pre-ASB-2024
features (using the existing current/ model + scaler) and v0_walkforward on
the post-ASB features (using the validation/ model + scaler) — these are
"cross-window" diagnostics, reported separately in the JSON for completeness
but the headline 4x2 cell table uses the OWN-TRAINING-WINDOW pairing
(model_id `v0` per the declaration's `validation_models_to_evaluate`).

Inputs:
  data/features/moneyline-v0/{train,holdout}.parquet                (existing)
  data/features/moneyline-v0-validation-pre-asb-2024/{train,holdout}.parquet
  models/moneyline/current/{model,scaler}.joblib                    (existing)
  models/moneyline/validation-pre-asb-2024/{model,scaler}.joblib
  models/moneyline/validation-holdout-declaration-pre-asb-2024.json (read-only)

Outputs:
  models/moneyline/validation-pre-asb-2024/validation-cell-table.json
  (the audit doc reads this and renders the markdown report)

Hard rules:
  * Does NOT modify models/moneyline/current/ in any way.
  * Does NOT promote the validation model.
  * Reads but does not modify the validation declaration.
  * No isotonic on the validation slice (declaration locks calibration choice).
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
import psycopg
import pyarrow.parquet as pq
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

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
SEED = 20260504
BLOCK_SIZE_DEFAULT = 7
BLOCK_SIZE_SENSITIVITY = [5, 7, 10]


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def load_env() -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        sys.exit(f"[ERROR] .env not found at {env_path}")
    with env_path.open() as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if k and k not in os.environ:
                os.environ[k] = v


def market_implied_p(log_odds: float) -> float:
    return 1.0 / (1.0 + math.exp(-log_odds))


def implied_prob_from_american(price: int) -> float:
    if price >= 100:
        return 100.0 / (price + 100)
    return abs(price) / (abs(price) + 100)


def expected_value_unit(p: float, american_price: int) -> float:
    if american_price >= 100:
        payout = american_price / 100.0
    else:
        payout = 100.0 / abs(american_price)
    return p * payout - (1 - p)


def p_to_american(p: float) -> int:
    if p <= 0 or p >= 1:
        return 0
    if p >= 0.5:
        return -int(round(100 * p / (1 - p)))
    return int(round(100 * (1 - p) / p))


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
    block_size_days: int = BLOCK_SIZE_DEFAULT,
    n_iter: int = N_BOOTSTRAP,
    seed: int = SEED,
) -> tuple[float, float]:
    """
    7-day-block bootstrap on per-pick ROI.

    Picks are first grouped into contiguous blocks of `block_size_days`
    keyed on `pick_dates` (date of the bet). Each iteration resamples
    blocks with replacement until the total number of picks meets or
    exceeds the original n, then truncates to original n. The mean of
    the resampled per-pick profits is the bootstrap statistic.
    """
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
        # Resample block indices until we cover at least n picks.
        chosen = []
        total = 0
        while total < n:
            bidx = rng.integers(0, n_blocks)
            chosen.append(blocks[bidx])
            total += len(blocks[bidx])
        sample = np.concatenate(chosen)[:n]
        means[i] = float(np.mean(sample))
    return float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))


# ----------------------------------------------------------------------------
# Per-cell ROI computation
# ----------------------------------------------------------------------------

def compute_picks_and_profits(
    p: np.ndarray,
    log_odds_home: np.ndarray,
    y_home_win: np.ndarray,
    ev_threshold: float,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Same grading logic as scripts/model/train-moneyline-v0.py:
    bet HOME if EV(home, p) > thr; bet AWAY if EV(away, 1-p) > thr and not also home.
    Grading prices derived from the de-vigged consensus (p_close = sigmoid(anchor)).

    Returns (per_pick_profit, pick_index) arrays where `pick_index` indexes
    the rows of the original feature parquet for which a bet was placed.
    """
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
    # Return both, but date alignment uses indices into the holdout dataframe.
    return profits, indices


def compute_cell(
    name: str,
    p_holdout: np.ndarray,
    holdout_df: pd.DataFrame,
) -> dict:
    """Compute ROI/ECE/log-loss + bootstrap CIs for a model on one holdout."""
    y = holdout_df[LABEL].to_numpy(dtype=np.int64)
    log_odds = holdout_df[ANCHOR_FEATURE].to_numpy(dtype=np.float64)
    p_market = np.array([market_implied_p(lo) for lo in log_odds])

    ll_model = float(log_loss(y, np.clip(p_holdout, 1e-15, 1 - 1e-15)))
    ll_market = float(log_loss(y, np.clip(p_market, 1e-15, 1 - 1e-15)))
    ll_delta = ll_market - ll_model
    ece = expected_calibration_error(y, p_holdout, ECE_BINS)

    ev_results = {}
    for thr in EV_THRESHOLDS:
        profits, indices = compute_picks_and_profits(p_holdout, log_odds, y, thr)
        n_picks = int(len(profits))
        roi = float(np.mean(profits)) if n_picks > 0 else float("nan")

        if n_picks > 0:
            roi_ci_iid_lo, roi_ci_iid_hi = iid_bootstrap_ci(profits, seed=SEED)
            # block bootstraps need pick dates
            pick_dates = holdout_df.iloc[indices]["game_date"].to_numpy()
            block_cis = {}
            for bs in BLOCK_SIZE_SENSITIVITY:
                lo, hi = block_bootstrap_ci(profits, pick_dates, block_size_days=bs, seed=SEED + bs)
                block_cis[f"{bs}d"] = {"ci_lo": lo, "ci_hi": hi}
        else:
            roi_ci_iid_lo = roi_ci_iid_hi = float("nan")
            block_cis = {f"{bs}d": {"ci_lo": float("nan"), "ci_hi": float("nan")} for bs in BLOCK_SIZE_SENSITIVITY}

        ev_results[f"+{int(thr*100)}pct"] = {
            "ev_threshold": thr,
            "n_picks": n_picks,
            "roi_unit_mean": roi,
            "roi_ci_iid_lo": roi_ci_iid_lo,
            "roi_ci_iid_hi": roi_ci_iid_hi,
            "roi_ci_block_bootstrap": block_cis,
        }

    return {
        "model_id": name,
        "n_holdout": int(len(holdout_df)),
        "log_loss_model": ll_model,
        "log_loss_market_prior": ll_market,
        "log_loss_delta_vs_market": ll_delta,
        "ece_raw": ece,
        "ev_threshold_sweep": ev_results,
    }


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------

def predict_v0(model_path: Path, scaler_path: Path, df: pd.DataFrame) -> np.ndarray:
    model = joblib.load(model_path)
    scaler = joblib.load(scaler_path)
    df = df.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    residuals_scaled = scaler.transform(df[RESIDUAL_FEATURES].to_numpy(dtype=np.float64))
    X = np.hstack([df[[ANCHOR_FEATURE]].to_numpy(dtype=np.float64), residuals_scaled])
    return model.predict_proba(X)[:, 1], df


def predict_market_prior(df: pd.DataFrame) -> np.ndarray:
    df = df.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    return np.array([market_implied_p(lo) for lo in df[ANCHOR_FEATURE].to_numpy()]), df


def fit_anchor_only(train_df: pd.DataFrame) -> LogisticRegression:
    train_df = train_df.dropna(subset=[ANCHOR_FEATURE, LABEL]).reset_index(drop=True)
    X = train_df[[ANCHOR_FEATURE]].to_numpy(dtype=np.float64)
    y = train_df[LABEL].to_numpy(dtype=np.int64)
    m = LogisticRegression(penalty="l2", C=1.0, solver="lbfgs", max_iter=500, fit_intercept=True)
    m.fit(X, y)
    return m


def predict_anchor_only(model: LogisticRegression, df: pd.DataFrame) -> np.ndarray:
    df = df.dropna(subset=[ANCHOR_FEATURE, LABEL]).reset_index(drop=True)
    X = df[[ANCHOR_FEATURE]].to_numpy(dtype=np.float64)
    return model.predict_proba(X)[:, 1], df


# ----------------------------------------------------------------------------
# Favorite-winpct feature derivation (queries DB inline)
# ----------------------------------------------------------------------------

def load_team_ids_for_games(conn, game_ids: list[str]) -> pd.DataFrame:
    """Load home_team_id / away_team_id keyed on game_id::text."""
    if not game_ids:
        return pd.DataFrame(columns=["game_id", "home_team_id", "away_team_id"])
    placeholders = ",".join(["%s"] * len(game_ids))
    q = f"""
      SELECT id::text AS game_id,
             home_team_id::text AS home_team_id,
             away_team_id::text AS away_team_id
      FROM games
      WHERE id::text IN ({placeholders})
    """
    return pd.read_sql(q, conn, params=game_ids)


def load_team_game_results(conn, season_start_date: str, end_date: str) -> pd.DataFrame:
    """All final games with team IDs and scores in [season_start_date, end_date]."""
    q = """
      SELECT id::text AS game_id,
             game_date,
             home_team_id::text AS home_team_id,
             away_team_id::text AS away_team_id,
             home_score, away_score,
             game_time_utc
      FROM games
      WHERE game_date >= %s::date
        AND game_date <= %s::date
        AND status = 'final'
        AND home_score IS NOT NULL
        AND away_score IS NOT NULL
    """
    df = pd.read_sql(q, conn, params=(season_start_date, end_date))
    df["game_date"] = pd.to_datetime(df["game_date"]).dt.date
    return df


def compute_favorite_winpct_feature(
    holdout_df: pd.DataFrame,
    teams_df: pd.DataFrame,
    season_results: pd.DataFrame,
) -> pd.Series:
    """
    For each row in holdout_df:
      - Identify the favorite team (home if market_log_odds_home > 0 else away)
      - Compute that team's season-to-date W/L pct as of (game_date, exclusive)
        in the SAME calendar year (season).

    Returns a Series indexed like holdout_df with the favorite_winpct value
    (defaulting to 0.5 if no prior games for that team in the season).
    """
    teams_by_game = teams_df.set_index("game_id")[["home_team_id", "away_team_id"]].to_dict("index")

    # Build a per-team running W/L log: list of (game_date, win_indicator)
    # where win_indicator = 1 if the team won, 0 if lost.
    rows = []
    for _, g in season_results.iterrows():
        h_won = 1 if g["home_score"] > g["away_score"] else 0
        rows.append({"team_id": g["home_team_id"], "game_date": g["game_date"], "win": h_won})
        rows.append({"team_id": g["away_team_id"], "game_date": g["game_date"], "win": 1 - h_won})
    log = pd.DataFrame(rows).sort_values(["team_id", "game_date"]).reset_index(drop=True)
    # Index by team_id for fast lookup
    log_by_team = {tid: g.reset_index(drop=True) for tid, g in log.groupby("team_id")}

    out = []
    for _, row in holdout_df.iterrows():
        gid = row["game_id"]
        gd = pd.to_datetime(row["game_date"]).date() if not isinstance(row["game_date"], type(pd.Timestamp.now().date())) else row["game_date"]
        season_year = gd.year
        team_lookup = teams_by_game.get(gid)
        if team_lookup is None:
            out.append(0.5)
            continue
        fav_team = team_lookup["home_team_id"] if row[ANCHOR_FEATURE] > 0 else team_lookup["away_team_id"]
        team_log = log_by_team.get(fav_team)
        if team_log is None:
            out.append(0.5)
            continue
        # Season-to-date in the SAME year: game_date strictly < gd AND year(game_date) == season_year.
        sub = team_log[(team_log["game_date"] < gd) & (team_log["game_date"].apply(lambda d: d.year) == season_year)]
        if sub.empty:
            out.append(0.5)
            continue
        out.append(float(sub["win"].mean()))
    return pd.Series(out, index=holdout_df.index, dtype=float)


def fit_anchor_plus_favwinpct(train_df: pd.DataFrame, fav_winpct_col: pd.Series) -> tuple[LogisticRegression, StandardScaler]:
    train_df = train_df.dropna(subset=[ANCHOR_FEATURE, LABEL]).reset_index(drop=True)
    fav = fav_winpct_col.reindex(train_df.index).fillna(0.5).to_numpy(dtype=np.float64).reshape(-1, 1)
    scaler = StandardScaler().fit(fav)
    fav_s = scaler.transform(fav)
    X = np.hstack([train_df[[ANCHOR_FEATURE]].to_numpy(dtype=np.float64), fav_s])
    y = train_df[LABEL].to_numpy(dtype=np.int64)
    m = LogisticRegression(penalty="l2", C=1.0, solver="lbfgs", max_iter=500, fit_intercept=True)
    m.fit(X, y)
    return m, scaler


def predict_anchor_plus_favwinpct(model: LogisticRegression, scaler: StandardScaler, df: pd.DataFrame, fav_winpct_col: pd.Series) -> np.ndarray:
    df = df.dropna(subset=[ANCHOR_FEATURE, LABEL]).reset_index(drop=True)
    fav = fav_winpct_col.reindex(df.index).fillna(0.5).to_numpy(dtype=np.float64).reshape(-1, 1)
    fav_s = scaler.transform(fav)
    X = np.hstack([df[[ANCHOR_FEATURE]].to_numpy(dtype=np.float64), fav_s])
    return model.predict_proba(X)[:, 1], df


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--block-size-days", type=int, default=BLOCK_SIZE_DEFAULT)
    args = parser.parse_args()

    load_env()
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("[ERROR] SUPABASE_DB_URL not set")

    # Paths
    feat_orig_dir = REPO_ROOT / "data" / "features" / "moneyline-v0"
    feat_val_dir = REPO_ROOT / "data" / "features" / "moneyline-v0-validation-pre-asb-2024"
    artifact_orig = REPO_ROOT / "models" / "moneyline" / "current"
    artifact_val = REPO_ROOT / "models" / "moneyline" / "validation-pre-asb-2024"
    out_dir = artifact_val
    out_dir.mkdir(parents=True, exist_ok=True)

    # Sanity: do not touch current/
    print(f"[init] feat_orig_dir={feat_orig_dir}")
    print(f"[init] feat_val_dir={feat_val_dir}")
    print(f"[init] artifact_orig={artifact_orig} (READ-ONLY)")
    print(f"[init] artifact_val={artifact_val}")

    # Load feature parquets
    train_orig = pq.read_table(str(feat_orig_dir / "train.parquet")).to_pandas()
    holdout_orig = pq.read_table(str(feat_orig_dir / "holdout.parquet")).to_pandas()
    train_val = pq.read_table(str(feat_val_dir / "train.parquet")).to_pandas()
    holdout_val = pq.read_table(str(feat_val_dir / "holdout.parquet")).to_pandas()

    # Drop rows with NaN ALL_FEATURES (matches train script behavior)
    train_orig = train_orig.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    holdout_orig = holdout_orig.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    train_val = train_val.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    holdout_val = holdout_val.dropna(subset=ALL_FEATURES + [LABEL]).reset_index(drop=True)
    print(f"[load] train_orig n={len(train_orig)}  holdout_orig n={len(holdout_orig)}")
    print(f"[load] train_val  n={len(train_val)}   holdout_val  n={len(holdout_val)}")

    # ------------------------------------------------------------------
    # Load team IDs + season results for favorite-winpct feature
    # ------------------------------------------------------------------
    print("[fav] loading team IDs + season results from DB")
    all_game_ids = (
        list(train_orig["game_id"].unique())
        + list(holdout_orig["game_id"].unique())
        + list(train_val["game_id"].unique())
        + list(holdout_val["game_id"].unique())
    )
    all_game_ids = list(set(all_game_ids))
    with psycopg.connect(db_url, sslmode="require") as conn:
        teams_df = load_team_ids_for_games(conn, all_game_ids)
        # Season results: cover earliest 2023-01-01 (warmup season starts) up to 2024-12-31.
        # In-season is keyed by calendar year so 2023 results fuel 2023 anchor; 2024 fuels 2024.
        season_results = load_team_game_results(conn, "2023-01-01", "2024-12-31")
    print(f"[fav] teams_df n={len(teams_df)}  season_results n={len(season_results)}")

    print("[fav] computing favorite_winpct on each window")
    fav_train_orig = compute_favorite_winpct_feature(train_orig, teams_df, season_results)
    fav_holdout_orig = compute_favorite_winpct_feature(holdout_orig, teams_df, season_results)
    fav_train_val = compute_favorite_winpct_feature(train_val, teams_df, season_results)
    fav_holdout_val = compute_favorite_winpct_feature(holdout_val, teams_df, season_results)
    print(f"[fav] mean(fav_train_orig)={fav_train_orig.mean():.4f}  mean(fav_holdout_orig)={fav_holdout_orig.mean():.4f}")
    print(f"[fav] mean(fav_train_val)={fav_train_val.mean():.4f}   mean(fav_holdout_val)={fav_holdout_val.mean():.4f}")

    # ------------------------------------------------------------------
    # Build cells
    # ------------------------------------------------------------------
    cells = {
        "post_asb_2024": {},
        "pre_asb_2024": {},
    }

    # 1) v0 — own-training-window
    print("\n[cell] v0_current on post-ASB-2024 holdout (load existing predictions)")
    # Use the existing predictions parquet for byte-equivalence with the live artifact.
    pred_orig = pq.read_table(str(artifact_orig / "holdout-predictions.parquet")).to_pandas()
    # Align: pred_orig["p_calibrated"] is what the artifact serves.
    holdout_orig_indexed = holdout_orig.set_index("game_id")
    pred_aligned = pred_orig.set_index("game_id").loc[holdout_orig_indexed.index]
    p_v0_post = pred_aligned["p_calibrated"].to_numpy(dtype=np.float64)
    cells["post_asb_2024"]["v0"] = compute_cell("v0_current", p_v0_post, holdout_orig)

    print("[cell] v0_walkforward on pre-ASB-2024 holdout (validation artifact predictions)")
    pred_val = pq.read_table(str(artifact_val / "holdout-predictions.parquet")).to_pandas()
    holdout_val_indexed = holdout_val.set_index("game_id")
    pred_val_aligned = pred_val.set_index("game_id").loc[holdout_val_indexed.index]
    p_v0_pre = pred_val_aligned["p_calibrated"].to_numpy(dtype=np.float64)
    cells["pre_asb_2024"]["v0"] = compute_cell("v0_walkforward_pre_asb_2024", p_v0_pre, holdout_val)

    # 2) market-prior baseline on both
    print("[cell] baseline_market_prior_only on post-ASB and pre-ASB")
    p_mkt_post, _ = predict_market_prior(holdout_orig)
    p_mkt_pre, _ = predict_market_prior(holdout_val)
    cells["post_asb_2024"]["baseline_market_prior_only"] = compute_cell("baseline_market_prior_only", p_mkt_post, holdout_orig)
    cells["pre_asb_2024"]["baseline_market_prior_only"] = compute_cell("baseline_market_prior_only", p_mkt_pre, holdout_val)

    # 3) anchor-only logistic on both (fit on corresponding training window)
    print("[cell] baseline_anchor_only_logistic on post-ASB (fit on train_orig)")
    m_anchor_orig = fit_anchor_only(train_orig)
    p_anchor_post, _ = predict_anchor_only(m_anchor_orig, holdout_orig)
    cells["post_asb_2024"]["baseline_anchor_only_logistic"] = compute_cell("baseline_anchor_only_logistic", p_anchor_post, holdout_orig)
    print(f"      anchor_only_orig.coef_={m_anchor_orig.coef_.tolist()}  intercept={float(m_anchor_orig.intercept_[0]):.4f}")

    print("[cell] baseline_anchor_only_logistic on pre-ASB (fit on train_val)")
    m_anchor_val = fit_anchor_only(train_val)
    p_anchor_pre, _ = predict_anchor_only(m_anchor_val, holdout_val)
    cells["pre_asb_2024"]["baseline_anchor_only_logistic"] = compute_cell("baseline_anchor_only_logistic", p_anchor_pre, holdout_val)
    print(f"      anchor_only_val.coef_={m_anchor_val.coef_.tolist()}  intercept={float(m_anchor_val.intercept_[0]):.4f}")

    # 4) anchor + favorite-winpct logistic on both
    print("[cell] baseline_anchor_plus_favwinpct on post-ASB (fit on train_orig)")
    m_apf_orig, sc_apf_orig = fit_anchor_plus_favwinpct(train_orig, fav_train_orig)
    p_apf_post, _ = predict_anchor_plus_favwinpct(m_apf_orig, sc_apf_orig, holdout_orig, fav_holdout_orig)
    cells["post_asb_2024"]["baseline_anchor_plus_favorite_winpct"] = compute_cell("baseline_anchor_plus_favorite_winpct", p_apf_post, holdout_orig)
    print(f"      apf_orig.coef_={m_apf_orig.coef_.tolist()}  intercept={float(m_apf_orig.intercept_[0]):.4f}")

    print("[cell] baseline_anchor_plus_favwinpct on pre-ASB (fit on train_val)")
    m_apf_val, sc_apf_val = fit_anchor_plus_favwinpct(train_val, fav_train_val)
    p_apf_pre, _ = predict_anchor_plus_favwinpct(m_apf_val, sc_apf_val, holdout_val, fav_holdout_val)
    cells["pre_asb_2024"]["baseline_anchor_plus_favorite_winpct"] = compute_cell("baseline_anchor_plus_favorite_winpct", p_apf_pre, holdout_val)
    print(f"      apf_val.coef_={m_apf_val.coef_.tolist()}  intercept={float(m_apf_val.intercept_[0]):.4f}")

    # ------------------------------------------------------------------
    # Cross-window diagnostics: v0_current on pre-ASB, v0_walkforward on post-ASB.
    # Reported for completeness; NOT counted toward the 4x2 success criteria.
    # ------------------------------------------------------------------
    print("\n[diag] v0_current on pre-ASB-2024 (cross-window)")
    p_cur_on_pre, holdout_val_for_cur = predict_v0(artifact_orig / "model.joblib", artifact_orig / "scaler.joblib", holdout_val.copy())
    diag_cur_on_pre = compute_cell("v0_current_on_pre_asb", p_cur_on_pre, holdout_val_for_cur)

    print("[diag] v0_walkforward on post-ASB-2024 (cross-window)")
    p_val_on_post, holdout_orig_for_val = predict_v0(artifact_val / "model.joblib", artifact_val / "scaler.joblib", holdout_orig.copy())
    diag_val_on_post = compute_cell("v0_walkforward_on_post_asb", p_val_on_post, holdout_orig_for_val)

    # ------------------------------------------------------------------
    # Write JSON output
    # ------------------------------------------------------------------
    output = {
        "computed_at_utc": datetime.now(timezone.utc).isoformat(),
        "validation_declaration_id": "moneyline-v0-validation-holdout-pre-asb-2024-2026-05-04",
        "n_bootstrap": N_BOOTSTRAP,
        "seed": SEED,
        "block_size_default_days": BLOCK_SIZE_DEFAULT,
        "block_size_sensitivity_days": BLOCK_SIZE_SENSITIVITY,
        "default_ev_threshold": DEFAULT_EV_THRESHOLD,
        "n": {
            "train_orig": int(len(train_orig)),
            "holdout_orig": int(len(holdout_orig)),
            "train_val": int(len(train_val)),
            "holdout_val": int(len(holdout_val)),
        },
        "favorite_winpct_check": {
            "mean_train_orig": float(fav_train_orig.mean()),
            "mean_holdout_orig": float(fav_holdout_orig.mean()),
            "mean_train_val": float(fav_train_val.mean()),
            "mean_holdout_val": float(fav_holdout_val.mean()),
            "note": "Favorite team identified by sign of market_log_odds_home (positive => home is favorite). Win-pct is season-to-date (calendar year) of that team STRICTLY BEFORE the game's date. 0.5 fallback if team has no prior in-season games.",
        },
        "baseline_coefficients": {
            "anchor_only_orig": {
                "coef": float(m_anchor_orig.coef_[0][0]),
                "intercept": float(m_anchor_orig.intercept_[0]),
            },
            "anchor_only_val": {
                "coef": float(m_anchor_val.coef_[0][0]),
                "intercept": float(m_anchor_val.intercept_[0]),
            },
            "anchor_plus_favwinpct_orig": {
                "anchor_coef": float(m_apf_orig.coef_[0][0]),
                "favwinpct_coef_post_scaling": float(m_apf_orig.coef_[0][1]),
                "intercept": float(m_apf_orig.intercept_[0]),
            },
            "anchor_plus_favwinpct_val": {
                "anchor_coef": float(m_apf_val.coef_[0][0]),
                "favwinpct_coef_post_scaling": float(m_apf_val.coef_[0][1]),
                "intercept": float(m_apf_val.intercept_[0]),
            },
        },
        "cells": cells,
        "cross_window_diagnostics": {
            "v0_current_on_pre_asb_2024": diag_cur_on_pre,
            "v0_walkforward_on_post_asb_2024": diag_val_on_post,
        },
    }

    out_json = out_dir / "validation-cell-table.json"
    out_json.write_text(json.dumps(output, indent=2, default=float))
    print(f"\n[done] wrote {out_json}")

    # Print headline cell table
    print("\n=== HEADLINE 4x2 cell table at +2% EV ===")
    print(f"{'model':<46} {'post-ASB-2024':>20}  {'pre-ASB-2024':>20}")
    for model_id in [
        "v0",
        "baseline_market_prior_only",
        "baseline_anchor_only_logistic",
        "baseline_anchor_plus_favorite_winpct",
    ]:
        post = cells["post_asb_2024"][model_id]["ev_threshold_sweep"]["+2pct"]
        pre = cells["pre_asb_2024"][model_id]["ev_threshold_sweep"]["+2pct"]
        post_str = f"ROI={post['roi_unit_mean']:+.4f} n={post['n_picks']}"
        pre_str = f"ROI={pre['roi_unit_mean']:+.4f} n={pre['n_picks']}"
        print(f"{model_id:<46} {post_str:>20}  {pre_str:>20}")


if __name__ == "__main__":
    main()
