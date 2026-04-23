"""
fetch_remaining_boxscores.py — Fetch missing box scores for 2023 and 2024.
Run this if pitcher_logs_raw.parquet only has 2022 data.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[3]))
from worker.models.pipelines.pull_mlb_stats import fetch_all_box_scores, DATA_DIR

for season in [2023, 2024]:
    pitcher_path = DATA_DIR / f"pitcher_logs_{season}.parquet"
    if pitcher_path.exists():
        print(f"Skipping {season} — already done")
        continue

    sched_path = DATA_DIR / f"mlb_schedule_{season}.parquet"
    if not sched_path.exists():
        print(f"ERROR: no schedule for {season}")
        continue

    sched = pd.read_parquet(sched_path)
    print(f"Fetching {season} box scores for {len(sched)} games...")
    p, bp, tb = fetch_all_box_scores(sched)
    p.to_parquet(DATA_DIR / f"pitcher_logs_{season}.parquet", index=False)
    bp.to_parquet(DATA_DIR / f"bullpen_{season}.parquet", index=False)
    tb.to_parquet(DATA_DIR / f"team_batting_{season}.parquet", index=False)
    print(f"  {season}: {len(p)} pitcher rows, {len(bp)} bullpen, {len(tb)} batting")

print("=== Done ===")
