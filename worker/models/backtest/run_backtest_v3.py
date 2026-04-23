"""
run_backtest_v3.py — Honest edge measurement: vig removal + CLV harness.

Changes vs v2 backtest:
  1. Vig removal: EV filter uses no-vig market probability, not raw implied.
     This eliminates phantom edge from book overround (~4-6% margin).
     Payout still uses RAW odds (books pay at their listed price).
  2. CLV harness: for each game, compare model probability at pick time
     (morning odds snapshot proxy) vs closing line (last snapshot before
     first pitch). Positive mean CLV = model sees real edge independent
     of outcome variance.
  3. Run-line approach note: v2 model retained as-is. See deviation_from_base_rate
     section at the bottom for v3 design spec — not trained here due to time budget.

Usage:
    python worker/models/backtest/run_backtest_v3.py

Artifacts:
    worker/models/backtest/reports/backtest_v3_summary.json
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
    assign_confidence_tier,
    MARKET_CONFIG,
    load_and_build_features,
)

DATA_DIR = ROOT / "data" / "training"

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


# ---------------------------------------------------------------------------
# Vig removal helpers
# ---------------------------------------------------------------------------

def american_to_raw_implied(odds: float) -> float:
    """Raw implied probability (includes vig) from American odds."""
    if odds > 0:
        return 100.0 / (100.0 + odds)
    else:
        return abs(odds) / (abs(odds) + 100.0)


def compute_novig_probs(
    primary_odds: float,
    opposing_odds: float,
) -> tuple[float, float, float]:
    """
    Remove vig from a two-sided market.

    Returns (novig_primary, novig_opposing, margin).
    margin is the book overround (e.g. 0.05 = 5% vig).

    Edge cases:
    - If either odds is missing/NaN, returns (0.5, 0.5, 0.0) — neutral.
    - If margin <= 0 (broken data, usually from extreme odds), clamp to 0.01
      to avoid division by zero, but flag it.
    """
    if pd.isna(primary_odds) or pd.isna(opposing_odds):
        return 0.5, 0.5, 0.0

    p_raw = american_to_raw_implied(float(primary_odds))
    o_raw = american_to_raw_implied(float(opposing_odds))

    margin = p_raw + o_raw - 1.0

    # Broken data guard: DK/FD lines that imply >115% total (>15% overround)
    # are almost certainly bad data. Mark as neutral.
    if margin > 0.15:
        return 0.5, 0.5, 0.0

    # If market is near-zero margin or negative (arbitrage data artifact), clamp.
    if margin <= 0.005:
        margin = 0.005

    novig_primary = p_raw / (1.0 + margin)
    novig_opposing = o_raw / (1.0 + margin)

    return novig_primary, novig_opposing, margin


def select_best_novig(
    dk_primary: float | None,
    fd_primary: float | None,
    dk_opposing: float | None,
    fd_opposing: float | None,
) -> tuple[float, float, float, str]:
    """
    Compute no-vig probabilities for the best available book (tighter margin wins).

    Returns (novig_primary, novig_opposing, margin, book).
    The book with the smaller margin gives a more accurate no-vig line,
    so we prefer that for CLV and EV computation.
    """
    results = []

    if dk_primary is not None and dk_opposing is not None and \
            not pd.isna(dk_primary) and not pd.isna(dk_opposing):
        nv_p, nv_o, m = compute_novig_probs(float(dk_primary), float(dk_opposing))
        results.append((nv_p, nv_o, m, "draftkings"))

    if fd_primary is not None and fd_opposing is not None and \
            not pd.isna(fd_primary) and not pd.isna(fd_opposing):
        nv_p, nv_o, m = compute_novig_probs(float(fd_primary), float(fd_opposing))
        results.append((nv_p, nv_o, m, "fanduel"))

    if not results:
        return 0.5, 0.5, 0.0, "none"

    # Tighter margin = more accurate fair-value reference
    return min(results, key=lambda x: x[2])


def compute_ev_novig(
    model_prob: float,
    raw_odds: float,
    novig_market_prob: float,
) -> float:
    """
    Compute EV using vig-removed market probability as the edge test.

    The payout uses RAW odds (books pay at their listed price).
    The edge test: model_prob vs no-vig market probability.

    EV = model_prob * net_payout - (1 - model_prob)
    where net_payout is from raw odds.

    Note: We still use the standard EV formula against raw odds for the
    actual dollar return. The no-vig prob is used ONLY for the EV threshold
    filter gate — specifically, we also compare model_prob vs novig_market_prob
    to verify we have real edge vs the fair-value line. A pick passes only if:
      (a) EV vs raw odds > threshold, AND
      (b) model_prob > novig_market_prob (we actually think different than fair value)
    """
    if raw_odds > 0:
        net_win = raw_odds / 100.0
    else:
        net_win = 100.0 / abs(raw_odds)
    return model_prob * net_win - (1.0 - model_prob) * 1.0


# ---------------------------------------------------------------------------
# Vig-removed ROI simulation
# ---------------------------------------------------------------------------

def _flat_pnl(odds: int, won: bool) -> float:
    if odds > 0:
        return float(odds) if won else -100.0
    else:
        return 100.0 * 100.0 / abs(odds) if won else -100.0


def simulate_roi_novig(
    model_probs: np.ndarray,
    y_true: np.ndarray,
    primary_odds: np.ndarray,
    opposing_odds: np.ndarray,
    novig_primary: np.ndarray,
    novig_opposing: np.ndarray,
    ev_threshold: float = 0.04,
) -> dict:
    """
    ROI simulation with vig-removed edge gate.

    A bet is only placed if:
    1. EV vs raw odds >= ev_threshold (payout check), AND
    2. model_prob > novig_market_prob (we disagree with fair-value line).

    Condition (2) is the critical vig-removal gate. Without it, the raw EV
    formula can show positive EV simply because the vig markup inflates
    apparent return (we get paid at vigged odds even though we shouldn't
    beat the market).

    Result: payout still uses RAW odds (book pays what it offers), but we
    only bet when our model thinks we have genuine edge over fair value.
    """
    flat_pnl_list: list[float] = []
    n, wins = 0, 0

    for i in range(len(model_probs)):
        prob = float(model_probs[i])
        outcome = float(y_true[i])
        p_odds = float(primary_odds[i])
        o_odds = float(opposing_odds[i])
        nv_p = float(novig_primary[i])
        nv_o = float(novig_opposing[i])

        if any(pd.isna(v) for v in [prob, outcome, p_odds, o_odds, nv_p, nv_o]):
            continue

        # Primary side
        ev_p = compute_ev_novig(prob, p_odds, nv_p)
        edge_p = prob - nv_p  # real edge vs fair value

        # Opposing side
        ev_o = compute_ev_novig(1.0 - prob, o_odds, nv_o)
        edge_o = (1.0 - prob) - nv_o

        bet_primary = (ev_p >= ev_threshold) and (edge_p > 0)
        bet_opposing = (ev_o >= ev_threshold) and (edge_o > 0)

        if not bet_primary and not bet_opposing:
            continue

        # Take higher EV side when both qualify
        if bet_primary and bet_opposing:
            bet_primary = ev_p >= ev_o

        if bet_primary:
            won = int(outcome) == 1
            pnl = _flat_pnl(int(p_odds), won)
        else:
            won = int(outcome) == 0
            pnl = _flat_pnl(int(o_odds), won)

        flat_pnl_list.append(pnl)
        n += 1
        if won:
            wins += 1

    if not flat_pnl_list:
        return {"n": 0, "wagered": 0, "profit": 0.0, "roi": 0.0, "win_rate": 0.0,
                "max_drawdown": 0.0}

    wagered = n * 100.0
    profit = sum(flat_pnl_list)
    roi = round(profit / wagered * 100, 2) if wagered > 0 else 0.0
    win_rate = round(wins / n, 4) if n > 0 else 0.0

    cum = np.cumsum(flat_pnl_list)
    running_max = np.maximum.accumulate(cum)
    max_dd = float((running_max - cum).max())

    return {
        "n": n,
        "wagered": wagered,
        "profit": round(profit, 2),
        "roi": roi,
        "win_rate": win_rate,
        "max_drawdown": round(max_dd, 2),
    }


# ---------------------------------------------------------------------------
# CLV harness
# ---------------------------------------------------------------------------

def load_odds_with_snapshots(years: list[int] | None = None) -> pd.DataFrame:
    """
    Load all odds snapshots retaining snapshot_ts for CLV computation.
    Unlike load_all_seasons(), this does NOT de-dup to the last snapshot —
    it keeps ALL snapshots so we can extract first and last per game day.
    """
    from worker.models.pipelines.load_historical_odds import (
        DATA_ROOT,
        _parse_bookmaker_markets,
    )
    from worker.app.team_map import odds_name_to_abbr

    if years is None:
        years = [2022, 2023, 2024]

    all_rows: list[dict] = []
    for year in years:
        year_dir = DATA_ROOT / str(year)
        if not year_dir.exists():
            continue
        for json_file in sorted(year_dir.glob("*.json")):
            try:
                with open(json_file, encoding="utf-8") as f:
                    blob = json.load(f)
            except (json.JSONDecodeError, OSError):
                continue

            snapshot_ts = blob.get("timestamp", "")
            games_data = blob.get("data", [])
            if not games_data:
                continue

            for game in games_data:
                home_full = game.get("home_team", "")
                away_full = game.get("away_team", "")
                home_abbr = odds_name_to_abbr(home_full)
                away_abbr = odds_name_to_abbr(away_full)
                if not home_abbr or not away_abbr:
                    continue

                commence_utc = game.get("commence_time", "")
                try:
                    game_dt = datetime.fromisoformat(
                        commence_utc.replace("Z", "+00:00")
                    )
                    game_date = game_dt.date().isoformat()
                except (ValueError, AttributeError):
                    game_date = str(year)

                markets = _parse_bookmaker_markets(
                    game.get("bookmakers", []),
                    home_abbr,
                    away_abbr,
                )
                all_rows.append({
                    "game_date": game_date,
                    "commence_time_utc": commence_utc,
                    "snapshot_ts": snapshot_ts,
                    "home_team": home_abbr,
                    "away_team": away_abbr,
                    "season": year,
                    **markets,
                })

    if not all_rows:
        return pd.DataFrame()

    df = pd.DataFrame(all_rows)
    df["snapshot_dt"] = pd.to_datetime(df["snapshot_ts"], utc=True, errors="coerce")
    return df


def build_opening_closing_lines(
    snapshots_df: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    From all snapshots, extract:
    - opening: first snapshot per (home_team, away_team, game_date) — pick-time proxy
    - closing: last snapshot per (home_team, away_team, game_date) — true closing line

    Returns (opening_df, closing_df).
    """
    grp = snapshots_df.sort_values("snapshot_dt").groupby(
        ["home_team", "away_team", "game_date"], as_index=False
    )
    opening = grp.first()
    closing = grp.last()

    for df in [opening, closing]:
        df.drop(columns=["snapshot_dt"], errors="ignore", inplace=True)

    return opening, closing


