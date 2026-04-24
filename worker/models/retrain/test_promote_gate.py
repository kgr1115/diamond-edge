"""
Unit tests for the null-prior manual-signoff gate (pick-scope-gate proposal #4,
2026-04-24). Covers the four mandatory cases from the scope-gate verdict:

  1. null prior + no force flag                     -> promote = false
  2. null prior + force flag + best_iter == 1       -> still rejected
  3. null prior + force flag + best_iter == 20      -> promote = true
  4. non-null prior + existing gate logic           -> unchanged behavior

Plus tests for promote.py:
  - refuses when the artifact directory does not exist
  - refuses when metrics.json is missing
  - refuses when lgbm_best_iteration == 1 (without --allow-degenerate)
  - writes a valid current_version.json pointer in the happy path
  - allow_degenerate override works
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Ensure repo root on sys.path so `worker.models.retrain.*` imports work when
# pytest is invoked from anywhere in the repo.
ROOT = Path(__file__).parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from worker.models.retrain.monthly import (  # noqa: E402
    check_variance_collapse,
    should_promote,
)
from worker.models.retrain import promote as promote_mod  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _metrics(
    log_loss: float = 0.67,
    clv_pct: float | None = 0.0,
    best_iter: int = 20,
    nonzero_delta_rate_02: float = 0.55,
    delta_std: float = 0.045,
    variance_collapsed: bool | None = None,
    variance_collapse_reasons: list[str] | None = None,
) -> dict:
    """Default values reflect healthy B2 totals-range metrics (well above the
    P7 collapse thresholds). Tests override the three collapse signals to
    exercise the guardrail."""
    metrics = {
        "market": "moneyline",
        "holdout_2024": {
            "n": 2000,
            "log_loss_new_model": log_loss,
            "log_loss_market_prior": 0.676,
            "log_loss_delta": -0.006,
            "nonzero_delta_rate_02": nonzero_delta_rate_02,
            "delta_std": delta_std,
        },
        "clv": {"n": 1800, "mean_clv_pct": clv_pct} if clv_pct is not None else None,
        "best_roi_pct": 5.2,
        "lgbm_best_iteration": best_iter,
    }
    if variance_collapsed is not None:
        metrics["variance_collapsed"] = variance_collapsed
        metrics["variance_collapse_reasons"] = variance_collapse_reasons or []
    return metrics


def _prior_version() -> dict:
    return {
        "version": "20260301T120000",
        "artifact_dir": "/tmp/fake-prior",
    }


# ---------------------------------------------------------------------------
# should_promote — null-prior branch (scope-gate mandatory cases 1-3)
# ---------------------------------------------------------------------------

class TestNullPriorGate:
    def test_null_prior_no_force_refuses(self):
        """Case 1: null prior + no --force-promote-no-prior => promote = false."""
        new_metrics = _metrics(best_iter=20)

        promote, reason = should_promote(
            "moneyline",
            new_metrics,
            prior_version=None,
            prior_metrics=None,
            force_promote_no_prior=False,
        )

        assert promote is False
        assert "awaiting manual sign-off" in reason.lower() or "first-train" in reason.lower()
        # Reason must direct the operator to promote.py
        assert "promote" in reason.lower()

    def test_null_prior_force_but_best_iter_one_refuses(self):
        """Case 2: null prior + force + lgbm_best_iteration == 1 => still rejected."""
        new_metrics = _metrics(best_iter=1)

        promote, reason = should_promote(
            "moneyline",
            new_metrics,
            prior_version=None,
            prior_metrics=None,
            force_promote_no_prior=True,
        )

        assert promote is False
        assert "lgbm_best_iteration" in reason
        # The sanity gate must name the moneyline-b2-v3 failure mode so the
        # operator understands why the override was overridden.
        assert "1" in reason

    def test_null_prior_force_and_healthy_model_promotes(self):
        """Case 3: null prior + force + healthy best_iter => promote = true."""
        new_metrics = _metrics(best_iter=20)

        promote, reason = should_promote(
            "moneyline",
            new_metrics,
            prior_version=None,
            prior_metrics=None,
            force_promote_no_prior=True,
        )

        assert promote is True
        assert "force-promote-no-prior" in reason

    def test_null_prior_force_best_iter_zero_refuses(self):
        """Best-iter 0 is the same failure mode as 1 (<=1 check)."""
        new_metrics = _metrics(best_iter=0)
        promote, reason = should_promote(
            "moneyline",
            new_metrics,
            prior_version=None,
            prior_metrics=None,
            force_promote_no_prior=True,
        )
        assert promote is False
        assert "lgbm_best_iteration" in reason


# ---------------------------------------------------------------------------
# should_promote — non-null-prior branch (scope-gate mandatory case 4)
# ---------------------------------------------------------------------------

class TestNonNullPriorGate:
    def test_clv_improves_and_log_loss_ok_promotes(self):
        """Existing CLV+log-loss gate: Δ CLV > +0.1pp AND no log_loss regression."""
        prior = _metrics(log_loss=0.680, clv_pct=0.0, best_iter=15)
        new = _metrics(log_loss=0.675, clv_pct=0.5, best_iter=25)

        promote, reason = should_promote(
            "moneyline", new, prior_version=_prior_version(), prior_metrics=prior,
        )

        assert promote is True
        assert "CLV delta" in reason
        assert "no regression" in reason

    def test_clv_does_not_improve_enough_refuses(self):
        prior = _metrics(log_loss=0.680, clv_pct=0.0, best_iter=15)
        new = _metrics(log_loss=0.675, clv_pct=0.05, best_iter=25)  # < +0.1pp

        promote, reason = should_promote(
            "moneyline", new, prior_version=_prior_version(), prior_metrics=prior,
        )
        assert promote is False
        assert "CLV delta" in reason

    def test_log_loss_regression_refuses(self):
        prior = _metrics(log_loss=0.670, clv_pct=0.0, best_iter=15)
        new = _metrics(log_loss=0.680, clv_pct=0.5, best_iter=25)  # regressed log_loss

        promote, reason = should_promote(
            "moneyline", new, prior_version=_prior_version(), prior_metrics=prior,
        )
        assert promote is False
        assert "log_loss" in reason

    def test_non_null_prior_ignores_force_flag(self):
        """Force flag must only affect the null-prior branch."""
        prior = _metrics(log_loss=0.680, clv_pct=0.0, best_iter=15)
        new = _metrics(log_loss=0.680, clv_pct=0.05, best_iter=25)  # below CLV threshold

        promote, _ = should_promote(
            "moneyline", new, prior_version=_prior_version(), prior_metrics=prior,
            force_promote_no_prior=True,
        )
        assert promote is False


# ---------------------------------------------------------------------------
# check_variance_collapse — P7 guardrail (2026-04-24)
# ---------------------------------------------------------------------------

class TestVarianceCollapseHelper:
    """Thresholds reference moneyline-b2-v1's failure values: lgbm_best_iteration=1,
    nonzero_delta_rate_02=0.0, delta_std=0.0027. Each test exercises one signal."""

    def test_healthy_artifact_not_flagged(self):
        """Run-line-like healthy values: 25 iterations, 0.88 nonzero rate, 0.136 std."""
        metrics = _metrics(
            best_iter=25, nonzero_delta_rate_02=0.88, delta_std=0.136,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is False
        assert reasons == []

    def test_best_iter_one_flags(self):
        """B2 moneyline actual: lgbm_best_iteration=1. Must trip the guardrail."""
        metrics = _metrics(
            best_iter=1, nonzero_delta_rate_02=0.55, delta_std=0.045,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is True
        assert any("lgbm_best_iteration" in r for r in reasons)

    def test_best_iter_zero_flags(self):
        """Edge case: iter 0 shares the <=1 failure mode with iter 1."""
        metrics = _metrics(
            best_iter=0, nonzero_delta_rate_02=0.55, delta_std=0.045,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is True
        assert any("lgbm_best_iteration=0" in r for r in reasons)

    def test_nonzero_delta_rate_zero_flags(self):
        """B2 moneyline actual: nonzero_delta_rate_02=0.0. Pure market-prior passthrough."""
        metrics = _metrics(
            best_iter=20, nonzero_delta_rate_02=0.0, delta_std=0.045,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is True
        assert any("nonzero_delta_rate_02" in r for r in reasons)

    def test_nonzero_delta_rate_just_below_threshold_flags(self):
        """0.09 is below the 0.1 threshold by 0.01; must still flag."""
        metrics = _metrics(
            best_iter=20, nonzero_delta_rate_02=0.09, delta_std=0.045,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is True

    def test_nonzero_delta_rate_at_threshold_does_not_flag(self):
        """0.1 exactly — not strictly less than 0.1, so healthy side of the gate."""
        metrics = _metrics(
            best_iter=20, nonzero_delta_rate_02=0.1, delta_std=0.045,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is False

    def test_delta_std_collapsed_flags(self):
        """B2 moneyline actual: delta_std=0.0027. Tight-band collapse."""
        metrics = _metrics(
            best_iter=20, nonzero_delta_rate_02=0.55, delta_std=0.0027,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is True
        assert any("delta_std" in r for r in reasons)

    def test_delta_std_at_threshold_does_not_flag(self):
        """0.005 exactly — at the threshold, not below, so healthy."""
        metrics = _metrics(
            best_iter=20, nonzero_delta_rate_02=0.55, delta_std=0.005,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is False

    def test_all_three_signals_flag_all_three_reasons(self):
        """Full B2 moneyline failure — all three signals fire simultaneously."""
        metrics = _metrics(
            best_iter=1, nonzero_delta_rate_02=0.0, delta_std=0.0027,
        )
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is True
        assert len(reasons) == 3
        joined = " ".join(reasons)
        assert "lgbm_best_iteration" in joined
        assert "nonzero_delta_rate_02" in joined
        assert "delta_std" in joined

    def test_missing_metrics_does_not_flag(self):
        """Training-errored markets are handled via the error branch upstream;
        a metrics dict with no holdout_2024 key must not be treated as collapsed."""
        metrics = {"market": "moneyline", "error": "insufficient data"}
        collapsed, reasons = check_variance_collapse(metrics)
        assert collapsed is False
        assert reasons == []


# ---------------------------------------------------------------------------
# should_promote — variance-collapse refusal (P7 integration)
# ---------------------------------------------------------------------------

class TestVarianceCollapsePromoteGate:
    def test_variance_collapsed_null_prior_refuses(self):
        """Variance-collapsed flag short-circuits the null-prior happy path —
        even force-promote-no-prior cannot rescue it."""
        new_metrics = _metrics(
            best_iter=20, nonzero_delta_rate_02=0.55, delta_std=0.045,
            variance_collapsed=True,
            variance_collapse_reasons=["delta_std=0.004 < 0.005 (fabricated)"],
        )
        promote, reason = should_promote(
            "moneyline",
            new_metrics,
            prior_version=None,
            prior_metrics=None,
            force_promote_no_prior=True,
        )
        assert promote is False
        assert "variance-collapsed" in reason.lower()

    def test_variance_collapsed_with_good_prior_refuses(self):
        """Even a perfectly-winning CLV/log-loss new model is refused if the
        retrain flagged variance_collapsed=true."""
        prior = _metrics(
            log_loss=0.680, clv_pct=0.0, best_iter=15,
            nonzero_delta_rate_02=0.55, delta_std=0.045,
        )
        new = _metrics(
            log_loss=0.670, clv_pct=0.5, best_iter=25,
            nonzero_delta_rate_02=0.55, delta_std=0.045,
            variance_collapsed=True,
            variance_collapse_reasons=["nonzero_delta_rate_02=0.05 (fabricated)"],
        )
        promote, reason = should_promote(
            "moneyline", new, prior_version=_prior_version(), prior_metrics=prior,
        )
        assert promote is False
        assert "variance-collapsed" in reason.lower()

    def test_healthy_metrics_unaffected(self):
        """Healthy new model (no flag) with winning CLV + non-regressing log_loss
        still promotes cleanly — guardrail only fires when the flag is set."""
        prior = _metrics(
            log_loss=0.680, clv_pct=0.0, best_iter=15,
            nonzero_delta_rate_02=0.55, delta_std=0.045,
        )
        new = _metrics(
            log_loss=0.675, clv_pct=0.5, best_iter=25,
            nonzero_delta_rate_02=0.55, delta_std=0.045,
            variance_collapsed=False,
            variance_collapse_reasons=[],
        )
        promote, reason = should_promote(
            "moneyline", new, prior_version=_prior_version(), prior_metrics=prior,
        )
        assert promote is True
        assert "CLV delta" in reason


# ---------------------------------------------------------------------------
# promote.py — happy path + refusals
# ---------------------------------------------------------------------------

def _make_artifact(models_dir: Path, market: str, ts: str, metrics: dict) -> Path:
    artifact_dir = models_dir / market / "artifacts" / f"v{ts}"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    with open(artifact_dir / "metrics.json", "w") as f:
        json.dump(metrics, f)
    return artifact_dir


class TestPromoteScript:
    def test_missing_artifact_refuses(self, tmp_path: Path):
        with pytest.raises(FileNotFoundError):
            promote_mod.promote(
                market="moneyline",
                timestamp="20260101T000000",
                models_dir=tmp_path,
            )

    def test_missing_metrics_json_refuses(self, tmp_path: Path):
        (tmp_path / "moneyline" / "artifacts" / "v20260424T120000").mkdir(parents=True)
        with pytest.raises(FileNotFoundError):
            promote_mod.promote(
                market="moneyline",
                timestamp="20260424T120000",
                models_dir=tmp_path,
            )

    def test_degenerate_model_refuses_by_default(self, tmp_path: Path):
        _make_artifact(tmp_path, "moneyline", "20260424T120000", _metrics(best_iter=1))
        with pytest.raises(ValueError, match="lgbm_best_iteration"):
            promote_mod.promote(
                market="moneyline",
                timestamp="20260424T120000",
                models_dir=tmp_path,
            )

    def test_degenerate_model_allowed_with_override(self, tmp_path: Path):
        _make_artifact(tmp_path, "moneyline", "20260424T120000", _metrics(best_iter=1))
        pointer = promote_mod.promote(
            market="moneyline",
            timestamp="20260424T120000",
            models_dir=tmp_path,
            allow_degenerate=True,
        )
        assert pointer["version"] == "20260424T120000"
        pointer_path = tmp_path / "moneyline" / "artifacts" / "current_version.json"
        assert pointer_path.is_file()

    def test_unknown_market_refuses(self, tmp_path: Path):
        with pytest.raises(ValueError, match="Unknown market"):
            promote_mod.promote(
                market="props",
                timestamp="20260424T120000",
                models_dir=tmp_path,
            )

    def test_happy_path_writes_pointer(self, tmp_path: Path):
        """The 4th scope-gate case: promote.py flip WORKS end-to-end."""
        _make_artifact(
            tmp_path, "moneyline", "20260424T120000",
            _metrics(log_loss=0.672, clv_pct=0.5, best_iter=25),
        )

        pointer = promote_mod.promote(
            market="moneyline",
            timestamp="20260424T120000",
            models_dir=tmp_path,
        )

        assert pointer["version"] == "20260424T120000"
        assert pointer["log_loss"] == 0.672
        assert pointer["clv_pct"] == 0.5
        assert pointer["lgbm_best_iteration"] == 25

        pointer_path = tmp_path / "moneyline" / "artifacts" / "current_version.json"
        assert pointer_path.is_file()
        with open(pointer_path) as f:
            on_disk = json.load(f)
        assert on_disk["version"] == "20260424T120000"
        assert on_disk["promoted_by"] == "worker.models.retrain.promote"

    def test_dry_run_does_not_write(self, tmp_path: Path):
        _make_artifact(
            tmp_path, "moneyline", "20260424T120000",
            _metrics(best_iter=25),
        )
        promote_mod.promote(
            market="moneyline",
            timestamp="20260424T120000",
            models_dir=tmp_path,
            dry_run=True,
        )
        pointer_path = tmp_path / "moneyline" / "artifacts" / "current_version.json"
        assert not pointer_path.exists()

    def test_variance_collapsed_flag_refuses_by_default(self, tmp_path: Path):
        """P7 symmetry: promote.py refuses a variance-collapsed artifact without
        --allow-degenerate, mirroring the iter<=1 refusal."""
        _make_artifact(
            tmp_path, "moneyline", "20260424T120000",
            _metrics(
                best_iter=25,
                variance_collapsed=True,
                variance_collapse_reasons=["delta_std=0.003 < 0.005 (fabricated)"],
            ),
        )
        with pytest.raises(ValueError, match="variance_collapsed"):
            promote_mod.promote(
                market="moneyline",
                timestamp="20260424T120000",
                models_dir=tmp_path,
            )

    def test_variance_collapsed_flag_allowed_with_override(self, tmp_path: Path):
        """--allow-degenerate covers both the iter<=1 refusal and the P7 flag."""
        _make_artifact(
            tmp_path, "moneyline", "20260424T120000",
            _metrics(
                best_iter=25,
                variance_collapsed=True,
                variance_collapse_reasons=["delta_std=0.003 < 0.005 (fabricated)"],
            ),
        )
        pointer = promote_mod.promote(
            market="moneyline",
            timestamp="20260424T120000",
            models_dir=tmp_path,
            allow_degenerate=True,
        )
        assert pointer["version"] == "20260424T120000"
        # Flag must surface in the pointer so the pick pipeline can notice.
        assert pointer["variance_collapsed"] is True

    def test_healthy_artifact_pointer_records_variance_collapsed_false(self, tmp_path: Path):
        """Healthy artifacts must carry variance_collapsed=false in the pointer
        so downstream tooling can always read the flag."""
        _make_artifact(
            tmp_path, "moneyline", "20260424T120000",
            _metrics(
                best_iter=25,
                variance_collapsed=False,
                variance_collapse_reasons=[],
            ),
        )
        pointer = promote_mod.promote(
            market="moneyline",
            timestamp="20260424T120000",
            models_dir=tmp_path,
        )
        assert pointer["variance_collapsed"] is False
