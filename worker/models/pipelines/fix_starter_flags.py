"""
fix_starter_flags.py — Fix is_starter flags in pitcher_logs parquets.

The original pull used sequenceNumber which doesn't exist in the API response.
This script fixes is_starter using two methods:
  1. For games where schedule has home_sp_id/away_sp_id: mark those IDs as starters.
  2. For games without SP IDs: mark the pitcher with the most IP as the starter.
     (ties broken by lower pitcher_id — arbitrary but consistent)
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import numpy as np

sys.path.insert(0, str(Path(__file__).parents[3]))

DATA_DIR = Path(__file__).parents[3] / "data" / "training"


def fix_starters(season: int) -> None:
    pitcher_path = DATA_DIR / f"pitcher_logs_{season}.parquet"
    bullpen_path = DATA_DIR / f"bullpen_{season}.parquet"
    sched_path = DATA_DIR / f"mlb_schedule_{season}.parquet"

    if not pitcher_path.exists():
        print(f"  {season}: pitcher_logs not found — skipping")
        return

    p = pd.read_parquet(pitcher_path)
    sched = pd.read_parquet(sched_path)

    print(f"  {season}: {len(p)} pitcher rows (is_starter currently: {p['is_starter'].sum()})")

    # Build starter ID set from schedule
    home_starters = sched[["game_pk", "home_sp_id"]].dropna().rename(
        columns={"home_sp_id": "sp_id"}
    )
    home_starters["team_side"] = "home"
    away_starters = sched[["game_pk", "away_sp_id"]].dropna().rename(
        columns={"away_sp_id": "sp_id"}
    )
    away_starters["team_side"] = "away"
    starter_lookup = pd.concat([home_starters, away_starters], ignore_index=True)
    starter_lookup["sp_id"] = starter_lookup["sp_id"].astype(float).astype("Int64")
    starter_set = set(
        (int(row.game_pk), str(row.team_side), int(row.sp_id))
        for _, row in starter_lookup.iterrows()
        if pd.notna(row.sp_id)
    )

    # For games NOT in starter_lookup, find pitcher with max IP
    def _ip_to_float(val) -> float:
        try:
            ip = float(val)
            full = int(ip)
            partial = round(ip - full, 1)
            return full + partial * (10 / 3)
        except (TypeError, ValueError):
            return 0.0

    p_work = p.copy()
    p_work["ip_float"] = p_work["ip"].apply(_ip_to_float)

    games_with_sp = set(home_starters["game_pk"].tolist() + away_starters["game_pk"].tolist())

    # For games without SP data: identify starter as highest-IP pitcher per game+side
    games_no_sp = set(p_work["game_pk"].unique()) - games_with_sp
    if games_no_sp:
        no_sp_data = p_work[p_work["game_pk"].isin(games_no_sp)]
        max_ip_idx = (
            no_sp_data.groupby(["game_pk", "team_side"])["ip_float"]
            .idxmax()
        )
        max_ip_set = set(max_ip_idx.values)
    else:
        max_ip_set = set()

    def is_starter(row) -> bool:
        gp = int(row.game_pk)
        pid = int(row.pitcher_id) if pd.notna(row.pitcher_id) else -1
        side = str(row.team_side)

        # Method 1: schedule SP ID
        if (gp, side, pid) in starter_set:
            return True

        # Method 2: max IP in games without SP info
        if row.name in max_ip_set:
            return True

        return False

    p_work["is_starter"] = p_work.apply(is_starter, axis=1)

    starters_found = p_work["is_starter"].sum()
    print(f"  {season}: fixed is_starter — {starters_found} starters "
          f"({starters_found / len(p_work) * 100:.1f}%)")

    p_work.drop(columns=["ip_float"], inplace=True)
    p_work.to_parquet(pitcher_path, index=False)

    # Re-split bullpen
    bp_work = p_work[~p_work["is_starter"]].copy()
    bp_work.to_parquet(bullpen_path, index=False)
    print(f"  {season}: bullpen rows: {len(bp_work)}")


def fix_combined_raw() -> None:
    """Merge per-season fixed files into combined raw."""
    frames_p, frames_b = [], []
    for season in [2022, 2023, 2024]:
        pp = DATA_DIR / f"pitcher_logs_{season}.parquet"
        bp = DATA_DIR / f"bullpen_{season}.parquet"
        if pp.exists():
            frames_p.append(pd.read_parquet(pp))
        if bp.exists():
            frames_b.append(pd.read_parquet(bp))

    if frames_p:
        pd.concat(frames_p, ignore_index=True).to_parquet(
            DATA_DIR / "pitcher_logs_raw.parquet", index=False
        )
        print(f"pitcher_logs_raw.parquet: {sum(len(f) for f in frames_p)} rows")
    if frames_b:
        pd.concat(frames_b, ignore_index=True).to_parquet(
            DATA_DIR / "bullpen_raw.parquet", index=False
        )
        print(f"bullpen_raw.parquet: {sum(len(f) for f in frames_b)} rows")


if __name__ == "__main__":
    print("Fixing starter flags in pitcher_logs parquets...")
    for s in [2022, 2023, 2024]:
        fix_starters(s)
    print("\nRe-building combined raw files...")
    fix_combined_raw()
    print("Done.")
