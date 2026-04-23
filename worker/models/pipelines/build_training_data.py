"""
build_training_data.py — Feature engineering from raw data → training-ready parquet.

Joins MLB Stats game results with historical odds, builds all features per the
three market feature specs. Enforces leakage cutoff: all rolling stats use
only data from days strictly before game_date.

Output: data/training/games_v1.parquet

Column naming follows the feature specs exactly so SHAP labels match the spec.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[3]))
from worker.app.team_map import (
    ODDS_NAME_TO_ABBR,
    MLB_STATS_TEAM_ID,
    PARK_RUN_FACTOR,
    PARK_HR_FACTOR,
    DOME_PARKS,
    compute_wind_to_cf,
    odds_name_to_abbr,
)
from worker.models.pipelines.load_historical_odds import load_all_seasons

DATA_DIR = Path(__file__).parents[3] / "data" / "training"


# ---------------------------------------------------------------------------
# Invert MLB Stats team ID → abbreviation for joining
# ---------------------------------------------------------------------------
MLB_ID_TO_ABBR: dict[int, str] = {v: k for k, v in MLB_STATS_TEAM_ID.items()}


def mlb_team_name_to_abbr(name: str) -> str | None:
    """MLB Stats API team names differ slightly from Odds API. Normalize."""
    # Try direct Odds API mapping first
    abbr = ODDS_NAME_TO_ABBR.get(name)
    if abbr:
        return abbr
    # Partial match fallbacks
    fallbacks = {
        "D-backs": "ARI",
        "Diamondbacks": "ARI",
        "Indians": "CLE",
        "Guardians": "CLE",
        "Athletics": "OAK",
    }
    for fragment, abbr in fallbacks.items():
        if fragment in name:
            return abbr
    return None


# ---------------------------------------------------------------------------
# Rolling pitcher stats (leakage-safe)
# ---------------------------------------------------------------------------

def _ip_to_float(ip_val) -> float:
    """Convert innings pitched (e.g., '6.1' = 6 + 1/3) to float innings."""
    try:
        ip = float(ip_val)
        full = int(ip)
        partial = ip - full
        return full + partial * (10 / 3)
    except (TypeError, ValueError):
        return 0.0


def _compute_era(earned_runs: float, ip: float) -> float:
    if ip < 0.01:
        return 6.50  # impute league-average+ for zero IP
    return (earned_runs / ip) * 9.0


def _compute_fip(hr: float, bb: float, k: float, ip: float) -> float:
    """FIP = ((13*HR + 3*BB - 2*K) / IP) + 3.10 (league-avg constant)."""
    if ip < 0.01:
        return 4.50
    return ((13 * hr + 3 * bb - 2 * k) / ip) + 3.10


def build_pitcher_rolling_stats(pitcher_logs: pd.DataFrame, schedule: pd.DataFrame) -> pd.DataFrame:
    """
    For each game row in schedule, compute rolling pitcher stats for both
    home_sp_id and away_sp_id using only data from BEFORE game_date.

    Returns enriched schedule DataFrame with pitcher feature columns.
    """
    if pitcher_logs.empty:
        return schedule

    # Starters only
    starters = pitcher_logs[pitcher_logs["is_starter"] == True].copy()
    starters["game_date"] = pd.to_datetime(starters["game_date"])
    starters["ip_float"] = starters["ip"].apply(_ip_to_float)

    schedule = schedule.copy()
    schedule["game_date_dt"] = pd.to_datetime(schedule["game_date"])

    sp_feature_cols = {
        "era_season": 4.50,
        "era_last_30d": 4.50,
        "era_last_10d": 4.50,
        "fip_season": 4.50,
        "k9_season": 7.5,
        "bb9_season": 3.2,
        "hr9_season": 1.2,
        "whip_season": 1.30,
        "days_rest": 4,
        "ip_last_start": 5.0,
    }

    for side in ("home", "away"):
        sp_col = f"{side}_sp_id"
        prefix = f"{side}_sp"

        for feat, default in sp_feature_cols.items():
            schedule[f"{prefix}_{feat}"] = default

        for idx, row in schedule.iterrows():
            sp_id = row.get(sp_col)
            game_date = row["game_date_dt"]
            if pd.isna(sp_id):
                continue

            sp_logs = starters[
                (starters["pitcher_id"] == sp_id) &
                (starters["game_date"] < game_date)
            ].sort_values("game_date")

            if sp_logs.empty:
                continue

            # Days rest
            last_game = sp_logs.iloc[-1]["game_date"]
            days_rest = (game_date - last_game).days
            schedule.at[idx, f"{prefix}_days_rest"] = min(days_rest, 7)

            # IP last start
            schedule.at[idx, f"{prefix}_ip_last_start"] = float(sp_logs.iloc[-1]["ip_float"])

            # Season stats (all prior starts this season)
            season_logs = sp_logs[sp_logs["game_date"].dt.year == game_date.year]
            if not season_logs.empty:
                ip_s = season_logs["ip_float"].sum()
                er_s = season_logs["earned_runs"].sum()
                hr_s = season_logs["hr"].sum()
                bb_s = season_logs["bb"].sum()
                k_s = season_logs["k"].sum()
                h_s = season_logs["hits"].sum()
                schedule.at[idx, f"{prefix}_era_season"] = _compute_era(er_s, ip_s)
                schedule.at[idx, f"{prefix}_fip_season"] = _compute_fip(hr_s, bb_s, k_s, ip_s)
                schedule.at[idx, f"{prefix}_k9_season"] = (k_s / ip_s * 9) if ip_s > 0 else 7.5
                schedule.at[idx, f"{prefix}_bb9_season"] = (bb_s / ip_s * 9) if ip_s > 0 else 3.2
                schedule.at[idx, f"{prefix}_hr9_season"] = (hr_s / ip_s * 9) if ip_s > 0 else 1.2
                schedule.at[idx, f"{prefix}_whip_season"] = ((h_s + bb_s) / ip_s) if ip_s > 0 else 1.30

            # 30-day rolling
            cutoff_30 = game_date - pd.Timedelta(days=30)
            logs_30 = sp_logs[sp_logs["game_date"] >= cutoff_30]
            if not logs_30.empty:
                ip_30 = logs_30["ip_float"].sum()
                er_30 = logs_30["earned_runs"].sum()
                schedule.at[idx, f"{prefix}_era_last_30d"] = _compute_era(er_30, ip_30)
            else:
                schedule.at[idx, f"{prefix}_era_last_30d"] = schedule.at[idx, f"{prefix}_era_season"]

            # 10-day rolling
            cutoff_10 = game_date - pd.Timedelta(days=10)
            logs_10 = sp_logs[sp_logs["game_date"] >= cutoff_10]
            if not logs_10.empty:
                ip_10 = logs_10["ip_float"].sum()
                er_10 = logs_10["earned_runs"].sum()
                schedule.at[idx, f"{prefix}_era_last_10d"] = _compute_era(er_10, ip_10)
            else:
                schedule.at[idx, f"{prefix}_era_last_10d"] = schedule.at[idx, f"{prefix}_era_last_30d"]

    return schedule


def build_bullpen_features(bullpen_logs: pd.DataFrame, schedule: pd.DataFrame) -> pd.DataFrame:
    """Compute rolling bullpen ERA and IP load for each game."""
    if bullpen_logs.empty:
        return schedule

    bullpen_logs = bullpen_logs.copy()
    bullpen_logs["game_date"] = pd.to_datetime(bullpen_logs["game_date"])
    bullpen_logs["ip_float"] = bullpen_logs["ip"].apply(_ip_to_float)

    schedule = schedule.copy()
    schedule["game_date_dt"] = pd.to_datetime(schedule["game_date"])

    for side in ("home", "away"):
        team_id_col = f"{side}_team_id"
        prefix = f"{side}_bp"

        for feat, default in [
            ("era_season", 4.50),
            ("era_last_7d", 4.50),
            ("ip_last_2d", 0.0),
            ("ip_last_3d", 0.0),
            ("whip_last_7d", 1.30),
        ]:
            schedule[f"{prefix}_{feat}"] = default

        for idx, row in schedule.iterrows():
            team_id = row.get(team_id_col)
            game_date = row["game_date_dt"]
            if pd.isna(team_id):
                continue

            team_abbr = MLB_ID_TO_ABBR.get(int(team_id))
            if not team_abbr:
                continue

            # Match bullpen logs by team side and date
            bp = bullpen_logs[
                (bullpen_logs.get("team_side", pd.Series()) == side) |
                (bullpen_logs.get("team_id") == team_id)
            ] if "team_id" in bullpen_logs.columns else bullpen_logs[
                bullpen_logs.get("team_side", pd.Series()) == side
            ]

            bp_prior = bp[bp["game_date"] < game_date]
            if bp_prior.empty:
                continue

            # Season ERA
            season_bp = bp_prior[bp_prior["game_date"].dt.year == game_date.year]
            if not season_bp.empty:
                ip_s = season_bp["ip_float"].sum()
                er_s = season_bp["earned_runs"].sum()
                h_s = season_bp["hits"].sum()
                bb_s = season_bp["bb"].sum()
                schedule.at[idx, f"{prefix}_era_season"] = _compute_era(er_s, ip_s)
                schedule.at[idx, f"{prefix}_whip_last_7d"] = ((h_s + bb_s) / ip_s) if ip_s > 0 else 1.30

            # 7-day ERA and WHIP
            cutoff_7 = game_date - pd.Timedelta(days=7)
            bp_7 = bp_prior[bp_prior["game_date"] >= cutoff_7]
            if not bp_7.empty:
                ip_7 = bp_7["ip_float"].sum()
                er_7 = bp_7["earned_runs"].sum()
                h_7 = bp_7["hits"].sum()
                bb_7 = bp_7["bb"].sum()
                schedule.at[idx, f"{prefix}_era_last_7d"] = _compute_era(er_7, ip_7)
                schedule.at[idx, f"{prefix}_whip_last_7d"] = ((h_7 + bb_7) / ip_7) if ip_7 > 0 else 1.30

            # IP last 2 days (fatigue)
            cutoff_2 = game_date - pd.Timedelta(days=2)
            bp_2 = bp_prior[bp_prior["game_date"] >= cutoff_2]
            schedule.at[idx, f"{prefix}_ip_last_2d"] = bp_2["ip_float"].sum() if not bp_2.empty else 0.0

            # IP last 3 days
            cutoff_3 = game_date - pd.Timedelta(days=3)
            bp_3 = bp_prior[bp_prior["game_date"] >= cutoff_3]
            schedule.at[idx, f"{prefix}_ip_last_3d"] = bp_3["ip_float"].sum() if not bp_3.empty else 0.0

    return schedule


def build_team_offense_features(team_batting: pd.DataFrame, schedule: pd.DataFrame) -> pd.DataFrame:
    """Compute rolling team offensive stats (OPS, runs/game, K%, BB%)."""
    if team_batting.empty:
        return schedule

    team_batting = team_batting.copy()
    team_batting["game_date"] = pd.to_datetime(team_batting["game_date"])

    # OPS = OBP + SLG
    # OBP = (H + BB) / (AB + BB)
    # SLG = (1B + 2*2B + 3*3B + 4*HR) / AB
    def compute_team_ops(df: pd.DataFrame) -> float:
        ab = df["ab"].sum()
        hits = df["hits"].sum()
        bb = df["bb"].sum()
        doubles = df["doubles"].sum()
        triples = df["triples"].sum()
        hr = df["hr"].sum()
        singles = hits - doubles - triples - hr
        if ab + bb == 0:
            return 0.720
        obp = (hits + bb) / (ab + bb)
        slg = ((singles + 2 * doubles + 3 * triples + 4 * hr) / ab) if ab > 0 else 0.0
        return obp + slg

    schedule = schedule.copy()
    schedule["game_date_dt"] = pd.to_datetime(schedule["game_date"])

    for side in ("home", "away"):
        team_id_col = f"{side}_team_id"
        prefix = f"{side}_team"

        defaults = {
            "ops_season": 0.720,
            "ops_last_14d": 0.720,
            "runs_pg_season": 4.5,
            "runs_pg_last_14d": 4.5,
            "k_rate_season": 0.220,
            "bb_rate_season": 0.085,
            "batting_avg_season": 0.250,
            "woba_season": 0.320,
            "hr_pg_season": 1.1,
            "iso_season": 0.150,
            "run_margin_avg": 0.0,
            "blowout_rate": 0.30,
            "one_run_game_rate": 0.28,
        }
        for feat, default in defaults.items():
            schedule[f"{prefix}_{feat}"] = default

        for idx, row in schedule.iterrows():
            team_id = row.get(team_id_col)
            game_date = row["game_date_dt"]
            if pd.isna(team_id):
                continue

            tb_prior = team_batting[
                (team_batting["game_date"] < game_date) &
                (team_batting.get("team_side", pd.Series()) == side)
            ] if "team_side" in team_batting.columns else team_batting[
                team_batting["game_date"] < game_date
            ]

            tb_season = tb_prior[tb_prior["game_date"].dt.year == game_date.year]
            if tb_season.empty:
                continue

            ab_s = tb_season["ab"].sum()
            k_s = tb_season["k"].sum()
            bb_s = tb_season["bb"].sum()
            hr_s = tb_season["hr"].sum()

            schedule.at[idx, f"{prefix}_ops_season"] = compute_team_ops(tb_season)
            schedule.at[idx, f"{prefix}_runs_pg_season"] = (
                tb_season["score"].sum() / len(tb_season)
            ) if len(tb_season) > 0 else 4.5
            schedule.at[idx, f"{prefix}_k_rate_season"] = (k_s / ab_s) if ab_s > 0 else 0.220
            schedule.at[idx, f"{prefix}_bb_rate_season"] = (bb_s / (ab_s + bb_s)) if (ab_s + bb_s) > 0 else 0.085
            schedule.at[idx, f"{prefix}_batting_avg_season"] = (tb_season["hits"].sum() / ab_s) if ab_s > 0 else 0.250
            schedule.at[idx, f"{prefix}_hr_pg_season"] = (hr_s / len(tb_season)) if len(tb_season) > 0 else 1.1

            # ISO = SLG - AVG
            slg_numerator = (
                (tb_season["hits"].sum() - tb_season["doubles"].sum() - tb_season["triples"].sum() - hr_s) +
                2 * tb_season["doubles"].sum() +
                3 * tb_season["triples"].sum() +
                4 * hr_s
            )
            slg = (slg_numerator / ab_s) if ab_s > 0 else 0.380
            avg = schedule.at[idx, f"{prefix}_batting_avg_season"]
            schedule.at[idx, f"{prefix}_iso_season"] = max(0.0, slg - avg)

            # 14-day rolling
            cutoff_14 = game_date - pd.Timedelta(days=14)
            tb_14 = tb_prior[tb_prior["game_date"] >= cutoff_14]
            if not tb_14.empty:
                schedule.at[idx, f"{prefix}_ops_last_14d"] = compute_team_ops(tb_14)
                schedule.at[idx, f"{prefix}_runs_pg_last_14d"] = (
                    tb_14["score"].sum() / len(tb_14)
                )

    return schedule


def build_team_record_features(schedule: pd.DataFrame) -> pd.DataFrame:
    """Compute win%, Pythagorean win%, run differential, last-10 form."""
    schedule = schedule.copy()
    schedule["game_date_dt"] = pd.to_datetime(schedule["game_date"])
    schedule["home_win"] = (schedule["home_score"] > schedule["away_score"]).astype(int)

    for col, default in [
        ("home_team_win_pct_season", 0.500),
        ("home_team_win_pct_home", 0.533),
        ("home_team_last10_win_pct", 0.500),
        ("home_team_run_diff_pg", 0.0),
        ("home_team_pythag_win_pct", 0.500),
        ("away_team_win_pct_season", 0.500),
        ("away_team_win_pct_away", 0.467),
        ("away_team_last10_win_pct", 0.500),
        ("away_team_run_diff_pg", 0.0),
        ("away_team_pythag_win_pct", 0.500),
        ("home_team_days_rest", 1),
        ("away_team_days_rest", 1),
        ("home_team_ats_home_win_pct", 0.500),
        ("away_team_ats_road_win_pct", 0.500),
        ("home_team_rl_last10_cover_pct", 0.500),
        ("home_team_run_margin_avg", 0.0),
        ("away_team_run_margin_avg", 0.0),
        ("home_team_blowout_rate", 0.30),
        ("away_team_blowout_rate", 0.30),
        ("home_team_one_run_game_rate", 0.28),
        ("away_team_one_run_game_rate", 0.28),
        ("home_team_ou_over_rate_season", 0.50),
        ("away_team_ou_over_rate_season", 0.50),
    ]:
        schedule[col] = default

    # Work through games chronologically per team
    for idx, row in schedule.iterrows():
        game_date = row["game_date_dt"]
        home_id = row.get("home_team_id")
        away_id = row.get("away_team_id")
        season = row.get("season", game_date.year)

        prior = schedule[
            (schedule["game_date_dt"] < game_date) &
            (schedule["season"] == season)
        ]

        for side, team_id in [("home", home_id), ("away", away_id)]:
            prefix = f"{side}_team"

            # Games where this team played (home or away)
            team_games = prior[
                (prior["home_team_id"] == team_id) |
                (prior["away_team_id"] == team_id)
            ]

            if team_games.empty:
                continue

            # Win/loss for this team
            is_home_game = team_games["home_team_id"] == team_id
            team_wins = (
                (is_home_game & (team_games["home_score"] > team_games["away_score"])) |
                (~is_home_game & (team_games["away_score"] > team_games["home_score"]))
            )
            team_rs = np.where(is_home_game, team_games["home_score"], team_games["away_score"])
            team_ra = np.where(is_home_game, team_games["away_score"], team_games["home_score"])

            n_games = len(team_games)
            n_wins = team_wins.sum()

            schedule.at[idx, f"{prefix}_win_pct_season"] = n_wins / n_games

            # Home/away split win%
            side_games = team_games[is_home_game] if side == "home" else team_games[~is_home_game]
            if not side_games.empty:
                side_is_home = side_games["home_team_id"] == team_id
                side_wins = (
                    (side_is_home & (side_games["home_score"] > side_games["away_score"])) |
                    (~side_is_home & (side_games["away_score"] > side_games["home_score"]))
                )
                win_pct_col = f"{prefix}_win_pct_home" if side == "home" else f"{prefix}_win_pct_away"
                schedule.at[idx, win_pct_col] = side_wins.mean()

            # Last 10
            last10 = team_games.tail(10)
            if not last10.empty:
                is_home_l10 = last10["home_team_id"] == team_id
                l10_wins = (
                    (is_home_l10 & (last10["home_score"] > last10["away_score"])) |
                    (~is_home_l10 & (last10["away_score"] > last10["home_score"]))
                )
                schedule.at[idx, f"{prefix}_last10_win_pct"] = l10_wins.mean()

            # Run differential
            rd = (team_rs - team_ra).mean() if n_games > 0 else 0.0
            schedule.at[idx, f"{prefix}_run_diff_pg"] = rd

            # Pythagorean win% (RS² / (RS² + RA²))
            rs_total = float(sum(team_rs))
            ra_total = float(sum(team_ra))
            if rs_total + ra_total > 0:
                pythag = (rs_total ** 2) / (rs_total ** 2 + ra_total ** 2)
                schedule.at[idx, f"{prefix}_pythag_win_pct"] = pythag

            # Days rest
            date_col = "game_date_dt"
            team_game_dates = team_games[date_col].sort_values()
            if not team_game_dates.empty:
                last_game_date = team_game_dates.iloc[-1]
                days_rest = (game_date - last_game_date).days
                rest_col = f"{side}_team_days_rest"
                schedule.at[idx, rest_col] = min(days_rest, 4)

            # Blowout rate and one-run game rate
            margins = abs(team_rs - team_ra)
            schedule.at[idx, f"{prefix}_blowout_rate"] = (margins >= 3).mean()
            schedule.at[idx, f"{prefix}_one_run_game_rate"] = (margins == 1).mean()

            # Run margin avg (wins only)
            win_mask = team_wins.values
            win_margins = (team_rs - team_ra)[win_mask]
            schedule.at[idx, f"{prefix}_run_margin_avg"] = win_margins.mean() if len(win_margins) > 0 else 0.0

    return schedule


def add_park_features(schedule: pd.DataFrame) -> pd.DataFrame:
    """Add park factor columns from static lookup."""
    schedule = schedule.copy()

    home_abbrs = schedule["home_team_abbr"] if "home_team_abbr" in schedule.columns else schedule["home_team_id"].map(MLB_ID_TO_ABBR)

    schedule["park_run_factor"] = home_abbrs.map(PARK_RUN_FACTOR).fillna(100).astype(int)
    schedule["park_hr_factor"] = home_abbrs.map(PARK_HR_FACTOR).fillna(100).astype(int)
    schedule["park_is_dome"] = home_abbrs.isin(DOME_PARKS).astype(int)

    return schedule


def add_market_features(schedule: pd.DataFrame, odds_df: pd.DataFrame) -> pd.DataFrame:
    """
    Join odds onto schedule. Computes:
    - market_implied_prob_home (moneyline)
    - line_move_direction
    - posted_total_line
    - implied_over_probability
    - total_line_move_direction
    - run line odds columns
    """
    schedule = schedule.copy()

    # Default values
    schedule["market_implied_prob_home"] = 0.500
    schedule["line_move_direction"] = 0
    schedule["posted_total_line"] = 8.5
    schedule["implied_over_probability"] = 0.500
    schedule["total_line_move_direction"] = 0
    schedule["dk_ml_home"] = -110
    schedule["fd_ml_home"] = -110
    schedule["dk_ml_away"] = -110
    schedule["fd_ml_away"] = -110
    schedule["dk_rl_home_price"] = -110
    schedule["dk_rl_home_point"] = -1.5
    schedule["fd_rl_home_price"] = -110
    schedule["fd_rl_home_point"] = -1.5
    # Away run-line prices: needed for bidirectional EV computation in ROI simulator
    schedule["dk_rl_away_price"] = -110
    schedule["dk_rl_away_point"] = 1.5
    schedule["fd_rl_away_price"] = -110
    schedule["fd_rl_away_point"] = 1.5
    schedule["dk_over_price"] = -110
    schedule["dk_over_point"] = 8.5
    schedule["fd_over_price"] = -110
    schedule["fd_over_point"] = 8.5
    # Under price: needed for bidirectional EV computation in ROI simulator
    schedule["dk_under_price"] = -110
    schedule["fd_under_price"] = -110

    if odds_df.empty:
        return schedule

    # Ensure home/away team columns exist
    if "home_team_abbr" not in schedule.columns:
        schedule["home_team_abbr"] = schedule["home_team_id"].map(MLB_ID_TO_ABBR)
    if "away_team_abbr" not in schedule.columns:
        schedule["away_team_abbr"] = schedule["away_team_id"].map(MLB_ID_TO_ABBR)

    # Join odds on (home_team, away_team, game_date)
    odds_df = odds_df.rename(columns={"home_team": "odds_home", "away_team": "odds_away"})

    merged = schedule.merge(
        odds_df,
        left_on=["home_team_abbr", "away_team_abbr", "game_date"],
        right_on=["odds_home", "odds_away", "game_date"],
        how="left",
        suffixes=("", "_odds"),
    )

    def american_to_implied(odds_val) -> float:
        if pd.isna(odds_val):
            return 0.500
        o = float(odds_val)
        if o > 0:
            return 100.0 / (100.0 + o)
        else:
            return abs(o) / (abs(o) + 100.0)

    # Best ML home implied probability
    dk_imp = merged["dk_ml_home_odds"].apply(american_to_implied) if "dk_ml_home_odds" in merged.columns else merged["dk_ml_home"].apply(american_to_implied)
    fd_imp = merged["fd_ml_home_odds"].apply(american_to_implied) if "fd_ml_home_odds" in merged.columns else merged["fd_ml_home"].apply(american_to_implied)

    # Use the better (more favorable home) line
    merged["market_implied_prob_home"] = (dk_imp + fd_imp) / 2

    # Totals
    total_col = "dk_over_point"
    if "dk_over_point_odds" in merged.columns:
        total_col = "dk_over_point_odds"
    merged["posted_total_line"] = merged[total_col].fillna(8.5)

    # Copy odds columns back to schedule.
    # Away RL and under prices are EV-computation-only; not model features.
    odds_passthrough_cols = [
        "dk_ml_home", "fd_ml_home", "dk_ml_away", "fd_ml_away",
        "dk_rl_home_price", "dk_rl_home_point", "fd_rl_home_price", "fd_rl_home_point",
        "dk_rl_away_price", "dk_rl_away_point", "fd_rl_away_price", "fd_rl_away_point",
        "dk_over_price", "dk_over_point", "fd_over_price", "fd_over_point",
        "dk_under_price", "fd_under_price",
    ]

    for c in odds_passthrough_cols:
        src = f"{c}_odds" if f"{c}_odds" in merged.columns else c
        if src in merged.columns:
            schedule[c] = merged[src].values

    schedule["market_implied_prob_home"] = merged["market_implied_prob_home"].values
    schedule["posted_total_line"] = merged["posted_total_line"].values
    schedule["implied_over_probability"] = 0.500  # updated below if over price available

    # Implied over probability from best price
    for price_col in ["dk_over_price", "fd_over_price"]:
        src = f"{price_col}_odds" if f"{price_col}_odds" in merged.columns else price_col
        if src in merged.columns:
            imp = merged[src].apply(american_to_implied)
            schedule["implied_over_probability"] = np.maximum(
                schedule["implied_over_probability"].values,
                imp.values
            )

    return schedule


def add_derived_run_line_features(schedule: pd.DataFrame) -> pd.DataFrame:
    """Add run-line-specific derived features."""
    schedule = schedule.copy()

    # Pitcher quality gap features
    schedule["sp_fip_gap"] = schedule["home_sp_fip_season"] - schedule["away_sp_fip_season"]
    schedule["sp_era_last_30d_gap"] = schedule["home_sp_era_last_30d"] - schedule["away_sp_era_last_30d"]
    schedule["sp_k9_gap"] = schedule["home_sp_k9_season"] - schedule["away_sp_k9_season"]

    # Moneyline implied run-line probability (Bradley-Terry approximation)
    # P(cover -1.5) ≈ P(win)^1.5 / (P(win)^1.5 + P(lose)^1.5) — rough proxy
    p = schedule["market_implied_prob_home"].clip(0.01, 0.99)
    schedule["moneyline_implied_run_line_prob"] = (p ** 1.5) / (p ** 1.5 + (1 - p) ** 1.5)

    # ATS historical (placeholder — set to neutral; will be enriched from actual outcomes)
    if "home_team_ats_home_win_pct" not in schedule.columns:
        schedule["home_team_ats_home_win_pct"] = 0.500
    if "away_team_ats_road_win_pct" not in schedule.columns:
        schedule["away_team_ats_road_win_pct"] = 0.500
    if "home_team_rl_last10_cover_pct" not in schedule.columns:
        schedule["home_team_rl_last10_cover_pct"] = 0.500

    return schedule


def add_combined_totals_features(schedule: pd.DataFrame) -> pd.DataFrame:
    """Add combined pitcher/offense composite features for totals model."""
    schedule = schedule.copy()
    schedule["combined_sp_era_season"] = schedule["home_sp_era_season"] + schedule["away_sp_era_season"]
    schedule["combined_sp_fip_season"] = schedule["home_sp_fip_season"] + schedule["away_sp_fip_season"]
    schedule["combined_sp_k9_season"] = schedule["home_sp_k9_season"] + schedule["away_sp_k9_season"]
    schedule["combined_sp_bb9_season"] = schedule["home_sp_bb9_season"] + schedule["away_sp_bb9_season"]
    schedule["combined_ops_season"] = schedule["home_team_ops_season"] + schedule["away_team_ops_season"]
    schedule["combined_runs_pg_season"] = schedule["home_team_runs_pg_season"] + schedule["away_team_runs_pg_season"]
    schedule["combined_hr_pg_season"] = schedule["home_team_hr_pg_season"] + schedule["away_team_hr_pg_season"]
    return schedule


def add_target_variables(schedule: pd.DataFrame) -> pd.DataFrame:
    """
    Add binary target variables (leakage-safe — uses only final game scores):
    - home_win: 1 if home team won
    - home_covers_run_line: 1 if home wins by 2+
    - over_hits: 1 if total runs > posted_total_line, None if push
    """
    schedule = schedule.copy()

    schedule["home_win"] = (schedule["home_score"] > schedule["away_score"]).astype(int)

    run_margin = schedule["home_score"] - schedule["away_score"]
    schedule["home_covers_run_line"] = (run_margin >= 2).astype(int)

    total_runs = schedule["home_score"] + schedule["away_score"]
    total_line = schedule["posted_total_line"].fillna(8.5)

    over_hits = []
    for tr, tl in zip(total_runs, total_line):
        if tr > tl:
            over_hits.append(1)
        elif tr < tl:
            over_hits.append(0)
        else:
            over_hits.append(None)  # push — exclude from totals training
    schedule["over_hits"] = over_hits

    return schedule


def build_training_dataset(
    mlb_schedule_path: Path,
    pitcher_logs_path: Path,
    bullpen_path: Path,
    team_batting_path: Path,
    years: list[int] | None = None,
) -> pd.DataFrame:
    """
    Full feature engineering pipeline. Loads raw data, joins odds, builds
    all features per spec. Returns training-ready DataFrame.
    """
    if years is None:
        years = [2022, 2023, 2024]

    print("Loading schedule...")
    schedule = pd.read_parquet(mlb_schedule_path)
    schedule = schedule[schedule["season"].isin(years)].copy()

    # Normalize team names from MLB Stats API
    schedule["home_team_abbr"] = schedule["home_team_name"].apply(mlb_team_name_to_abbr)
    schedule["away_team_abbr"] = schedule["away_team_name"].apply(mlb_team_name_to_abbr)

    # Drop rows where team name mapping failed
    schedule = schedule.dropna(subset=["home_team_abbr", "away_team_abbr"])
    print(f"  Schedule rows: {len(schedule)}")

    print("Loading odds...")
    odds_df = load_all_seasons(years)
    print(f"  Odds rows: {len(odds_df)}")

    print("Loading pitcher logs...")
    pitcher_logs = pd.read_parquet(pitcher_logs_path) if pitcher_logs_path.exists() else pd.DataFrame()

    print("Loading bullpen logs...")
    bullpen_logs = pd.read_parquet(bullpen_path) if bullpen_path.exists() else pd.DataFrame()

    print("Loading team batting...")
    team_batting = pd.read_parquet(team_batting_path) if team_batting_path.exists() else pd.DataFrame()

    print("Building pitcher rolling stats...")
    schedule = build_pitcher_rolling_stats(pitcher_logs, schedule)

    print("Building bullpen features...")
    schedule = build_bullpen_features(bullpen_logs, schedule)

    print("Building team offense features...")
    schedule = build_team_offense_features(team_batting, schedule)

    print("Building team record features...")
    schedule = build_team_record_features(schedule)

    print("Adding park features...")
    schedule = add_park_features(schedule)

    print("Adding weather features (imputed)...")
    # Weather columns: impute at average if not available
    if "weather_temp_f" not in schedule.columns:
        schedule["weather_temp_f"] = 72.0
    if "weather_wind_mph" not in schedule.columns:
        schedule["weather_wind_mph"] = 5.0
    if "weather_wind_to_cf" not in schedule.columns:
        schedule["weather_wind_to_cf"] = 0.0
    schedule["weather_wind_factor"] = schedule["weather_wind_mph"] * schedule["weather_wind_to_cf"]
    schedule["weather_temp_deviation_from_avg"] = 0.0
    schedule["weather_is_dome"] = schedule["park_is_dome"]
    schedule["game_is_doubleheader"] = 0

    print("Adding market features...")
    schedule = add_market_features(schedule, odds_df)

    print("Adding SP confirmation flags...")
    schedule["home_sp_is_confirmed"] = (schedule["home_sp_id"].notna()).astype(int)
    schedule["away_sp_is_confirmed"] = (schedule["away_sp_id"].notna()).astype(int)
    schedule["home_sp_throws"] = 1  # impute right-handed for v1 (handedness DB gap)
    schedule["away_sp_throws"] = 1

    print("Adding derived features...")
    schedule = add_derived_run_line_features(schedule)
    schedule = add_combined_totals_features(schedule)

    # Historical over/under rate per team (season)
    schedule["home_team_ou_over_rate_season"] = 0.50
    schedule["away_team_ou_over_rate_season"] = 0.50
    schedule["h2h_avg_total_scored_season"] = (
        schedule["home_team_runs_pg_season"] + schedule["away_team_runs_pg_season"]
    )
    schedule["park_historical_ou_over_rate"] = 0.50
    schedule["park_avg_total_scored"] = 8.5
    schedule["away_team_travel_tz_change"] = 0
    schedule["home_lineup_confirmed"] = 1
    schedule["home_platoon_advantage"] = 0.5
    schedule["away_platoon_advantage"] = 0.5

    # Umpire features (data gap — impute league average, flag as unconfirmed)
    schedule["ump_k_rate_career"] = 0.218
    schedule["ump_run_factor"] = 1.0
    schedule["ump_assigned"] = 0

    print("Adding target variables...")
    schedule = add_target_variables(schedule)

    # Final data hash for manifest
    data_hash = hashlib.md5(
        pd.util.hash_pandas_object(schedule[["game_pk", "game_date", "home_team_abbr"]]).values
    ).hexdigest()[:12]
    schedule["_data_hash"] = data_hash

    return schedule


def main():
    schedule_path = DATA_DIR / "mlb_schedule_raw.parquet"
    pitcher_path = DATA_DIR / "pitcher_logs_raw.parquet"
    bullpen_path = DATA_DIR / "bullpen_raw.parquet"
    team_batting_path = DATA_DIR / "team_batting_raw.parquet"

    if not schedule_path.exists():
        print("ERROR: Schedule data not found. Run pull_mlb_stats.py first.")
        return

    df = build_training_dataset(
        schedule_path, pitcher_path, bullpen_path, team_batting_path
    )

    out_path = DATA_DIR / "games_v1.parquet"
    df.to_parquet(out_path, index=False)
    print(f"\nSaved {len(df)} rows to {out_path}")
    print(f"Columns: {list(df.columns)}")


if __name__ == "__main__":
    main()
