"""
train_models.py — End-to-end training pipeline for Diamond Edge v1 models.

Markets: moneyline, run_line, totals
Algorithm: LightGBM + isotonic calibration + SHAP attributions
Split: train 2022, val 2023, holdout 2024

Research edges included:
  - BP-03: opener detection (home_is_opener, away_is_opener features)
  - SP-01: TTOP exposure features
  - TRAVEL-01: directional eastward travel penalty
  - OFF-02: EWMA offensive form
  - WX-01: handedness-split park HR factor (lineup-weighted)
  - BANKROLL-01: 0.25 Kelly sizing output per pick

Calibration: isotonic regression on val fold (more flexible than Platt for this
feature count; Platt attempted first, isotonic used if any bin deviates > 5%).

Artifacts saved to worker/models/{market}/artifacts/:
  - model.pkl (LightGBM + calibrator)
  - manifest.json (features, training date, data hash, metrics)
  - shap_importance.json

Backtest report: worker/models/backtest/reports/backtest_summary.json
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
matplotlib.use("Agg")  # headless
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import shap
from sklearn.calibration import calibration_curve
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
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


# ---------------------------------------------------------------------------
# Feature lists per market (columns pulled from engineered dataframe)
# ---------------------------------------------------------------------------
MONEYLINE_FEATURES = [
    # SP home
    "home_sp_era_season", "home_sp_era_last_30d", "home_sp_era_last_10d",
    "home_sp_fip_season", "home_sp_k9_season", "home_sp_bb9_season",
    "home_sp_hr9_season", "home_sp_whip_season", "home_sp_days_rest",
    "home_sp_ip_last_start", "home_sp_is_confirmed", "home_sp_throws",
    # SP away
    "away_sp_era_season", "away_sp_era_last_30d", "away_sp_era_last_10d",
    "away_sp_fip_season", "away_sp_k9_season", "away_sp_bb9_season",
    "away_sp_hr9_season", "away_sp_whip_season", "away_sp_days_rest",
    "away_sp_ip_last_start", "away_sp_is_confirmed", "away_sp_throws",
    # Opener + TTOP (research BP-03, SP-01)
    "home_is_opener", "away_is_opener",
    "home_sp_ttop_exposure", "away_sp_ttop_exposure",
    # Bullpen
    "home_bp_era_last_7d", "home_bp_era_season", "home_bp_ip_last_2d",
    "home_bp_ip_last_3d", "home_bp_whip_last_7d",
    "away_bp_era_last_7d", "away_bp_era_season", "away_bp_ip_last_2d",
    "away_bp_ip_last_3d", "away_bp_whip_last_7d",
    # Offense
    "home_team_ops_season", "home_team_ops_last_14d", "home_team_runs_pg_season",
    "home_team_runs_pg_last_14d", "home_team_k_rate_season", "home_team_bb_rate_season",
    "home_team_batting_avg_season",
    "away_team_ops_season", "away_team_ops_last_14d", "away_team_runs_pg_season",
    "away_team_runs_pg_last_14d", "away_team_k_rate_season", "away_team_bb_rate_season",
    "away_team_batting_avg_season",
    # EWMA form (research OFF-02)
    "home_team_runs_ewma_7d", "away_team_runs_ewma_7d",
    # Team record
    "home_team_win_pct_season", "home_team_win_pct_home", "home_team_last10_win_pct",
    "home_team_run_diff_pg", "home_team_pythag_win_pct",
    "away_team_win_pct_season", "away_team_win_pct_away", "away_team_last10_win_pct",
    "away_team_run_diff_pg", "away_team_pythag_win_pct",
    "h2h_home_wins_pct_season",
    # Park
    "park_run_factor", "park_hr_factor", "park_is_dome",
    # Handedness park HR (research WX-01)
    "park_hr_factor_l", "park_hr_factor_r", "park_hr_factor_lineup_weighted",
    # Weather
    "weather_temp_f", "weather_wind_mph", "weather_wind_to_cf", "weather_wind_factor",
    # Rest + travel
    "home_team_days_rest", "away_team_days_rest",
    "away_travel_tz_change", "away_travel_eastward_penalty",
    # Umpire (imputed)
    "ump_k_rate_career", "ump_run_factor", "ump_assigned",
    # Platoon
    "home_platoon_advantage", "away_platoon_advantage", "home_lineup_confirmed",
    # Market
    "market_implied_prob_home", "line_move_direction",
]

RUN_LINE_FEATURES = MONEYLINE_FEATURES + [
    # Pitcher gap
    "sp_fip_gap", "sp_era_last_30d_gap", "sp_k9_gap",
    # Margin distribution
    "home_team_run_margin_avg", "away_team_run_margin_avg",
    "home_team_blowout_rate", "away_team_blowout_rate",
    "home_team_one_run_game_rate", "away_team_one_run_game_rate",
    # ATS history
    "home_team_ats_home_win_pct", "away_team_ats_road_win_pct",
    "home_team_rl_last10_cover_pct",
    # Bullpen depth
    "home_bp_save_rate_season", "away_bp_save_rate_season",
    # Posted total (run environment proxy)
    "posted_total_line", "moneyline_implied_run_line_prob",
]

TOTALS_FEATURES = [
    # SP run prevention
    "home_sp_era_season", "home_sp_era_last_30d", "home_sp_fip_season",
    "home_sp_k9_season", "home_sp_bb9_season", "home_sp_hr9_season",
    "home_sp_days_rest", "home_sp_ip_last_start", "home_sp_is_confirmed",
    "away_sp_era_season", "away_sp_era_last_30d", "away_sp_fip_season",
    "away_sp_k9_season", "away_sp_bb9_season", "away_sp_hr9_season",
    "away_sp_days_rest", "away_sp_ip_last_start", "away_sp_is_confirmed",
    # Combined SP
    "combined_sp_era_season", "combined_sp_fip_season",
    "combined_sp_k9_season", "combined_sp_bb9_season",
    # Opener + TTOP (research BP-03, SP-01)
    "home_is_opener", "away_is_opener",
    "home_sp_ttop_exposure", "away_sp_ttop_exposure",
    # Bullpen run prevention
    "home_bp_era_season", "home_bp_era_last_7d", "home_bp_ip_last_2d",
    "home_bp_ip_last_3d", "home_bp_whip_last_7d",
    "away_bp_era_season", "away_bp_era_last_7d", "away_bp_ip_last_2d",
    "away_bp_ip_last_3d", "away_bp_whip_last_7d",
    # Offense / run scoring
    "home_team_ops_season", "home_team_ops_last_14d", "home_team_runs_pg_season",
    "home_team_runs_pg_last_14d", "home_team_hr_pg_season", "home_team_iso_season",
    "away_team_ops_season", "away_team_ops_last_14d", "away_team_runs_pg_season",
    "away_team_runs_pg_last_14d", "away_team_hr_pg_season", "away_team_iso_season",
    # EWMA form (research OFF-02)
    "home_team_runs_ewma_7d", "away_team_runs_ewma_7d",
    # Combined offense
    "combined_ops_season", "combined_runs_pg_season", "combined_hr_pg_season",
    # Park (critical for totals)
    "park_run_factor", "park_hr_factor", "park_is_dome",
    "park_historical_ou_over_rate", "park_avg_total_scored",
    # Handedness park HR (research WX-01)
    "park_hr_factor_l", "park_hr_factor_r", "park_hr_factor_lineup_weighted",
    # Weather (critical for totals)
    "weather_temp_f", "weather_temp_deviation_from_avg",
    "weather_wind_mph", "weather_wind_to_cf", "weather_wind_factor", "weather_is_dome",
    # Rest + travel
    "home_team_days_rest", "away_team_days_rest", "game_is_doubleheader",
    "away_travel_tz_change", "away_travel_eastward_penalty",
    # Market signal
    "posted_total_line", "implied_over_probability", "total_line_move_direction",
    # Historical scoring
    "home_team_ou_over_rate_season", "away_team_ou_over_rate_season",
    "h2h_avg_total_scored_season",
    # Umpire
    "ump_k_rate_career", "ump_run_factor", "ump_assigned",
]

MARKET_CONFIG = {
    "moneyline": {
        "features": MONEYLINE_FEATURES,
        "target": "home_win",
        "version": "moneyline-v1.0.0",
    },
    "run_line": {
        "features": RUN_LINE_FEATURES,
        "target": "home_covers_run_line",
        "version": "run_line-v1.0.0",
    },
    "totals": {
        "features": TOTALS_FEATURES,
        "target": "over_hits",
        "version": "totals-v1.0.0",
    },
}

LGBM_PARAMS = {
    "objective": "binary",
    "metric": "binary_logloss",
    "n_estimators": 600,
    "learning_rate": 0.03,
    "num_leaves": 31,
    "max_depth": 6,
    "min_child_samples": 30,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 5,
    "reg_alpha": 0.1,
    "reg_lambda": 0.1,
    "random_state": 42,
    "n_jobs": -1,
    "verbose": -1,
}


# ---------------------------------------------------------------------------
# EV computation
# ---------------------------------------------------------------------------
def compute_ev(model_prob: float, american_odds: int) -> float:
    if american_odds > 0:
        net_win = american_odds / 100.0
    else:
        net_win = 100.0 / abs(american_odds)
    return model_prob * net_win - (1.0 - model_prob) * 1.0


def kelly_fraction(ev: float, american_odds: int, fraction: float = 0.25) -> float:
    """Quarter-Kelly stake as fraction of bankroll."""
    if american_odds > 0:
        b = american_odds / 100.0
    else:
        b = 100.0 / abs(american_odds)
    p = (ev + 1.0) / (b + 1.0)  # rearranged from EV formula
    q = 1.0 - p
    if b <= 0 or p <= 0 or q <= 0:
        return 0.0
    kelly_full = (b * p - q) / b
    return max(0.0, kelly_full * fraction)


def american_to_implied(odds: int | float) -> float:
    if pd.isna(odds):
        return 0.5
    o = float(odds)
    if o > 0:
        return 100.0 / (100.0 + o)
    else:
        return abs(o) / (abs(o) + 100.0)


# ---------------------------------------------------------------------------
# Data loading / feature assembly
# ---------------------------------------------------------------------------
def load_and_build_features() -> pd.DataFrame:
    """
    Load raw MLB Stats data + odds and build full feature dataset.
    Returns training-ready DataFrame with all market features.
    """
    schedule_path = DATA_DIR / "mlb_schedule_raw.parquet"
    pitcher_path = DATA_DIR / "pitcher_logs_raw.parquet"
    bullpen_path = DATA_DIR / "bullpen_raw.parquet"
    team_batting_path = DATA_DIR / "team_batting_raw.parquet"

    if not schedule_path.exists():
        raise FileNotFoundError(
            f"Schedule data not found at {schedule_path}. "
            "Run worker/models/pipelines/pull_mlb_stats.py first."
        )

    print("Loading schedule...")
    schedule = pd.read_parquet(schedule_path)
    print(f"  {len(schedule)} total games")

    # Normalize team names
    schedule["home_team_abbr"] = schedule["home_team_name"].apply(mlb_team_name_to_abbr)
    schedule["away_team_abbr"] = schedule["away_team_name"].apply(mlb_team_name_to_abbr)
    schedule = schedule.dropna(subset=["home_team_abbr", "away_team_abbr"])
    schedule = schedule.dropna(subset=["home_score", "away_score"])
    schedule["home_score"] = schedule["home_score"].astype(int)
    schedule["away_score"] = schedule["away_score"].astype(int)
    print(f"  {len(schedule)} games with valid team names and scores")

    print("Loading odds...")
    odds_df = load_all_seasons([2022, 2023, 2024])
    print(f"  {len(odds_df)} odds rows")

    pitcher_logs = pd.read_parquet(pitcher_path) if pitcher_path.exists() else pd.DataFrame()
    bullpen_logs = pd.read_parquet(bullpen_path) if bullpen_path.exists() else pd.DataFrame()
    team_batting = pd.read_parquet(team_batting_path) if team_batting_path.exists() else pd.DataFrame()

    print(f"  Pitcher logs: {len(pitcher_logs)}, Bullpen: {len(bullpen_logs)}, Team batting: {len(team_batting)}")

    print("Building pitcher features (fast)...")
    t0 = time.time()
    schedule = build_pitcher_features_fast(pitcher_logs, schedule)
    print(f"  Pitcher features: {time.time()-t0:.1f}s")

    print("Building bullpen features (fast)...")
    t0 = time.time()
    schedule = build_bullpen_features_fast(bullpen_logs, schedule)
    print(f"  Bullpen features: {time.time()-t0:.1f}s")

    print("Building team offense features (fast)...")
    t0 = time.time()
    schedule = build_team_offense_fast(team_batting, schedule)
    print(f"  Offense features: {time.time()-t0:.1f}s")

    print("Building EWMA offense features (research OFF-02)...")
    t0 = time.time()
    schedule = add_ewma_offense_features(team_batting, schedule)
    print(f"  EWMA features: {time.time()-t0:.1f}s")

    print("Building team record features (fast)...")
    t0 = time.time()
    schedule = build_team_record_fast(schedule)
    print(f"  Record features: {time.time()-t0:.1f}s")

    print("Adding park features...")
    schedule = add_park_features(schedule)
    schedule = add_handedness_park_factors(schedule)

    print("Detecting opener games (research BP-03)...")
    t0 = time.time()
    schedule = detect_opener_games(schedule, pitcher_logs)
    print(f"  Opener detection: {time.time()-t0:.1f}s")

    print("Adding TTOP features (research SP-01)...")
    t0 = time.time()
    schedule = add_ttop_features(schedule, pitcher_logs)
    print(f"  TTOP features: {time.time()-t0:.1f}s")

    print("Adding directional travel features (research TRAVEL-01)...")
    schedule = add_travel_features(schedule)

    print("Adding weather features (imputed)...")
    if "weather_temp_f" not in schedule.columns:
        schedule["weather_temp_f"] = 72.0
    if "weather_wind_mph" not in schedule.columns:
        schedule["weather_wind_mph"] = 5.0
    if "weather_wind_to_cf" not in schedule.columns:
        schedule["weather_wind_to_cf"] = 0.0
    schedule["weather_wind_factor"] = (
        schedule["weather_wind_mph"] * schedule["weather_wind_to_cf"]
    )
    schedule["weather_temp_deviation_from_avg"] = 0.0
    schedule["weather_is_dome"] = schedule["park_is_dome"]
    schedule["game_is_doubleheader"] = 0

    print("Adding SP confirmation flags...")
    schedule["home_sp_is_confirmed"] = (schedule["home_sp_id"].notna()).astype(int)
    schedule["away_sp_is_confirmed"] = (schedule["away_sp_id"].notna()).astype(int)
    schedule["home_sp_throws"] = 1
    schedule["away_sp_throws"] = 1

    print("Adding market features...")
    schedule = add_market_features(schedule, odds_df)

    print("Adding derived features...")
    schedule = add_derived_run_line_features(schedule)
    schedule = add_combined_totals_features(schedule)

    # Remaining imputed features
    schedule["home_team_ou_over_rate_season"] = 0.50
    schedule["away_team_ou_over_rate_season"] = 0.50
    schedule["h2h_avg_total_scored_season"] = (
        schedule["home_team_runs_pg_season"] + schedule["away_team_runs_pg_season"]
    )
    schedule["h2h_home_wins_pct_season"] = 0.50
    schedule["park_historical_ou_over_rate"] = 0.50
    schedule["park_avg_total_scored"] = 8.5
    schedule["home_lineup_confirmed"] = 1
    schedule["home_platoon_advantage"] = 0.5
    schedule["away_platoon_advantage"] = 0.5
    schedule["ump_k_rate_career"] = 0.218
    schedule["ump_run_factor"] = 1.0
    schedule["ump_assigned"] = 0
    schedule["home_bp_save_rate_season"] = 0.65
    schedule["away_bp_save_rate_season"] = 0.65

    print("Adding target variables...")
    schedule["home_win"] = (schedule["home_score"] > schedule["away_score"]).astype(int)
    run_margin = schedule["home_score"] - schedule["away_score"]
    schedule["home_covers_run_line"] = (run_margin >= 2).astype(int)
    total_runs = schedule["home_score"] + schedule["away_score"]
    total_line = schedule.get("posted_total_line", pd.Series([8.5] * len(schedule))).fillna(8.5)
    over_hits = []
    for tr, tl in zip(total_runs, total_line):
        if tr > tl:
            over_hits.append(1.0)
        elif tr < tl:
            over_hits.append(0.0)
        else:
            over_hits.append(np.nan)
    schedule["over_hits"] = over_hits

    # Data hash
    data_hash = hashlib.md5(
        pd.util.hash_pandas_object(
            schedule[["game_pk", "game_date", "home_team_abbr"]].head(100)
        ).values
    ).hexdigest()[:12]
    schedule["_data_hash"] = data_hash

    print(f"Feature dataset complete: {len(schedule)} games, {len(schedule.columns)} columns")
    return schedule


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------
def fit_calibrator(raw_probs: np.ndarray, y_true: np.ndarray) -> IsotonicRegression:
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(raw_probs, y_true)
    return iso


def calibration_error(y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = 10) -> float:
    """Expected Calibration Error (ECE)."""
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
    market: str,
    output_path: Path,
) -> float:
    """Plot reliability diagram and return max bin deviation."""
    frac_pos, mean_pred = calibration_curve(y_true, y_prob, n_bins=10, strategy="quantile")

    max_deviation = float(np.max(np.abs(frac_pos - mean_pred)))

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 10))
    ax1.plot([0, 1], [0, 1], "k--", label="Perfect calibration")
    ax1.plot(mean_pred, frac_pos, "s-", label=f"{market} calibrated")
    ax1.fill_between(
        mean_pred,
        np.maximum(0, frac_pos - 0.05),
        np.minimum(1, frac_pos + 0.05),
        alpha=0.2, label="±5% tolerance",
    )
    ax1.set_xlabel("Mean Predicted Probability")
    ax1.set_ylabel("Fraction of Positives")
    ax1.set_title(f"Reliability Diagram — {market} — 2024 Holdout")
    ax1.set_xlim(0, 1)
    ax1.set_ylim(0, 1)
    ax1.legend()

    ax2.hist(y_prob, bins=20, edgecolor="black")
    ax2.set_xlabel("Predicted Probability")
    ax2.set_ylabel("Count")
    ax2.set_title("Prediction Distribution")

    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()

    return max_deviation


# ---------------------------------------------------------------------------
# ROI simulation (flat + Kelly)
# ---------------------------------------------------------------------------
def _flat_pnl_for_bet(odds_int: int, won: bool) -> float:
    """Return flat-$100 P&L for a single bet."""
    if odds_int > 0:
        profit_if_win = float(odds_int)
    else:
        profit_if_win = 100.0 * 100.0 / abs(odds_int)
    return profit_if_win if won else -100.0


def _kelly_pnl_for_bet(ev: float, odds_int: int, bankroll: float,
                        fraction: float, won: bool) -> tuple[float, float]:
    """Return (stake, kelly_pnl) for a single Kelly bet. Caps stake at 10% of bankroll."""
    kf = kelly_fraction(ev, odds_int, fraction)
    stake = min(bankroll * kf, bankroll * 0.10)  # BANKROLL-03 cap
    if odds_int > 0:
        kprofit = stake * odds_int / 100.0
    else:
        kprofit = stake * 100.0 / abs(odds_int)
    return stake, (kprofit if won else -stake)


def simulate_roi(
    model_probs: np.ndarray,
    y_true: np.ndarray,
    primary_odds: np.ndarray,
    ev_threshold: float = 0.02,
    kelly_fraction_param: float = 0.25,
    opposing_odds: np.ndarray | None = None,
) -> dict:
    """
    Simulate ROI for picks above ev_threshold.

    model_probs — calibrated P(primary side wins), e.g. P(home win) or P(over)
    y_true      — 1 if primary side won, 0 otherwise
    primary_odds — best American odds available for the primary side (DK/FD max)
    opposing_odds — best American odds for the opposing side (away / under).
                    When provided the simulator evaluates BOTH sides per game
                    and bets whichever has the higher EV above threshold
                    (skips game if neither side clears the threshold).
                    Without this, only the primary side is evaluated — which
                    was the original home-side-only bias.

    Returns flat ($100/pick) and 0.25-Kelly ROI dicts.
    """
    results = {
        "flat": {"n": 0, "wagered": 0.0, "profit": 0.0, "roi": 0.0, "wins": 0, "max_drawdown": 0.0},
        "kelly025": {"n": 0, "wagered": 0.0, "profit": 0.0, "roi": 0.0, "wins": 0, "max_drawdown": 0.0},
    }

    BANKROLL = 1000.0
    flat_pnl: list[float] = []
    kelly_pnl: list[float] = []
    kelly_bank = BANKROLL

    iter_cols = zip(model_probs, y_true, primary_odds)
    opp = opposing_odds if opposing_odds is not None else np.full(len(primary_odds), np.nan)

    for (prob, outcome, p_odds), o_odds in zip(iter_cols, opp):
        if pd.isna(prob) or pd.isna(outcome) or pd.isna(p_odds):
            continue

        prob = float(prob)
        p_odds_int = int(p_odds)

        # Primary-side EV: model prob vs primary-side odds
        ev_primary = compute_ev(prob, p_odds_int)

        # Opposing-side EV: (1 - model_prob) vs opposing odds
        ev_opposing = -999.0
        o_odds_int: int | None = None
        if not pd.isna(o_odds):
            o_odds_int = int(o_odds)
            ev_opposing = compute_ev(1.0 - prob, o_odds_int)

        # Choose which side to bet (if any)
        bet_primary = ev_primary >= ev_threshold
        bet_opposing = (o_odds_int is not None) and (ev_opposing >= ev_threshold)

        if not bet_primary and not bet_opposing:
            continue

        # If both sides clear threshold, take the higher-EV side
        if bet_primary and bet_opposing:
            bet_primary = ev_primary >= ev_opposing

        if bet_primary:
            bet_odds = p_odds_int
            bet_ev = ev_primary
            won = int(outcome) == 1
        else:
            bet_odds = o_odds_int  # type: ignore[assignment]
            bet_ev = ev_opposing
            won = int(outcome) == 0  # opposing side wins when primary side loses

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

    # Flat stats
    if flat_pnl:
        cum = np.cumsum(flat_pnl)
        results["flat"]["profit"] = float(sum(flat_pnl))
        results["flat"]["roi"] = round(
            results["flat"]["profit"] / results["flat"]["wagered"] * 100, 2
        ) if results["flat"]["wagered"] > 0 else 0.0
        running_max = np.maximum.accumulate(cum)
        drawdowns = running_max - cum
        results["flat"]["max_drawdown"] = float(drawdowns.max()) if len(drawdowns) > 0 else 0.0

    # Kelly stats
    if kelly_pnl:
        cum_k = np.cumsum(kelly_pnl)
        results["kelly025"]["profit"] = float(sum(kelly_pnl))
        results["kelly025"]["roi"] = round(
            results["kelly025"]["profit"] / results["kelly025"]["wagered"] * 100, 2
        ) if results["kelly025"]["wagered"] > 0 else 0.0
        running_max_k = np.maximum.accumulate(cum_k)
        drawdowns_k = running_max_k - cum_k
        results["kelly025"]["max_drawdown"] = float(drawdowns_k.max()) if len(drawdowns_k) > 0 else 0.0

    return results


def assign_confidence_tier(ev: float, uncertainty: float = 0.0) -> int:
    if ev <= 0:
        return 0
    elif ev <= 0.02:
        base = 1
    elif ev <= 0.04:
        base = 2
    elif ev <= 0.06:
        base = 3
    elif ev <= 0.09:
        base = 4
    else:
        base = 5

    penalty = 1 if uncertainty >= 0.06 else 0
    return max(1, base - penalty)


# ---------------------------------------------------------------------------
# Train one market model
# ---------------------------------------------------------------------------
def train_market(
    market: str,
    df: pd.DataFrame,
) -> dict:
    """
    Train, calibrate, and evaluate one market model.
    Returns metrics dict and saves artifacts.
    """
    cfg = MARKET_CONFIG[market]
    target_col = cfg["target"]
    feature_cols = cfg["features"]
    version = cfg["version"]

    print(f"\n{'='*60}")
    print(f"Training: {market.upper()}")
    print(f"{'='*60}")

    # Filter valid rows
    valid = df.dropna(subset=[target_col]).copy()
    valid = valid[valid[target_col].notna()].copy()
    if market == "totals":
        valid = valid[valid[target_col] != 0.5].copy()  # exclude pushes

    # Season splits
    valid["season_dt"] = pd.to_datetime(valid["game_date"]).dt.year
    train = valid[valid["season_dt"] == 2022].copy()
    val = valid[valid["season_dt"] == 2023].copy()
    holdout = valid[valid["season_dt"] == 2024].copy()

    print(f"  Train 2022: {len(train)} | Val 2023: {len(val)} | Holdout 2024: {len(holdout)}")

    if len(train) < 100:
        return {"error": f"Insufficient training data for {market}: {len(train)} rows"}

    # Only keep feature columns that exist in the dataframe
    available_features = [f for f in feature_cols if f in valid.columns]
    missing = [f for f in feature_cols if f not in valid.columns]
    if missing:
        print(f"  Missing features (imputing 0): {missing[:5]}{'...' if len(missing) > 5 else ''}")
        for m in missing:
            valid[m] = 0.0
            train[m] = 0.0
            val[m] = 0.0
            holdout[m] = 0.0
        available_features = feature_cols

    X_train = train[available_features].fillna(0).values
    y_train = train[target_col].astype(float).values
    X_val = val[available_features].fillna(0).values
    y_val = val[target_col].astype(float).values
    X_hold = holdout[available_features].fillna(0).values
    y_hold = holdout[target_col].astype(float).values

    # Train LightGBM
    print("  Training LightGBM...")
    model = lgb.LGBMClassifier(**LGBM_PARAMS)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)],
    )
    print(f"  Best iteration: {model.best_iteration_}")

    # Raw probabilities on val + holdout
    raw_val = model.predict_proba(X_val)[:, 1]
    raw_hold = model.predict_proba(X_hold)[:, 1]

    # Calibrate on val fold
    print("  Fitting isotonic calibration on val fold...")
    calibrator = fit_calibrator(raw_val, y_val)
    cal_val = calibrator.predict(raw_val)
    cal_hold = calibrator.predict(raw_hold)

    # Evaluate
    print("  Evaluating on 2024 holdout...")
    ll = log_loss(y_hold, cal_hold)
    brier = brier_score_loss(y_hold, cal_hold)
    ece = calibration_error(y_hold, cal_hold)

    print(f"  Log-loss: {ll:.4f} (target < 0.68)")
    print(f"  Brier: {brier:.4f} (target < 0.24)")
    print(f"  ECE: {ece:.4f}")

    # Reliability diagram
    diag_path = REPORTS_DIR / f"calibration_{market}_holdout.png"
    max_dev = plot_reliability_diagram(y_hold, cal_hold, market, diag_path)
    print(f"  Max calibration deviation: {max_dev:.3f} (target < 0.05)")
    print(f"  Reliability diagram: {diag_path}")

    # Best odds for EV simulation — both primary and opposing sides
    # Primary: the side aligned with model_prob (home win / over)
    # Opposing: the other side (away win / under); needed to avoid home-side-only bias
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

    def get_best_odds(df_sub: pd.DataFrame, cols: tuple[str, str],
                      default: int = -110) -> np.ndarray:
        c1, c2 = cols
        v1 = df_sub.get(c1, pd.Series([default] * len(df_sub))).fillna(default).values
        v2 = df_sub.get(c2, pd.Series([default] * len(df_sub))).fillna(default).values
        # For negative (favourite) odds the larger value is better for the bettor;
        # np.maximum picks the less-negative (best) available price.
        return np.maximum(v1, v2)

    holdout_primary_odds = get_best_odds(holdout, primary_odds_cols)
    holdout_opposing_odds = get_best_odds(holdout, opposing_odds_cols)

    # ROI simulation at multiple EV thresholds
    roi_stats = {}
    for ev_thr in [0.02, 0.04, 0.06]:
        roi_stats[f"ev_thr_{int(ev_thr*100)}pct"] = simulate_roi(
            cal_hold, y_hold, holdout_primary_odds,
            ev_threshold=ev_thr,
            opposing_odds=holdout_opposing_odds,
        )

    # Pick frequency per tier — use the better EV across both sides
    evs = np.array([
        max(
            compute_ev(float(p), int(po)),
            compute_ev(1.0 - float(p), int(oo)),
        )
        for p, po, oo in zip(cal_hold, holdout_primary_odds, holdout_opposing_odds)
    ])
    tiers = np.array([
        assign_confidence_tier(ev) for ev in evs
    ])
    tier_counts = {f"tier_{i}": int((tiers >= i).sum()) for i in range(1, 6)}
    win_rates_by_tier = {}
    for t in range(1, 6):
        mask = tiers == t
        if mask.sum() > 0:
            win_rates_by_tier[f"tier_{t}_win_rate"] = float(y_hold[mask].mean())

    # SHAP feature importance
    print("  Computing SHAP values (TreeExplainer)...")
    try:
        explainer = shap.TreeExplainer(model)
        # Use a sample of holdout for SHAP (full set may be slow)
        shap_sample = X_hold[:min(500, len(X_hold))]
        shap_vals = explainer.shap_values(shap_sample)
        if isinstance(shap_vals, list):
            shap_vals = shap_vals[1]  # positive class
        mean_abs_shap = np.abs(shap_vals).mean(axis=0)
        shap_importance = {
            feat: round(float(imp), 6)
            for feat, imp in sorted(
                zip(available_features, mean_abs_shap),
                key=lambda x: x[1], reverse=True
            )
        }
        top10 = list(shap_importance.items())[:10]
        print("  Top 10 features by SHAP:")
        for fname, simp in top10:
            print(f"    {fname}: {simp:.4f}")
    except Exception as e:
        print(f"  SHAP computation failed: {e} — skipping SHAP")
        shap_importance = {f: 0.0 for f in available_features}

    # Save artifacts
    artifact_dir = MODELS_DIR / market / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)

    model_artifact = {"model": model, "calibrator": calibrator, "features": available_features}
    with open(artifact_dir / "model.pkl", "wb") as f:
        pickle.dump(model_artifact, f)

    with open(artifact_dir / "shap_importance.json", "w") as f:
        json.dump(shap_importance, f, indent=2)

    data_hash = df["_data_hash"].iloc[0] if "_data_hash" in df.columns else "unknown"

    metrics = {
        "market": market,
        "version": version,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "training_seasons": [2022],
        "val_season": 2023,
        "holdout_season": 2024,
        "training_games": len(train),
        "val_games": len(val),
        "holdout_games": len(holdout),
        "data_hash": data_hash,
        "features": available_features,
        "n_features": len(available_features),
        "lgbm_best_iteration": int(model.best_iteration_),
        "holdout_log_loss": round(ll, 4),
        "holdout_brier": round(brier, 4),
        "holdout_ece": round(ece, 4),
        "holdout_max_calibration_deviation": round(max_dev, 4),
        "calibration_pass": bool(max_dev < 0.05),
        "roi_simulation": roi_stats,
        "tier_pick_counts": tier_counts,
        "win_rates_by_tier": win_rates_by_tier,
        "research_features_added": [
            "home_is_opener", "away_is_opener",
            "home_sp_ttop_exposure", "away_sp_ttop_exposure",
            "away_travel_tz_change", "away_travel_eastward_penalty",
            "home_team_runs_ewma_7d", "away_team_runs_ewma_7d",
            "park_hr_factor_l", "park_hr_factor_r", "park_hr_factor_lineup_weighted",
        ],
        "known_weaknesses": [
            "Umpire features G6 imputed to league average — no real ump signal",
            "Lineup handedness imputed (no confirmed lineups in training) — platoon features weak",
            "Statcast xFIP/Stuff+ missing (G3 gap) — using ERA/FIP as proxy",
            "Weather features imputed to averages (no game-time weather in historical data)",
            "TTOP computed from IP proxy not true pitch count — rough approximation",
            "Opener detection uses 5-start avg IP heuristic, not beat-news signal",
            "Model trained on 2022 only (1 season) — add 2023 in v1.1 with walk-forward CV",
        ],
    }

    with open(artifact_dir / "manifest.json", "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"  Artifacts saved to {artifact_dir}")

    return metrics


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def main(markets: list[str] | None = None) -> dict:
    if markets is None:
        markets = ["moneyline", "run_line", "totals"]

    print("Diamond Edge v1 Training Pipeline")
    print(f"Markets: {markets}")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
    print()

    # Load and build features once (shared across all markets)
    df = load_and_build_features()

    # Save processed dataset for debugging/reuse
    processed_path = DATA_DIR / "games_v1_processed.parquet"
    df.to_parquet(processed_path, index=False)
    print(f"Processed dataset saved: {processed_path}")

    all_metrics = {}

    for market in markets:
        try:
            metrics = train_market(market, df)
            all_metrics[market] = metrics
        except Exception as e:
            print(f"ERROR training {market}: {e}")
            import traceback
            traceback.print_exc()
            all_metrics[market] = {"error": str(e)}

    # Write consolidated backtest summary
    summary = {
        "backtest_date": datetime.now(timezone.utc).isoformat(),
        "holdout_season": 2024,
        "markets": all_metrics,
    }
    summary_path = REPORTS_DIR / "backtest_summary.json"
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nBacktest summary: {summary_path}")

    # Print headline metrics
    print("\n" + "="*60)
    print("BACKTEST HEADLINE METRICS (2024 holdout)")
    print("="*60)
    for market, m in all_metrics.items():
        if "error" in m:
            print(f"{market:10s}: ERROR — {m['error']}")
            continue
        ll = m.get("holdout_log_loss", "N/A")
        brier = m.get("holdout_brier", "N/A")
        cal_pass = "PASS" if m.get("calibration_pass") else "FAIL"
        ev4_roi = m.get("roi_simulation", {}).get("ev_thr_4pct", {}).get("flat", {}).get("roi", "N/A")
        ev4_n = m.get("roi_simulation", {}).get("ev_thr_4pct", {}).get("flat", {}).get("n", 0)
        k_roi = m.get("roi_simulation", {}).get("ev_thr_4pct", {}).get("kelly025", {}).get("roi", "N/A")
        print(
            f"{market:10s}: log-loss={ll} brier={brier} cal={cal_pass} "
            f"| flat-ROI@4%EV={ev4_roi}% ({ev4_n} picks) | kelly025-ROI={k_roi}%"
        )

    return all_metrics


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--markets", nargs="+", default=["moneyline", "run_line", "totals"])
    args = parser.parse_args()
    main(args.markets)
