"""
build_training_data_b2.py — Construct B2 delta regression training parquet.

Extends the v1 feature pipeline to:
  1. Join 3-slot wide odds (morning / afternoon / evening) per ADR-002.
  2. Compute market_novig_prior = DK+FD blend from the MORNING snapshot.
     The morning snapshot is the closest to "opening line" available in
     the backfill (14:00 UTC = 10 AM ET, pre-lineup).  This is NOT a true
     opening line — it captures the market ~3-4 hours after actual line
     release — but it is the earliest snapshot in the backfill.  The
     implication for B2 model training is noted in known_weaknesses:
     "market_novig_prior = morning snapshot, not true open; model may
     slightly underestimate available edge vs true opening."
  3. Add B2-specific features:
       market_novig_home_morning      — prior itself as a feature
       line_movement_morning_to_afternoon — implied prob delta (early info)
       book_disagreement_morning      — DK vs FD novig spread at morning
  4. Compute delta targets:
       y_delta_ml   = home_win (0/1) - market_novig_prior_morning
       y_delta_rl   = home_covers_run_line (0/1) - novig_rl_home_morning
       y_delta_tot  = over_hits (0/1) - novig_over_morning
  5. Market_novig_closing (evening) is added as a column for CLV computation
     but is EXCLUDED from training features (leakage guard).

Output: data/training/games_b2.parquet

Leakage audit:
  - market_novig_prior_morning: uses morning snapshot only. Morning snapshot
    is taken at 14:00 UTC on the game day. Games typically start 22:00-02:00
    UTC. No leakage.
  - line_movement_morning_to_afternoon: afternoon snapshot at 19:00 UTC.
    Lineups not yet official (teams post at 16:00-18:00 UTC / 12-2 PM ET).
    Available before bet placement at 22:00+ UTC. No leakage.
  - book_disagreement_morning: morning snapshot only. No leakage.
  - market_novig_closing (evening): COLUMN ONLY — never in feature lists.
    Used only for CLV computation after game ends. No leakage if excluded
    from features.
  - All other features: inherited from v1 pipeline (strictly < game_date).
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).parents[3]
sys.path.insert(0, str(ROOT))

DATA_DIR = ROOT / "data" / "training"

from worker.models.pipelines.load_historical_odds_v2 import load_all_slots


# ---------------------------------------------------------------------------
# Novig helpers for run-line and totals slots
# ---------------------------------------------------------------------------

def _american_to_raw_implied(price: float | None) -> float:
    if price is None or (isinstance(price, float) and np.isnan(price)):
        return 0.5
    p = float(price)
    if p > 0:
        return 100.0 / (100.0 + p)
    else:
        return abs(p) / (abs(p) + 100.0)


def _novig_home(home_price, away_price) -> float | None:
    """Scalar novig home prob from American odds pair."""
    if home_price is None or away_price is None:
        return None
    try:
        hp, ap = float(home_price), float(away_price)
    except (TypeError, ValueError):
        return None
    p_raw = _american_to_raw_implied(hp)
    o_raw = _american_to_raw_implied(ap)
    margin = p_raw + o_raw - 1.0
    if margin > 0.15 or margin <= 0.0:
        return None
    if margin < 0.005:
        margin = 0.005
    return p_raw / (1.0 + margin)


def _blend_novig(dk_home, dk_away, fd_home, fd_away) -> float | None:
    dk = _novig_home(dk_home, dk_away)
    fd = _novig_home(fd_home, fd_away)
    if dk is None and fd is None:
        return None
    if dk is None:
        return fd
    if fd is None:
        return dk
    return 0.5 * dk + 0.5 * fd


def _add_rl_novig(df: pd.DataFrame, slot: str) -> pd.DataFrame:
    """Add novig_rl_home_{slot} — home covers -1.5 probability."""
    dk_h = df.get(f"dk_rl_home_price_{slot}")
    dk_a = df.get(f"dk_rl_away_price_{slot}")
    fd_h = df.get(f"fd_rl_home_price_{slot}")
    fd_a = df.get(f"fd_rl_away_price_{slot}")
    if dk_h is None:
        df[f"novig_rl_home_{slot}"] = None
        return df
    blends = [
        _blend_novig(dh, da, fh, fa)
        for dh, da, fh, fa in zip(dk_h, dk_a, fd_h, fd_a)
    ]
    df[f"novig_rl_home_{slot}"] = pd.array(blends, dtype=pd.Float64Dtype())
    return df


def _add_total_novig(df: pd.DataFrame, slot: str) -> pd.DataFrame:
    """Add novig_over_{slot} — over probability."""
    dk_over = df.get(f"dk_over_price_{slot}")
    dk_under = df.get(f"dk_under_price_{slot}")
    fd_over = df.get(f"fd_over_price_{slot}")
    fd_under = df.get(f"fd_under_price_{slot}")
    if dk_over is None:
        df[f"novig_over_{slot}"] = None
        return df
    blends = [
        _blend_novig(ov, un, fo, fu)
        for ov, un, fo, fu in zip(dk_over, dk_under, fd_over, fd_under)
    ]
    df[f"novig_over_{slot}"] = pd.array(blends, dtype=pd.Float64Dtype())
    return df


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------

def build_b2_dataset(years: list[int] | None = None) -> pd.DataFrame:
    """
    Load the v1 processed parquet and join 3-slot odds to construct the B2
    delta regression training dataset.

    Returns merged DataFrame with B2 features and delta targets.
    """
    if years is None:
        years = [2022, 2023, 2024]

    processed_path = DATA_DIR / "games_v1_processed.parquet"
    if not processed_path.exists():
        raise FileNotFoundError(
            f"games_v1_processed.parquet not found at {processed_path}. "
            "Run worker/models/pipelines/train_models.py first to build the v1 feature dataset."
        )

    print("Loading v1 processed feature dataset...")
    df_v1 = pd.read_parquet(processed_path)
    df_v1 = df_v1[df_v1["season"].isin(years)].copy()
    print(f"  v1 rows: {len(df_v1)}")

    # Normalize team abbreviation columns (needed for join)
    if "home_team_abbr" not in df_v1.columns:
        from worker.app.team_map import MLB_STATS_TEAM_ID
        MLB_ID_TO_ABBR: dict[int, str] = {v: k for k, v in MLB_STATS_TEAM_ID.items()}
        df_v1["home_team_abbr"] = df_v1["home_team_id"].map(MLB_ID_TO_ABBR)
        df_v1["away_team_abbr"] = df_v1["away_team_id"].map(MLB_ID_TO_ABBR)

    print("Loading 3-slot wide odds...")
    odds_wide = load_all_slots(years)
    print(f"  Wide odds rows: {len(odds_wide)}, columns: {len(odds_wide.columns)}")

    # Add run-line and totals novig per slot
    for slot in ["morning", "afternoon", "evening"]:
        odds_wide = _add_rl_novig(odds_wide, slot)
        odds_wide = _add_total_novig(odds_wide, slot)

    # Identify B2 columns to join (exclude key columns)
    key_cols_odds = {"home_team", "away_team", "game_date", "season"}
    b2_cols = [c for c in odds_wide.columns if c not in key_cols_odds]

    # Merge wide odds onto v1 dataset on (home_team_abbr, away_team_abbr, game_date)
    odds_join = odds_wide.rename(
        columns={"home_team": "home_team_abbr", "away_team": "away_team_abbr"}
    )
    odds_join = odds_join[["home_team_abbr", "away_team_abbr", "game_date"] + b2_cols]

    df = df_v1.merge(
        odds_join,
        on=["home_team_abbr", "away_team_abbr", "game_date"],
        how="left",
        suffixes=("", "_wide"),
    )
    print(f"  After merge: {len(df)} rows")

    # Rename morning blend to the ADR-002 canonical name
    if "novig_ml_home_morning" in df.columns:
        df["market_novig_prior_morning"] = df["novig_ml_home_morning"]
    else:
        df["market_novig_prior_morning"] = None

    if "novig_ml_home_evening" in df.columns:
        df["market_novig_closing_evening"] = df["novig_ml_home_evening"]
    else:
        df["market_novig_closing_evening"] = None

    # B2 feature aliases (for clarity in training script)
    df["market_novig_home_morning"] = df["market_novig_prior_morning"]

    # line_movement_morning_to_afternoon already computed in load_all_slots
    if "line_movement_morning_to_afternoon" not in df.columns:
        df["line_movement_morning_to_afternoon"] = None

    if "book_disagreement_ml_morning" in df.columns:
        df["book_disagreement_morning"] = df["book_disagreement_ml_morning"]
    else:
        df["book_disagreement_morning"] = None

    # RL novig aliases
    if "novig_rl_home_morning" in df.columns:
        df["market_novig_rl_prior_morning"] = df["novig_rl_home_morning"]
    else:
        df["market_novig_rl_prior_morning"] = None

    # Totals novig aliases
    if "novig_over_morning" in df.columns:
        df["market_novig_over_prior_morning"] = df["novig_over_morning"]
    else:
        df["market_novig_over_prior_morning"] = None

    # -----------------------------------------------------------------------
    # Compute delta targets (ADR-002 §delta model target)
    # y = actual_outcome - market_novig_prior_morning
    # -----------------------------------------------------------------------
    prior_ml = df["market_novig_prior_morning"].astype(float)
    prior_rl = df.get("market_novig_rl_prior_morning", pd.Series([None] * len(df))).astype(float)
    prior_over = df.get("market_novig_over_prior_morning", pd.Series([None] * len(df))).astype(float)

    # Moneyline delta: requires both prior and outcome
    ml_prior_valid = prior_ml.notna()
    df["y_delta_ml"] = np.where(
        ml_prior_valid,
        df["home_win"].astype(float) - prior_ml,
        np.nan,
    )

    # Run-line delta
    rl_prior_valid = prior_rl.notna()
    if "home_covers_run_line" in df.columns:
        df["y_delta_rl"] = np.where(
            rl_prior_valid,
            df["home_covers_run_line"].astype(float) - prior_rl,
            np.nan,
        )
    else:
        df["y_delta_rl"] = np.nan

    # Totals delta (exclude pushes — over_hits == None/0.5)
    over_hits = df.get("over_hits", pd.Series([np.nan] * len(df))).astype(float)
    over_prior_valid = prior_over.notna() & over_hits.notna() & (over_hits != 0.5)
    df["y_delta_tot"] = np.where(
        over_prior_valid,
        over_hits - prior_over,
        np.nan,
    )

    # -----------------------------------------------------------------------
    # Data hash for manifest
    # -----------------------------------------------------------------------
    hash_cols = [c for c in ["game_pk", "game_date", "home_team_abbr"] if c in df.columns]
    if hash_cols:
        data_hash = hashlib.md5(
            pd.util.hash_pandas_object(df[hash_cols]).values
        ).hexdigest()[:12]
        df["_b2_data_hash"] = data_hash

    # Coverage report
    ml_coverage = ml_prior_valid.sum()
    rl_coverage = rl_prior_valid.sum()
    tot_coverage = over_prior_valid.sum()
    total = len(df)
    print(f"\nB2 target coverage:")
    print(f"  Moneyline delta: {ml_coverage}/{total} rows ({ml_coverage/total*100:.1f}%)")
    print(f"  Run-line delta:  {rl_coverage}/{total} rows ({rl_coverage/total*100:.1f}%)")
    print(f"  Totals delta:    {tot_coverage}/{total} rows ({tot_coverage/total*100:.1f}%)")

    delta_stats = df["y_delta_ml"].dropna()
    if not delta_stats.empty:
        print(f"\ny_delta_ml stats:")
        print(f"  mean={delta_stats.mean():.4f} std={delta_stats.std():.4f} "
              f"min={delta_stats.min():.4f} max={delta_stats.max():.4f}")

    return df


def main() -> None:
    df = build_b2_dataset()

    out_path = DATA_DIR / "games_b2.parquet"
    df.to_parquet(out_path, index=False)
    print(f"\nSaved {len(df)} rows to {out_path}")

    b2_cols = [c for c in df.columns if any(
        c.startswith(p) for p in [
            "market_novig", "novig_", "line_movement_", "book_disagree",
            "y_delta_"
        ]
    )]
    print(f"\nB2 columns ({len(b2_cols)}):")
    for c in sorted(b2_cols):
        non_null = df[c].notna().sum()
        print(f"  {c}: {non_null} non-null")


if __name__ == "__main__":
    main()
