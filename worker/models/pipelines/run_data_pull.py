"""
run_data_pull.py — Pull MLB Stats + Statcast data for 2022-2024.
Run with: python worker/models/pipelines/run_data_pull.py
Writes progress to data/training/pull.log
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[3]))

# Redirect all output to log file as well as stdout
import logging
DATA_DIR = Path(__file__).parents[3] / "data" / "training"
DATA_DIR.mkdir(parents=True, exist_ok=True)
log_path = DATA_DIR / "pull.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    handlers=[
        logging.FileHandler(log_path, mode="w"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger()

# Monkey-patch print to also log
import builtins
_orig_print = builtins.print
def _print(*args, **kwargs):
    _orig_print(*args, **kwargs)
    logger.info(" ".join(str(a) for a in args))
builtins.print = _print

from worker.models.pipelines.pull_mlb_stats import run as run_mlb
from worker.models.pipelines.pull_statcast import run as run_statcast

print("=== Starting full data pull ===")
run_mlb(seasons=[2022, 2023, 2024], skip_existing=True)
print("=== MLB Stats done ===")
run_statcast(seasons=[2022, 2023, 2024], skip_existing=True)
print("=== Statcast done ===")
print("=== ALL DONE ===")
