"""
enrich_schedule_sp_ids.py — Populate home_sp_id / away_sp_id in schedule
from the pitcher_logs_raw.parquet starters table.

The schedule endpoint returns probable pitchers as None for historical games.
The box score data has the actual starters. This script joins them.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[3]))

DATA_DIR = Path(__file__).parents[3] / "data" / "training"


def enrich() -> None:
    sched = pd.read_parquet(DATA_DIR / "mlb_schedule_raw.parquet")
    pl = pd.read_parquet(DATA_DIR / "pitcher_logs_raw.parquet")

    starters = pl[pl["is_starter"]].copy()
    starters = starters[["game_pk", "team_side", "pitcher_id"]].drop_duplicates(
        subset=["game_pk", "team_side"]
    )

    home_starters = starters[starters["team_side"] == "home"].rename(
        columns={"pitcher_id": "home_sp_id"}
    )[["game_pk", "home_sp_id"]]

    away_starters = starters[starters["team_side"] == "away"].rename(
        columns={"pitcher_id": "away_sp_id"}
    )[["game_pk", "away_sp_id"]]

    sched = sched.merge(home_starters, on="game_pk", how="left", suffixes=("_old", ""))
    sched = sched.merge(away_starters, on="game_pk", how="left", suffixes=("_old", ""))

    # Resolve: use new values if old is null
    for side in ("home", "away"):
        new_col = f"{side}_sp_id"
        old_col = f"{side}_sp_id_old"
        if old_col in sched.columns:
            sched[new_col] = sched[old_col].where(
                sched[old_col].notna(), sched[new_col]
            )
            sched.drop(columns=[old_col], inplace=True)

    filled_home = sched["home_sp_id"].notna().sum()
    filled_away = sched["away_sp_id"].notna().sum()
    print(f"home_sp_id filled: {filled_home}/{len(sched)} ({filled_home/len(sched)*100:.1f}%)")
    print(f"away_sp_id filled: {filled_away}/{len(sched)} ({filled_away/len(sched)*100:.1f}%)")

    sched.to_parquet(DATA_DIR / "mlb_schedule_raw.parquet", index=False)
    print("mlb_schedule_raw.parquet updated with SP IDs")

    # Also update per-season files
    for season in [2022, 2023, 2024]:
        path = DATA_DIR / f"mlb_schedule_{season}.parquet"
        if path.exists():
            s = pd.read_parquet(path)
            s = s.merge(home_starters, on="game_pk", how="left", suffixes=("_old", ""))
            s = s.merge(away_starters, on="game_pk", how="left", suffixes=("_old", ""))
            for side in ("home", "away"):
                nc, oc = f"{side}_sp_id", f"{side}_sp_id_old"
                if oc in s.columns:
                    s[nc] = s[oc].where(s[oc].notna(), s[nc])
                    s.drop(columns=[oc], inplace=True)
            s.to_parquet(path, index=False)
            filled = s["home_sp_id"].notna().sum()
            print(f"  {season}: home_sp_id filled {filled}/{len(s)}")


if __name__ == "__main__":
    enrich()
