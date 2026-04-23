"""
pull_statcast.py — Pull Statcast pitcher aggregates via pybaseball.

Pulls xFIP, barrel_rate_against, and Stuff+ proxies for seasons 2022-2024.
pybaseball wraps Baseball Savant's leaderboard endpoints.

Windows note: pybaseball works on Windows with standard pip install.
The underlying requests go to baseballsavant.mlb.com (free, no auth required).

Output: data/training/statcast_pitchers_{season}.parquet
        data/training/statcast_pitchers_all.parquet

Fallback: If pybaseball fails (network, parse error), FIP from MLB Stats API
          is used as xFIP proxy. This is noted in the manifest.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).parents[3] / "data" / "training"
DATA_DIR.mkdir(parents=True, exist_ok=True)


def fetch_statcast_season(season: int) -> pd.DataFrame:
    """
    Fetch season-level pitcher Statcast metrics via pybaseball.
    Returns DataFrame with one row per pitcher.
    """
    try:
        import pybaseball
        pybaseball.cache.enable()
    except ImportError:
        print("  pybaseball not installed — skipping Statcast pull")
        return pd.DataFrame()

    print(f"  Fetching Statcast pitching leaderboard for {season}...")
    try:
        df = pybaseball.pitching_stats(season, season, qual=10)
        time.sleep(1.0)
    except Exception as e:
        print(f"  Statcast fetch failed for {season}: {e}")
        return pd.DataFrame()

    if df is None or df.empty:
        return pd.DataFrame()

    # Normalize column names: pybaseball returns varying column names
    df.columns = [c.lower().replace(" ", "_").replace("%", "pct").replace("/", "_per_") for c in df.columns]

    keep_cols = []
    col_map = {}

    # xFIP
    for candidate in ["xfip", "xfip-", "expected_fip"]:
        if candidate in df.columns:
            col_map[candidate] = "xfip"
            keep_cols.append(candidate)
            break

    # FIP (always available — used as xFIP proxy if xFIP missing)
    for candidate in ["fip", "fip-"]:
        if candidate in df.columns:
            col_map[candidate] = "fip"
            keep_cols.append(candidate)
            break

    # Barrel rate against (brl/pa or brl%)
    for candidate in ["brl/pa", "brl_pct", "barrel_pct", "brl%"]:
        if candidate in df.columns:
            col_map[candidate] = "barrel_rate_against"
            keep_cols.append(candidate)
            break

    # Hard hit rate against
    for candidate in ["hard_hit_pct", "hard%", "hard_hit%", "hardhit_pct"]:
        if candidate in df.columns:
            col_map[candidate] = "hard_hit_rate_against"
            keep_cols.append(candidate)
            break

    # Player ID
    for candidate in ["playerid", "player_id", "mlbamid", "mlb_id"]:
        if candidate in df.columns:
            col_map[candidate] = "mlbam_id"
            keep_cols.append(candidate)
            break

    # Name
    for candidate in ["name", "playername", "player_name", "player"]:
        if candidate in df.columns:
            col_map[candidate] = "player_name"
            keep_cols.append(candidate)
            break

    # IP for sample filter
    for candidate in ["ip", "innings_pitched"]:
        if candidate in df.columns:
            col_map[candidate] = "ip"
            keep_cols.append(candidate)
            break

    if not keep_cols:
        return pd.DataFrame()

    result = df[keep_cols].rename(columns=col_map)
    result["season"] = season

    # xFIP fallback: if xfip missing, use fip
    if "xfip" not in result.columns and "fip" in result.columns:
        result["xfip"] = result["fip"]

    return result


def run(seasons: list[int] | None = None, skip_existing: bool = True) -> None:
    if seasons is None:
        seasons = [2022, 2023, 2024]

    all_frames = []

    for season in seasons:
        out_path = DATA_DIR / f"statcast_pitchers_{season}.parquet"
        if skip_existing and out_path.exists():
            print(f"  Skipping Statcast {season} — file exists")
            all_frames.append(pd.read_parquet(out_path))
            continue

        df = fetch_statcast_season(season)
        if df.empty:
            print(f"  No Statcast data for {season} — will impute from FIP")
            continue

        df.to_parquet(out_path, index=False)
        print(f"  Saved {len(df)} pitcher rows for {season}")
        all_frames.append(df)

    if all_frames:
        combined = pd.concat(all_frames, ignore_index=True)
        combined.to_parquet(DATA_DIR / "statcast_pitchers_all.parquet", index=False)
        print(f"Statcast all seasons: {len(combined)} rows")


if __name__ == "__main__":
    run()