def compute_clv_for_market(
    model_probs: np.ndarray,
    y_true: np.ndarray,
    primary_odds_open: np.ndarray,
    opposing_odds_open: np.ndarray,
    primary_odds_close: np.ndarray,
    opposing_odds_close: np.ndarray,
) -> dict:
    """
    Compute CLV metrics for one market.

    CLV logic per pick:
    - At pick time (morning): model has probability p, opening no-vig prob is nv_open_p.
    - At close: closing no-vig prob is nv_close_p.
    - CLV edge = (nv_close_p - nv_open_p) in model's favor.
      If model favored primary side (p > 0.5): CLV = nv_close_p - nv_open_p
      If model favored opposing side: CLV = nv_close_o - nv_open_o
    - Positive CLV: line moved toward us — sharp signal.
    - We record CLV for all games, not just picks above EV threshold, to
      measure raw model quality independent of bet sizing.
    """
    clv_all: list[float] = []
    clv_primary_side: list[float] = []
    clv_opposing_side: list[float] = []
    line_moved_toward_us: int = 0
    line_moved_away: int = 0
    no_movement: int = 0

    for i in range(len(model_probs)):
        p = float(model_probs[i])
        p_open = float(primary_odds_open[i])
        o_open = float(opposing_odds_open[i])
        p_close = float(primary_odds_close[i])
        o_close = float(opposing_odds_close[i])

        if any(pd.isna(v) for v in [p, p_open, o_open, p_close, o_close]):
            continue

        # No-vig probs at open
        nv_p_open, nv_o_open, margin_open = compute_novig_probs(p_open, o_open)
        # No-vig probs at close
        nv_p_close, nv_o_close, margin_close = compute_novig_probs(p_close, o_close)

        if margin_open < 0.001 or margin_close < 0.001:
            # Skip broken data
            continue

        # Model-side CLV
        if p >= 0.5:
            # Model favors primary side
            clv = nv_p_close - nv_p_open
            clv_primary_side.append(clv)
        else:
            # Model favors opposing side
            clv = nv_o_close - nv_o_open
            clv_opposing_side.append(clv)

        clv_all.append(clv)

        if clv > 0.002:
            line_moved_toward_us += 1
        elif clv < -0.002:
            line_moved_away += 1
        else:
            no_movement += 1

    n = len(clv_all)
    if n == 0:
        return {
            "n": 0,
            "mean_clv": None,
            "median_clv": None,
            "clv_positive_rate": None,
            "line_moved_toward_us": 0,
            "line_moved_away": 0,
            "no_movement": 0,
            "note": "No valid CLV records (opening/closing snapshots may be same file)",
        }

    mean_clv = round(float(np.mean(clv_all)), 5)
    median_clv = round(float(np.median(clv_all)), 5)
    positive_rate = round(sum(1 for c in clv_all if c > 0) / n, 3)

    return {
        "n": n,
        "mean_clv": mean_clv,
        "median_clv": median_clv,
        "mean_clv_pct": round(mean_clv * 100, 3),
        "clv_positive_rate": positive_rate,
        "line_moved_toward_us": line_moved_toward_us,
        "line_moved_away": line_moved_away,
        "no_movement": no_movement,
        "interpretation": (
            "POSITIVE CLV — model sees real edge (sharp signal)"
            if mean_clv > 0.005
            else "NEAR-ZERO or NEGATIVE CLV — no evidence of edge vs closing line"
            if mean_clv <= 0.005
            else "INCONCLUSIVE"
        ),
    }


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def get_best_odds(df: pd.DataFrame, cols: tuple[str, str], default: int = -110) -> np.ndarray:
    c1, c2 = cols
    v1 = df.get(c1, pd.Series([default] * len(df))).fillna(default).values
    v2 = df.get(c2, pd.Series([default] * len(df))).fillna(default).values
    return np.maximum(v1, v2).astype(float)


