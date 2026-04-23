"""
merge_season_parquets.py — Merge per-season parquet files into combined raw files.

The pull scripts write per-season files (mlb_schedule_2022.parquet, etc.).
The training pipeline expects combined files (mlb_schedule_raw.parquet, etc.).
This script merges them.

Run after all season pulls complete.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[3]))

DATA_DIR = Path(__file__).parents[3] / "data" / "training"


def merge_files(
    pattern_fmt: str,
    output_name: str,
    seasons: list[int],
    skip_if_exists: bool = False,
) -> None:
    out_path = DATA_DIR / output_name
    if skip_if_exists and out_path.exists():
        print(f"  Skipping {output_name} — already exists")
        return

    frames = []
    for season in seasons:
        p = DATA_DIR / (pattern_fmt % season)
        if p.exists():
            df = pd.read_parquet(p)
            print(f"  Loaded {p.name}: {len(df)} rows")
            frames.append(df)
        else:
            print(f"  WARNING: {p.name} not found — skipping")

    if not frames:
        print(f"  No files found for {output_name}")
        return

    combined = pd.concat(frames, ignore_index=True)
    combined.to_parquet(out_path, index=False)
    print(f"  Saved {output_name}: {len(combined)} rows")


def main(seasons: list[int] | None = None) -> None:
    if seasons is None:
        seasons = [2022, 2023, 2024]

    print("Merging per-season parquet files...")

    merge_files("mlb_schedule_%d.parquet", "mlb_schedule_raw.parquet", seasons)
    merge_files("pitcher_logs_%d.parquet", "pitcher_logs_raw.parquet", seasons)
    merge_files("bullpen_%d.parquet", "bullpen_raw.parquet", seasons)
    merge_files("team_batting_%d.parquet", "team_batting_raw.parquet", seasons)

    print("Merge complete.")


if __name__ == "__main__":
    main()
