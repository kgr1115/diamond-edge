"""
run_full_pipeline.py — Full data → feature → train → report pipeline.

Run this after all data pulls are complete:
  python worker/models/pipelines/run_full_pipeline.py

Steps:
  1. Merge per-season parquets into combined raw files
  2. Run Statcast pull (pybaseball, non-blocking)
  3. Run training pipeline for all 3 markets
  4. Print headline metrics
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[3]))

DATA_DIR = Path(__file__).parents[3] / "data" / "training"


def check_data_ready() -> bool:
    """Returns True if all 3 seasons' box score files are present."""
    for season in [2022, 2023, 2024]:
        for pattern in [f"pitcher_logs_{season}.parquet",
                        f"bullpen_{season}.parquet",
                        f"team_batting_{season}.parquet"]:
            if not (DATA_DIR / pattern).exists():
                return False
    return True


def main() -> None:
    print("=== Diamond Edge v1 Full Training Pipeline ===\n")

    if not check_data_ready():
        print("ERROR: Not all season box score files are present.")
        print("Run pull_mlb_stats.py and fetch_boxscores_2022_2023.py first.")
        print("Files needed:")
        for season in [2022, 2023, 2024]:
            for pattern in [f"pitcher_logs_{season}.parquet",
                            f"bullpen_{season}.parquet",
                            f"team_batting_{season}.parquet"]:
                status = "OK" if (DATA_DIR / pattern).exists() else "MISSING"
                print(f"  [{status}] {pattern}")
        sys.exit(1)

    print("Step 1: Merging per-season parquets...")
    from worker.models.pipelines.merge_season_parquets import main as merge_main
    merge_main()

    print("\nStep 2: Statcast pull...")
    from worker.models.pipelines.pull_statcast import run as statcast_run
    statcast_run(seasons=[2022, 2023, 2024], skip_existing=True)

    print("\nStep 3: Training models...")
    from worker.models.pipelines.train_models import main as train_main
    metrics = train_main(["moneyline", "run_line", "totals"])

    print("\n=== DONE ===")
    return metrics


if __name__ == "__main__":
    main()