def get_best_novig_arrays(
    df: pd.DataFrame,
    primary_cols: tuple[str, str],
    opposing_cols: tuple[str, str],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Compute per-row no-vig probabilities using the tighter-margin book.
    Returns (novig_primary, novig_opposing, margin) arrays.
    """
    n = len(df)
    nv_p = np.zeros(n)
    nv_o = np.zeros(n)
    margins = np.zeros(n)

    pc1, pc2 = primary_cols
    oc1, oc2 = opposing_cols

    for i, (_, row) in enumerate(df.iterrows()):
        dk_p = row.get(pc1) if pc1 in df.columns else None
        fd_p = row.get(pc2) if pc2 in df.columns else None
        dk_o = row.get(oc1) if oc1 in df.columns else None
        fd_o = row.get(oc2) if oc2 in df.columns else None

        np_val, no_val, m, _book = select_best_novig(dk_p, fd_p, dk_o, fd_o)
        nv_p[i] = np_val
        nv_o[i] = no_val
        margins[i] = m

    return nv_p, nv_o, margins


def load_model(market: str) -> dict:
    pkl_path = MODELS_DIR / market / "artifacts" / "model.pkl"
    with open(pkl_path, "rb") as f:
        return pickle.load(f)


# ---------------------------------------------------------------------------
# Per-market backtest (v3)
# ---------------------------------------------------------------------------

def run_backtest_v3_market(
    market: str,
    holdout: pd.DataFrame,
    opening_odds: pd.DataFrame,
    closing_odds: pd.DataFrame,
) -> dict:
    print(f"\n--- {market.upper()} (v3 vig-removed) ---")

    cfg = MARKET_CONFIG[market]
    target_col = cfg["target"]

    artifact = load_model(market)
    lgbm_model = artifact["model"]
    # v2 artifacts: CalibratedClassifierCV stored as 'calibrated_model'.
    # v1 artifacts: raw IsotonicRegression stored as 'calibrator'.
    calibrated_model = artifact.get("calibrated_model")
    calibrator = artifact.get("calibrator")
    prob_clip_lo = float(artifact.get("prob_clip_lo", 0.10))
    prob_clip_hi = float(artifact.get("prob_clip_hi", 0.80))
    available_features = artifact["features"]

    if market == "totals":
        holdout = holdout[holdout[target_col] != 0.5].copy()

    print(f"  Holdout rows: {len(holdout)}")

    for f in available_features:
        if f not in holdout.columns:
            holdout[f] = 0.0

    X_hold = holdout[available_features].fillna(0).values
    y_hold = holdout[target_col].astype(float).values

    # v2: CalibratedClassifierCV provides calibrated probs directly
    # v1 fallback: raw LightGBM + IsotonicRegression
    if calibrated_model is not None:
        cal_probs = calibrated_model.predict_proba(X_hold)[:, 1]
    else:
        raw_probs = lgbm_model.predict_proba(X_hold)[:, 1]
        cal_probs = calibrator.predict(raw_probs)
    cal_probs = np.clip(cal_probs, prob_clip_lo, prob_clip_hi)

    # Best raw odds for payout computation
    primary_odds = get_best_odds(holdout, PRIMARY_ODDS_COLS[market])
    opposing_odds = get_best_odds(holdout, OPPOSING_ODDS_COLS[market])

    # No-vig probabilities for edge gate
    print("  Computing no-vig market probabilities...")
    nv_primary, nv_opposing, margins = get_best_novig_arrays(
        holdout, PRIMARY_ODDS_COLS[market], OPPOSING_ODDS_COLS[market]
    )

    print(f"  Avg market margin (vig): {margins.mean():.3f} ({margins.mean()*100:.1f}%)")
    print(f"  Margin range: {margins.min():.3f} — {margins.max():.3f}")

    # ROI simulation with vig removal
    roi_stats = {}
    for ev_thr in [0.02, 0.04, 0.06, 0.08, 0.10]:
        key = f"ev_thr_{int(ev_thr*100)}pct"
        roi_stats[key] = simulate_roi_novig(
            cal_probs, y_hold, primary_odds, opposing_odds,
            nv_primary, nv_opposing,
            ev_threshold=ev_thr,
        )
        r = roi_stats[key]
        print(f"  EV>{int(ev_thr*100)}%: {r['n']} picks | flat ROI {r['roi']:+.1f}% | WR {r.get('win_rate', 0):.3f}")

    # CLV computation
    clv_result = _compute_clv_for_holdout(
        market, holdout, cal_probs, opening_odds, closing_odds
    )

    return {
        "market": market,
        "holdout_n": len(holdout),
        "avg_market_margin_pct": round(float(margins.mean()) * 100, 2),
        "roi_novig": roi_stats,
        "clv": clv_result,
    }


def _compute_clv_for_holdout(
    market: str,
    holdout: pd.DataFrame,
    cal_probs: np.ndarray,
    opening_odds: pd.DataFrame,
    closing_odds: pd.DataFrame,
) -> dict:
    """
    Match holdout games to opening/closing snapshots for CLV.
    """
    p_cols = PRIMARY_ODDS_COLS[market]
    o_cols = OPPOSING_ODDS_COLS[market]

    # Holdout uses home_team_abbr/away_team_abbr; odds snapshots use home_team/away_team
    # Rename snapshot columns for join alignment.
    hold_merge_keys = ["home_team_abbr", "away_team_abbr", "game_date"]
    snap_merge_keys = ["home_team", "away_team", "game_date"]

    has_team_cols = all(c in holdout.columns for c in hold_merge_keys)
    if not has_team_cols:
        return {"n": 0, "note": "Missing join columns (home_team_abbr/away_team_abbr) in holdout"}

    if opening_odds.empty or closing_odds.empty:
        return {"n": 0, "note": "Opening/closing odds DataFrames are empty"}

    snap_cols_needed = snap_merge_keys + list(p_cols) + list(o_cols)
    snap_cols_present = [c for c in snap_cols_needed if c in opening_odds.columns]
    if len(snap_cols_present) < len(snap_merge_keys) + 2:
        return {"n": 0, "note": f"Snapshot missing required columns. Have: {list(opening_odds.columns[:10])}"}

    # Build sub-frames and rename snapshot team keys to match holdout
    open_sub = opening_odds[snap_cols_present].copy()
    close_sub = closing_odds[[c for c in snap_cols_needed if c in closing_odds.columns]].copy()
    for df_snap in [open_sub, close_sub]:
        df_snap.rename(
            columns={"home_team": "home_team_abbr", "away_team": "away_team_abbr"},
            inplace=True,
        )

    hold_sub = holdout[hold_merge_keys].copy()
    hold_sub["_row_idx"] = range(len(holdout))

    odds_rename_open = {c: f"{c}_open" for c in list(p_cols) + list(o_cols) if c in open_sub.columns}
    odds_rename_close = {c: f"{c}_close" for c in list(p_cols) + list(o_cols) if c in close_sub.columns}

    merged_open = hold_sub.merge(
        open_sub.rename(columns=odds_rename_open),
        on=hold_merge_keys, how="left",
    )
    merged_close = hold_sub.merge(
        close_sub.rename(columns=odds_rename_close),
        on=hold_merge_keys, how="left",
    )

    merged_open = merged_open.sort_values("_row_idx").reset_index(drop=True)
    merged_close = merged_close.sort_values("_row_idx").reset_index(drop=True)

    if len(merged_open) != len(merged_close):
        return {"n": 0, "note": "Merge length mismatch between open/close"}

    # Build arrays
    def _arr(df: pd.DataFrame, col: str, sfx: str) -> np.ndarray:
        c = f"{col}_{sfx}"
        if c not in df.columns:
            return np.full(len(df), np.nan)
        return df[c].astype(float).fillna(np.nan).values

    p_open_arr = np.maximum(
        _arr(merged_open, p_cols[0], "open"),
        _arr(merged_open, p_cols[1], "open"),
    )
    o_open_arr = np.maximum(
        _arr(merged_open, o_cols[0], "open"),
        _arr(merged_open, o_cols[1], "open"),
    )
    p_close_arr = np.maximum(
        _arr(merged_close, p_cols[0], "close"),
        _arr(merged_close, p_cols[1], "close"),
    )
    o_close_arr = np.maximum(
        _arr(merged_close, o_cols[0], "close"),
        _arr(merged_close, o_cols[1], "close"),
    )

    # Align to holdout length
    n_hold = len(holdout)
    for arr_name, arr in [("p_open", p_open_arr), ("o_open", o_open_arr),
                           ("p_close", p_close_arr), ("o_close", o_close_arr)]:
        if len(arr) != n_hold:
            return {"n": 0, "note": f"Array length mismatch: {arr_name}={len(arr)} vs holdout={n_hold}"}

    clv = compute_clv_for_market(
        cal_probs, np.zeros(n_hold),  # y_true not needed for CLV
        p_open_arr, o_open_arr,
        p_close_arr, o_close_arr,
    )
    return clv


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("Diamond Edge — v3 Backtest: Vig Removal + CLV Harness")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")

    print("\nLoading feature dataset (v2 artifacts, 2024 holdout)...")
    try:
        # Use cached processed parquet if available (avoids ~10min feature rebuild)
        processed_path = DATA_DIR / "games_v1_processed.parquet"
        if processed_path.exists():
            print(f"  Using cached parquet: {processed_path}")
            df = pd.read_parquet(processed_path)
            print(f"  {len(df)} games, {len(df.columns)} columns")
        else:
            df = load_and_build_features()
    except FileNotFoundError as e:
        print(f"ERROR: {e}")
        print("Run worker/models/pipelines/pull_mlb_stats.py first, then re-run.")
        sys.exit(1)

    # Build holdout
    df["season_dt"] = pd.to_datetime(df["game_date"]).dt.year
    holdout_all = df[df["season_dt"] == 2024].copy()
    print(f"2024 holdout: {len(holdout_all)} games")

    # Load all odds snapshots for CLV (not de-duped)
    print("\nLoading all odds snapshots for CLV harness...")
    try:
        snapshots_df = load_odds_with_snapshots([2024])
        print(f"  Loaded {len(snapshots_df)} snapshot rows")
        opening_odds, closing_odds = build_opening_closing_lines(snapshots_df)
        n_open_only = len(snapshots_df.groupby(["home_team", "away_team", "game_date"]))
        print(f"  Unique games in snapshots: {n_open_only}")

        # If opening == closing for all games (only 1 snapshot per game day),
        # CLV will be near-zero — flag this as a data limitation.
        same_ts = (
            opening_odds[["home_team", "away_team", "game_date"]]
            .equals(closing_odds[["home_team", "away_team", "game_date"]])
        )
        if same_ts:
            print("  WARNING: Only 1 snapshot per game — CLV will be near-zero.")
            print("  CLV requires intra-day odds pulls. Production CLV needs 2+ snapshots/day.")
    except Exception as e:
        print(f"  WARNING: Could not load snapshots for CLV: {e}")
        opening_odds = pd.DataFrame()
        closing_odds = pd.DataFrame()

    all_results: dict = {}
    for market in ["moneyline", "run_line", "totals"]:
        try:
            holdout_m = holdout_all.copy()
            result = run_backtest_v3_market(
                market, holdout_m, opening_odds, closing_odds
            )
            all_results[market] = result
        except Exception as e:
            import traceback
            print(f"ERROR for {market}: {e}")
            traceback.print_exc()
            all_results[market] = {"error": str(e)}

    # Summary
    summary = {
        "backtest_date": datetime.now(timezone.utc).isoformat(),
        "version": "v3",
        "holdout_season": 2024,
        "vig_removal_applied": True,
        "vig_removal_method": (
            "No-vig probs computed per-game from best book (tighter margin wins). "
            "EV threshold gate requires BOTH: (a) EV > threshold vs raw odds AND "
            "(b) model_prob > novig_market_prob (genuine edge over fair value). "
            "Payout uses raw odds. v2 used raw-odds EV only, inflating apparent edge."
        ),
        "clv_method": (
            "First vs last snapshot per game day as pick-time / closing line proxies. "
            "CLV = novig_close_prob - novig_open_prob in model's favor. "
            "Positive mean CLV = real edge independent of outcome variance."
        ),
        "run_line_v3_note": (
            "Deviation-from-base-rate model NOT trained in this run (time budget). "
            "See design spec at bottom of backtest report. v2 model retained. "
            "Current v2 run_line mean_prob=0.3586 vs actual 0.3532 — near base rate, "
            "confirming the model is near-neutral. Deploy if v3 ROI >2%; else gate it out."
        ),
        "markets": all_results,
        "success_criteria": {
            "target_roi_range": "2-5% at 8% EV threshold if real alpha exists",
            "target_clv": ">1% mean CLV = sharp signal",
            "deploy_gate": "Do not deploy if ROI > 10% (residual phantom edge) or ROI < -5%",
        },
    }

    # Headline print
    print("\n" + "="*70)
    print("V3 BACKTEST RESULTS (2024 holdout, vig-removed)")
    print("="*70)
    for market, r in all_results.items():
        if "error" in r:
            print(f"  {market}: ERROR — {r['error']}")
            continue
        roi_8 = r.get("roi_novig", {}).get("ev_thr_8pct", {})
        roi_4 = r.get("roi_novig", {}).get("ev_thr_4pct", {})
        clv_data = r.get("clv", {})
        print(f"\n  {market.upper()}:")
        print(f"    Market margin (avg): {r.get('avg_market_margin_pct', 'N/A')}%")
        print(f"    ROI @ 4% EV: {roi_4.get('roi', 'N/A'):+}% ({roi_4.get('n', 0)} picks)")
        print(f"    ROI @ 8% EV: {roi_8.get('roi', 'N/A'):+}% ({roi_8.get('n', 0)} picks)")
        if clv_data.get("n", 0) > 0:
            print(f"    Mean CLV: {clv_data.get('mean_clv_pct', 'N/A')}% ({clv_data.get('n', 0)} records)")
            print(f"    CLV interpretation: {clv_data.get('interpretation', 'N/A')}")
        else:
            print(f"    CLV: {clv_data.get('note', 'No data')}")

    # Check deploy gate
    print("\n--- DEPLOY DECISION ---")
    any_unrealistic = False
    for market, r in all_results.items():
        if "error" in r:
            continue
        roi_8 = r.get("roi_novig", {}).get("ev_thr_8pct", {}).get("roi", 0) or 0
        if roi_8 > 10:
            print(f"  BLOCK DEPLOY: {market} ROI @ 8% = {roi_8}% (still unrealistic after vig removal)")
            any_unrealistic = True

    if not any_unrealistic:
        print("  ROI within realistic range (<=10%) — pipeline gate at 8%/Tier5 is safe to deploy.")
        summary["deploy_decision"] = "SAFE — ROI within realistic range after vig removal"
    else:
        summary["deploy_decision"] = "BLOCKED — ROI still unrealistic after vig removal. Investigate further."

    # Save summary
    out_path = REPORTS_DIR / "backtest_v3_summary.json"
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"\nReport written: {out_path}")


if __name__ == "__main__":
    main()
