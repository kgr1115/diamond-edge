"""
Unit tests for the near-zero SHAP filter in sort_attributions
(pick-scope-gate proposal #6, 2026-04-24).

Spec:
  - Drop attributions with |shap_value| < SHAP_NEAR_ZERO_THRESHOLD (1e-4).
  - If fewer than MIN_ATTRIBUTIONS_FLOOR (2) survive, backfill with the
    next-highest-by-magnitude dropped entries so the rationale generator
    always has at least the Pro-tier citation floor to work with.
  - Deterministic: same input -> same output (for cache-hash stability).

Fixtures mirror the three cases called out in the pick-implementer brief:
  (a) all-zero SHAP vector                 -> fallback backfills to floor
  (b) mix of zero + non-zero SHAP          -> non-trivial kept, zeros dropped
  (c) all strongly-non-zero SHAP           -> everything kept (up to top_k)
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from worker.models.pick_candidate_schema import (  # noqa: E402
    FeatureAttribution,
    MIN_ATTRIBUTIONS_FLOOR,
    SHAP_NEAR_ZERO_THRESHOLD,
    sort_attributions,
)


def _attr(name: str, shap: float) -> FeatureAttribution:
    return FeatureAttribution(
        feature_name=name,
        feature_value=1.0,
        shap_value=shap,
        direction="positive" if shap >= 0 else "negative",
        label=f"{name}: 1.00",
    )


# ---------------------------------------------------------------------------
# Fixture (a) — all-zero: degenerate B2 moneyline case
# ---------------------------------------------------------------------------
def test_all_zero_falls_back_to_floor():
    attrs = [_attr(f"f{i}", 0.0) for i in range(7)]
    out = sort_attributions(attrs)
    # Fallback fills to floor even though every entry is noise — the warning
    # log is emitted; callers higher up (rationale generator) decide whether
    # to hedge the rationale.
    assert len(out) == MIN_ATTRIBUTIONS_FLOOR


def test_all_zero_deterministic():
    attrs = [_attr(f"f{i}", 0.0) for i in range(7)]
    out1 = sort_attributions(attrs)
    out2 = sort_attributions(attrs)
    assert [a.feature_name for a in out1] == [a.feature_name for a in out2]


# ---------------------------------------------------------------------------
# Fixture (b) — mix of zero + non-zero: typical degenerate-model-with-signal
# ---------------------------------------------------------------------------
def test_mixed_drops_near_zero_keeps_signal():
    attrs = [
        _attr("strong_pos", 0.05),
        _attr("strong_neg", -0.03),
        _attr("medium", 0.002),
        _attr("tiny_pos", 5e-5),      # below threshold
        _attr("tiny_neg", -2e-5),     # below threshold
        _attr("zero_a", 0.0),
        _attr("zero_b", 0.0),
    ]
    out = sort_attributions(attrs)
    names = [a.feature_name for a in out]
    assert names == ["strong_pos", "strong_neg", "medium"]
    # Explicitly: no sub-threshold entry appears.
    assert all(abs(a.shap_value) >= SHAP_NEAR_ZERO_THRESHOLD for a in out)


def test_mixed_with_single_signal_backfills_to_floor():
    attrs = [
        _attr("only_signal", 0.01),
        _attr("noise_a", 5e-6),
        _attr("noise_b", 0.0),
        _attr("noise_c", 0.0),
    ]
    out = sort_attributions(attrs)
    # 1 above threshold + floor=2 => backfill adds the next-largest-by-magnitude
    # entry from the sub-threshold pool.
    assert len(out) == MIN_ATTRIBUTIONS_FLOOR
    assert out[0].feature_name == "only_signal"
    assert out[1].feature_name == "noise_a"  # largest magnitude among dropped


# ---------------------------------------------------------------------------
# Fixture (c) — all strongly-non-zero: healthy-model case
# ---------------------------------------------------------------------------
def test_all_strong_keeps_all_up_to_top_k():
    attrs = [_attr(f"f{i}", 0.01 * (i + 1)) for i in range(10)]
    out = sort_attributions(attrs)
    assert len(out) == 7  # default top_k
    # Sorted by |shap| desc, so largest magnitudes come first.
    assert out[0].feature_name == "f9"
    assert out[-1].feature_name == "f3"


def test_all_strong_no_warning_emitted(capsys):
    attrs = [_attr(f"f{i}", 0.01 * (i + 1)) for i in range(5)]
    sort_attributions(attrs)
    captured = capsys.readouterr()
    assert "near-zero SHAP filter" not in captured.out


# ---------------------------------------------------------------------------
# Determinism & ordering sanity
# ---------------------------------------------------------------------------
def test_determinism_hash_stable_across_calls():
    """
    Same input -> same output list (same order).  This is the property the
    rationale cache hash relies on.
    """
    attrs = [
        _attr("a", 0.01),
        _attr("b", -0.02),
        _attr("c", 0.0),
        _attr("d", 3e-5),
        _attr("e", 0.005),
    ]
    runs = [sort_attributions(attrs) for _ in range(5)]
    signatures = [tuple((a.feature_name, a.shap_value) for a in r) for r in runs]
    assert all(s == signatures[0] for s in signatures)


def test_ordering_is_by_abs_shap_desc():
    attrs = [
        _attr("small", 0.002),
        _attr("largest_neg", -0.08),
        _attr("medium", 0.015),
    ]
    out = sort_attributions(attrs)
    assert [a.feature_name for a in out] == ["largest_neg", "medium", "small"]


def test_empty_input_returns_empty():
    assert sort_attributions([]) == []


# ---------------------------------------------------------------------------
# Threshold boundary
# ---------------------------------------------------------------------------
def test_exactly_threshold_is_kept():
    attrs = [
        _attr("on_threshold", SHAP_NEAR_ZERO_THRESHOLD),
        _attr("just_below", SHAP_NEAR_ZERO_THRESHOLD / 2),
        _attr("zero", 0.0),
    ]
    out = sort_attributions(attrs)
    # >= threshold survives; strictly-below is filtered but backfilled to floor.
    assert out[0].feature_name == "on_threshold"
    assert len(out) == MIN_ATTRIBUTIONS_FLOOR


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
