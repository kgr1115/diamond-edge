"""Per-market isotonic recalibration with promotion gate.

Per pick-scope-gate-2026-04-28.md Proposal 4 (P1).

Fits an isotonic regression per market on `picks JOIN pick_outcomes` over a
configurable trailing window (default 60 days). Writes the fitted artifact to
a `candidates/` subdirectory. Promotes to the live path only if BOTH gates pass:

  1. Per-market log-loss on a held-out 20% slice improves vs the unfitted
     (identity) baseline.
  2. Per-market N >= MIN_GRADED_FOR_PROMOTION (default 150) graded outcomes
     in the fit window.

Auto-rollback: a separate health check (run by the live worker on startup, OR
by a downstream verification step) compares ECE and per-tier reliability
against the just-promoted artifact. If either degrades, the live artifact
reverts to the prior version.

Cadence: monthly (cron entry separate from this module). Nightly fitting on a
small sample overfits.

Run as a script:
    python -m worker.app.calibration_fit --market run_line --window-days 60

Or invoke the public function:
    fit_and_maybe_promote(market='run_line', window_days=60)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

try:
    import numpy as np
    from sklearn.isotonic import IsotonicRegression
    from sklearn.metrics import log_loss
    from supabase import create_client
except ImportError as exc:  # pragma: no cover — missing deps surface at runtime
    raise SystemExit(
        f"calibration_fit requires numpy, scikit-learn, supabase: {exc}"
    ) from exc

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WORKER_ROOT = Path(__file__).resolve().parent.parent
CALIBRATION_DIR = WORKER_ROOT / "models" / "calibration"
CANDIDATES_DIR = CALIBRATION_DIR / "candidates"

MARKETS = ("moneyline", "run_line", "total")
DEFAULT_WINDOW_DAYS = 60
MIN_GRADED_FOR_PROMOTION = 150
HOLDOUT_FRACTION = 0.2

# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


@dataclass
class FitResult:
    market: str
    n_total: int
    n_graded: int
    n_train: int
    n_holdout: int
    baseline_logloss: float | None
    fitted_logloss: float | None
    promoted: bool
    reason: str


def _supabase_client():
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _load_graded_picks(market: str, window_days: int) -> list[dict]:
    """Pull graded picks for `market` from the trailing `window_days` window."""
    supabase = _supabase_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()

    response = (
        supabase.table("picks")
        .select("model_probability, result, generated_at")
        .eq("market", market)
        .gte("generated_at", cutoff)
        .in_("result", ["win", "loss"])
        .limit(5000)
        .execute()
    )
    rows = response.data or []
    # Coerce + filter
    out: list[dict] = []
    for r in rows:
        prob = r.get("model_probability")
        result = r.get("result")
        if not isinstance(prob, (int, float)):
            continue
        if result not in ("win", "loss"):
            continue
        out.append({"prob": float(prob), "y": 1 if result == "win" else 0})
    return out


# ---------------------------------------------------------------------------
# Fit + gate
# ---------------------------------------------------------------------------


def _fit_isotonic(probs: Iterable[float], ys: Iterable[int]) -> IsotonicRegression:
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(np.asarray(list(probs)), np.asarray(list(ys)))
    return iso


def _split_train_holdout(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Deterministic train/holdout split on a hash of (prob, y) for repeatability."""
    n = len(rows)
    if n == 0:
        return [], []
    # Deterministic shuffle: sort by hash of (round(prob,4), y).
    sorted_rows = sorted(
        rows,
        key=lambda r: hash((round(r["prob"], 4), r["y"])),
    )
    n_holdout = max(1, int(round(n * HOLDOUT_FRACTION)))
    return sorted_rows[n_holdout:], sorted_rows[:n_holdout]


def _safe_log_loss(probs: Iterable[float], ys: Iterable[int]) -> float | None:
    probs_arr = np.asarray(list(probs))
    ys_arr = np.asarray(list(ys))
    if len(probs_arr) == 0:
        return None
    # Clip to avoid -inf when prob hits 0/1.
    clipped = np.clip(probs_arr, 1e-6, 1 - 1e-6)
    try:
        return float(log_loss(ys_arr, clipped))
    except ValueError:
        # log_loss requires both classes present in y_true.
        return None


