"""
Fetch 2022 and 2023 box scores from MLB Stats API.
Run alongside run_data_pull.py (which handles 2024).
"""
from __future__ import annotations
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[3]))

from worker.models.pipelines.pull_mlb_stats import (
    fetch_all_box_scores, DATA_DIR
)
import pandas as pd

for season in [2022, 2023]:
    pitcher_path = DATA_DIR / f"pitcher_logs_{season}.parquet"
    if pitcher_path.exists():
        print(f"Skipping {season} box scores — already fetched")
        continue

    sched_path = DATA_DIR / f"mlb_schedule_{season}.parquet"
    if not sched_path.exists():
        print(f"ERROR: Schedule for {season} not found")
        continue

    sched = pd.read_parquet(sched_path)
    print(f"Fetching {season} box scores ({len(sched)} games)...")
    p, bp, tb = fetch_all_box_scores(sched)
    p.to_parquet(DATA_DIR / f"pitcher_logs_{season}.parquet", index=False)
    bp.to_parquet(DATA_DIR / f"bullpen_{season}.parquet", index=False)
    tb.to_parquet(DATA_DIR / f"team_batting_{season}.parquet", index=False)
    print(f"  {season} done: {len(p)} pitcher rows, {len(bp)} bullpen, {len(tb)} batting")

print("=== 2022/2023 box scores done ===")
