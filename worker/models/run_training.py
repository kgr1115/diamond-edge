"""
run_training.py — One-shot training entry point.

Waits for required parquet files to exist, then runs the full training pipeline.

Usage:
    python worker/models/run_training.py

Or for a single market:
    python worker/models/run_training.py --markets moneyline
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2]))

DATA_DIR = Path(__file__).parents[2] / "data" / "training"

REQUIRED_FILES = [
    "mlb_schedule_raw.parquet",
    "pitcher_logs_raw.parquet",
    "bullpen_raw.parquet",
    "team_batting_raw.parquet",
]


def wait_for_data(timeout_s: int = 7200) -> bool:
    """Wait up to timeout_s seconds for all required parquet files."""
    start = time.time()
    while time.time() - start < timeout_s:
        missing = [f for f in REQUIRED_FILES if not (DATA_DIR / f).exists()]
        if not missing:
            return True
        print(f"  Waiting for: {missing}")
        time.sleep(30)
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--markets", nargs="+",
        default=["moneyline", "run_line", "totals"],
    )
    parser.add_argument(
        "--no-wait", action="store_true",
        help="Skip waiting for data (fail fast if not present)",
    )
    args = parser.parse_args()

    if not args.no_wait:
        print("Waiting for training data...")
        if not wait_for_data():
            print("ERROR: Training data not ready after 2 hours. Aborting.")
            sys.exit(1)
    else:
        missing = [f for f in REQUIRED_FILES if not (DATA_DIR / f).exists()]
        if missing:
            print(f"ERROR: Missing required files: {missing}")
            sys.exit(1)

    from worker.models.pipelines.train_models import main as train_main
    train_main(args.markets)


if __name__ == "__main__":
    main()
