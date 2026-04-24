"""
promote.py — Explicit manual promotion of a trained retrain artifact.

Flips `worker/models/<market>/artifacts/current_version.json` to point at a
specific `v<timestamp>/` artifact directory. Used after the retrain pipeline
flags a market as "pending manual sign-off" (see monthly.py null-prior
policy added 2026-04-24 per pick-scope-gate proposal #4).

This is the ONLY automated path to flip current_version.json when no prior
exists — monthly.py will not auto-promote a null-prior market unless invoked
with --force-promote-no-prior --yes (and even then rejects lgbm_best_iteration <= 1).

Refuses if:
  - The target artifact dir does not exist.
  - metrics.json is missing (cannot record log_loss / CLV / ROI in the pointer).
  - The artifact's lgbm_best_iteration == 1 (sanity gate — moneyline-b2-v3 failure).
  - The artifact's metrics.json carries `variance_collapsed: true` (P7 guardrail,
    2026-04-24) — retrain detected a degenerate delta distribution post-train.
    Override with --allow-degenerate (caller accepts responsibility — covers both
    the iter-1 and variance-collapsed refusals).

Run:
  python -m worker.models.retrain.promote --market <name> --timestamp <ts>
                                          [--allow-degenerate] [--dry-run]

Exit codes:
  0 — promotion written (or dry-run OK).
  1 — refused (bad input, missing artifact, or degenerate gate triggered).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parents[3]
MODELS_DIR = ROOT / "worker" / "models"
KNOWN_MARKETS = ("moneyline", "run_line", "totals")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("promote")


def promote(
    market: str,
    timestamp: str,
    models_dir: Path | None = None,
    allow_degenerate: bool = False,
    dry_run: bool = False,
) -> dict:
    """
    Flip current_version.json for `market` to point at v<timestamp>/.

    Returns the pointer dict written (or the would-be pointer under --dry-run).
    Raises ValueError / FileNotFoundError on refusal so callers can handle the
    failure modes distinctly.
    """
    base = models_dir or MODELS_DIR
    if market not in KNOWN_MARKETS:
        raise ValueError(f"Unknown market '{market}'. Expected one of {KNOWN_MARKETS}.")

    market_dir = base / market / "artifacts"
    artifact_dir = market_dir / f"v{timestamp}"
    if not artifact_dir.is_dir():
        raise FileNotFoundError(
            f"Artifact directory not found: {artifact_dir}. "
            "Run monthly.py to create it first, or check the timestamp."
        )

    metrics_path = artifact_dir / "metrics.json"
    if not metrics_path.is_file():
        raise FileNotFoundError(
            f"metrics.json missing at {metrics_path}. Cannot promote without "
            "holdout metrics; re-run retrain."
        )

    with open(metrics_path) as f:
        metrics = json.load(f)

    best_iter = metrics.get("lgbm_best_iteration")
    if best_iter is not None and best_iter <= 1 and not allow_degenerate:
        raise ValueError(
            f"Refusing to promote {market} v{timestamp}: lgbm_best_iteration="
            f"{best_iter} (<=1) — model found no useful split. "
            "Pass --allow-degenerate to override (NOT recommended)."
        )

    # P7 (2026-04-24) — refuse if retrain's variance-collapse guardrail fired.
    # Symmetric with the iter-1 check above; both gates share --allow-degenerate.
    if metrics.get("variance_collapsed") and not allow_degenerate:
        reasons = metrics.get("variance_collapse_reasons") or []
        detail = "; ".join(reasons) if reasons else "reasons not recorded"
        raise ValueError(
            f"Refusing to promote {market} v{timestamp}: retrain flagged "
            f"variance_collapsed=true. Reasons: {detail}. Pass --allow-degenerate "
            "to override (NOT recommended)."
        )

    pointer = {
        "version": timestamp,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "artifact_dir": str(artifact_dir),
        "log_loss": (metrics.get("holdout_2024") or {}).get("log_loss_new_model"),
        "best_roi_pct": metrics.get("best_roi_pct"),
        "clv_pct": (metrics.get("clv") or {}).get("mean_clv_pct"),
        "lgbm_best_iteration": best_iter,
        "variance_collapsed": bool(metrics.get("variance_collapsed", False)),
        "promoted_by": "worker.models.retrain.promote",
    }

    pointer_path = market_dir / "current_version.json"
    if dry_run:
        log.info(f"[dry-run] would write {pointer_path}:\n{json.dumps(pointer, indent=2)}")
        return pointer

    with open(pointer_path, "w") as f:
        json.dump(pointer, f, indent=2, default=str)
    log.info(f"Promoted {market} → v{timestamp}")
    log.info(f"  pointer: {pointer_path}")
    log.info(f"  log_loss={pointer['log_loss']} | CLV%={pointer['clv_pct']} | best_iter={best_iter}")
    return pointer


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Manually promote a retrain artifact to current (flip current_version.json)."
    )
    parser.add_argument("--market", required=True, choices=KNOWN_MARKETS)
    parser.add_argument(
        "--timestamp",
        required=True,
        help="Artifact timestamp, e.g. 20260424T155844 (matches v<timestamp>/ dir name).",
    )
    parser.add_argument(
        "--allow-degenerate",
        action="store_true",
        help="Allow promotion even when lgbm_best_iteration <= 1 (NOT recommended).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the pointer that would be written, but do not write it.",
    )
    args = parser.parse_args()

    try:
        promote(
            market=args.market,
            timestamp=args.timestamp,
            allow_degenerate=args.allow_degenerate,
            dry_run=args.dry_run,
        )
    except (FileNotFoundError, ValueError) as e:
        log.error(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