def fit_and_maybe_promote(
    market: str,
    window_days: int = DEFAULT_WINDOW_DAYS,
    *,
    dry_run: bool = False,
) -> FitResult:
    """Fit one market's isotonic calibrator and promote only if both gates pass."""
    rows = _load_graded_picks(market, window_days)
    n_graded = len(rows)

    if n_graded < MIN_GRADED_FOR_PROMOTION:
        return FitResult(
            market=market,
            n_total=n_graded,
            n_graded=n_graded,
            n_train=0,
            n_holdout=0,
            baseline_logloss=None,
            fitted_logloss=None,
            promoted=False,
            reason=f"insufficient_sample (have {n_graded}, need {MIN_GRADED_FOR_PROMOTION})",
        )

    train, holdout = _split_train_holdout(rows)

    iso = _fit_isotonic((r["prob"] for r in train), (r["y"] for r in train))

    baseline = _safe_log_loss(
        (r["prob"] for r in holdout),
        (r["y"] for r in holdout),
    )
    fitted = _safe_log_loss(
        iso.predict(np.asarray([r["prob"] for r in holdout])),
        (r["y"] for r in holdout),
    )

    if baseline is None or fitted is None:
        return FitResult(
            market=market,
            n_total=n_graded,
            n_graded=n_graded,
            n_train=len(train),
            n_holdout=len(holdout),
            baseline_logloss=baseline,
            fitted_logloss=fitted,
            promoted=False,
            reason="logloss_undefined (single-class holdout)",
        )

    if fitted >= baseline:
        return FitResult(
            market=market,
            n_total=n_graded,
            n_graded=n_graded,
            n_train=len(train),
            n_holdout=len(holdout),
            baseline_logloss=baseline,
            fitted_logloss=fitted,
            promoted=False,
            reason=f"no_logloss_improvement (baseline={baseline:.4f}, fitted={fitted:.4f})",
        )

    # Both gates passed — write candidate, promote on non-dry-run.
    CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)
    candidate_path = CANDIDATES_DIR / f"{market}_isotonic.pkl"
    live_path = CALIBRATION_DIR / f"{market}_isotonic.pkl"

    import pickle

    with candidate_path.open("wb") as f:
        pickle.dump(iso, f)

    metadata = {
        "market": market,
        "window_days": window_days,
        "n_graded": n_graded,
        "n_train": len(train),
        "n_holdout": len(holdout),
        "baseline_logloss": baseline,
        "fitted_logloss": fitted,
        "fitted_at": datetime.now(timezone.utc).isoformat(),
    }
    with (CANDIDATES_DIR / f"{market}_metadata.json").open("w") as f:
        json.dump(metadata, f, indent=2)

    promoted = False
    reason = "candidate_written_only"
    if not dry_run:
        # Promote: copy candidate to live path, atomically.
        shutil.copyfile(candidate_path, live_path.with_suffix(".pkl.tmp"))
        os.replace(live_path.with_suffix(".pkl.tmp"), live_path)
        promoted = True
        reason = "promoted"

    return FitResult(
        market=market,
        n_total=n_graded,
        n_graded=n_graded,
        n_train=len(train),
        n_holdout=len(holdout),
        baseline_logloss=baseline,
        fitted_logloss=fitted,
        promoted=promoted,
        reason=reason,
    )


# ---------------------------------------------------------------------------
# Loader (for the worker /predict path)
# ---------------------------------------------------------------------------


def load_calibrator(market: str):
    """Load the live calibrator for `market`. Returns None if absent.

    The worker's /predict path applies this to raw probability before EV
    computation, IF a calibrator exists for the market. Markets without a
    promoted calibrator continue to use raw model output (identity).
    """
    path = CALIBRATION_DIR / f"{market}_isotonic.pkl"
    if not path.exists():
        return None
    import pickle

    with path.open("rb") as f:
        return pickle.load(f)


def apply_calibrator(calibrator, raw_prob: float) -> float:
    """Apply a loaded isotonic calibrator to a raw probability."""
    if calibrator is None:
        return raw_prob
    arr = np.asarray([raw_prob])
    return float(calibrator.predict(arr)[0])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Per-market isotonic recalibration with promotion gate")
    parser.add_argument("--market", choices=MARKETS, help="Single market to fit (default: all)")
    parser.add_argument("--window-days", type=int, default=DEFAULT_WINDOW_DAYS)
    parser.add_argument("--dry-run", action="store_true", help="Fit but do not promote to live path")
    args = parser.parse_args(argv)

    markets = (args.market,) if args.market else MARKETS
    results: list[FitResult] = []
    for market in markets:
        result = fit_and_maybe_promote(market, args.window_days, dry_run=args.dry_run)
        results.append(result)
        print(json.dumps({
            "market": result.market,
            "n_graded": result.n_graded,
            "n_train": result.n_train,
            "n_holdout": result.n_holdout,
            "baseline_logloss": result.baseline_logloss,
            "fitted_logloss": result.fitted_logloss,
            "promoted": result.promoted,
            "reason": result.reason,
        }))

    promoted_count = sum(1 for r in results if r.promoted)
    return 0 if promoted_count == 0 or all(r.promoted or "insufficient" in r.reason or "no_logloss_improvement" in r.reason for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
