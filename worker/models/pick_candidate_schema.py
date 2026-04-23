"""
Diamond Edge — PickCandidate Schema (ML Model Output)

This module defines the Python dataclass contract that the Fly.io ML worker produces
and the AI Reasoning agent consumes. It exactly mirrors the TypeScript PickCandidate
interface in docs/api/ml-output-contract.md.

Every field name, type, and constraint matches the contract. Changes here require
coordinated updates to the TypeScript interface and the AI Reasoning prompt templates.

Usage:
    from worker.models.pick_candidate_schema import PickCandidate, build_pick_candidate
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Literal, Union
import json


MarketType = Literal["moneyline", "run_line", "total", "prop"]
PickSideType = str  # 'home' | 'away' | 'over' | 'under' | prop description
ConfidenceTier = Literal[1, 2, 3, 4, 5]
SportsbookKey = Literal["draftkings", "fanduel"]
FeatureDirection = Literal["positive", "negative"]


@dataclass(frozen=True)
class BestLine:
    """
    The best available sportsbook line used for EV computation.
    Frozen: treat as immutable once constructed.
    """
    price: int
    """American odds, e.g. -110, +150. Negative = favorite, positive = underdog."""

    sportsbook_key: SportsbookKey
    """'draftkings' or 'fanduel' — matches sportsbooks.key in Supabase."""

    snapshotted_at: str
    """ISO 8601 UTC timestamp: when this line was pulled from The Odds API."""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class FeatureAttribution:
    """
    SHAP-style feature attribution for a single feature driving this pick.

    The AI Reasoning agent MUST cite only facts present in this structure.
    The `label` field is the human-readable string the rationale should use directly.
    The `shap_value` field is in log-odds space (positive = toward pick_side winning).

    Top 7 attributions by |shap_value| are included in PickCandidate.feature_attributions.
    """
    feature_name: str
    """
    Machine-readable feature identifier. Must exactly match a key in PickCandidate.features
    and the feature names defined in the market-specific feature-spec.md files.
    Examples: 'home_sp_era_last_30d', 'weather_wind_factor', 'park_run_factor'
    """

    feature_value: Union[float, int, str]
    """
    Actual value of the feature for this game.
    Numeric: e.g. 2.87 (ERA), 18 (wind mph × direction), 114 (park factor)
    String: e.g. 'left' (pitcher handedness), 'dome' (venue type)
    """

    shap_value: float
    """
    SHAP contribution to the model's log-odds output.
    Positive → pushes prediction toward pick_side winning.
    Negative → pushes prediction away from pick_side winning.
    Magnitude indicates strength of influence.
    """

    direction: FeatureDirection
    """
    'positive' if shap_value > 0 (feature supports the pick).
    'negative' if shap_value < 0 (feature argues against the pick).
    Redundant with shap_value sign but explicit for AI Reasoning readability.
    """

    label: str
    """
    Human-readable label for use in rationale text. AI Reasoning agent cites this verbatim.
    Format: '{Human Feature Name}: {formatted_value} ({optional context})'
    Examples:
      'Home Starter ERA (30-day): 2.14'
      'Away Bullpen Load (2-day IP): 7.2 innings — elevated fatigue'
      'Wind: 18 mph blowing out to CF (offense-favored conditions)'
      'Park Run Factor: 114 (well above average — Coors Field effect)'
    """

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PickCandidate:
    """
    ML model output for a single market/game combination where EV > 0
    and confidence_tier >= 3 (EV > 4%).

    Produced by the Fly.io worker /predict endpoint.
    Consumed by the AI Reasoning agent and the pick pipeline.
    Written to the Supabase picks table (with some fields flattened).

    Field-for-field match to the TypeScript PickCandidate interface in
    docs/api/ml-output-contract.md.
    """

    # ── Identity ──────────────────────────────────────────────────────────────

    game_id: str
    """UUID matching games.id in Supabase."""

    market: MarketType
    """Market type. Props deferred to v1.1 but included in type for forward compatibility."""

    pick_side: str
    """
    Which side of the market the model recommends.
    Moneyline / run_line: 'home' or 'away'
    Total: 'over' or 'under'
    Prop: free-text description, e.g. 'Gerrit Cole over 7.5 strikeouts'
    """

    # ── Model Outputs ─────────────────────────────────────────────────────────

    model_probability: float
    """
    Calibrated probability that pick_side wins/covers/hits, 0.0–1.0.
    This is the Platt-scaled output of the LightGBM model.
    Pro and Elite tier users see this field directly.
    """

    implied_probability: float
    """
    Market's implied probability for pick_side from the best available line.
    implied_prob = 1 / decimal_odds (with vig removed for fair probability comparison).
    Formula for American odds:
      positive (+150): 100 / (100 + 150) = 0.400
      negative (-130): 130 / (100 + 130) = 0.565
    Note: this is the raw implied probability including vig, NOT the no-vig fair probability.
    EV computation uses the net payout directly, not this field.
    """

    expected_value: float
    """
    Expected value per $1 wagered.
    Formula: model_probability * net_payout - (1 - model_probability)
    where net_payout = abs_odds/100 for positive odds, 100/abs_odds for negative odds.
    e.g., EV of 0.042 = 4.2 cents per $1 wagered (4.2% edge).
    Elite tier users see this field.
    """

    confidence_tier: ConfidenceTier
    """
    Confidence tier 1–5. Derived from EV + bootstrap uncertainty.
    See calibration-spec.md for full derivation.
    Tier 1: EV 0–2% | Tier 2: EV 2–4% | Tier 3: EV 4–6% (min publication threshold)
    Tier 4: EV 6–9% | Tier 5: EV >9%
    High bootstrap uncertainty can knock tier down by 1.
    """

    # ── Best Line ─────────────────────────────────────────────────────────────

    best_line: BestLine
    """
    The best available sportsbook line used for EV computation.
    Selected as the maximum American odds across DK and FD for the pick_side.
    """

    # ── Feature Attributions (SHAP) ───────────────────────────────────────────

    feature_attributions: list[FeatureAttribution] = field(default_factory=list)
    """
    Top 7 features by |shap_value| driving this pick.
    Sorted by abs(shap_value) descending (strongest contributor first).

    The AI Reasoning agent:
    1. Must only cite features present in this list.
    2. Uses the `label` field verbatim in rationale text.
    3. Leads with the top attribution (highest |shap_value|).
    4. Never references model architecture (LightGBM, SHAP) in the rationale.

    If this list is empty, the rationale endpoint returns an error — picks
    with empty attributions are not published. This is enforced in the pipeline.
    """

    # ── Full Feature Vector (Audit / Retraining) ──────────────────────────────

    features: dict[str, Union[float, int, str, None]] = field(default_factory=dict)
    """
    Complete feature vector used to generate this pick.
    Keys match feature_name values in the market's feature-spec.md.
    Used for:
    - Audit trail (what did the model see?)
    - Retraining data collection
    - Debugging unexpected picks
    Not exposed to users at any tier.
    """

    # ── Model Metadata ────────────────────────────────────────────────────────

    model_version: str = "moneyline-v1.0.0"
    """
    Semantic version of the model artifact that produced this pick.
    Format: '{market}-v{major}.{minor}.{patch}'
    Examples: 'moneyline-v1.0.0', 'run_line-v1.0.0', 'totals-v1.0.0'
    Stored in Supabase for drift monitoring.
    """

    generated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    """ISO 8601 UTC timestamp: when this PickCandidate was produced by the model."""

    # ── Validation ────────────────────────────────────────────────────────────

    def __post_init__(self) -> None:
        self._validate()

    def _validate(self) -> None:
        """
        Runtime validation of invariants. Raises ValueError on contract violation.
        Called automatically by dataclass __post_init__.
        """
        if not (0.0 <= self.model_probability <= 1.0):
            raise ValueError(
                f"model_probability must be in [0, 1], got {self.model_probability}"
            )

        if not (0.0 <= self.implied_probability <= 1.0):
            raise ValueError(
                f"implied_probability must be in [0, 1], got {self.implied_probability}"
            )

        if self.confidence_tier not in (1, 2, 3, 4, 5):
            raise ValueError(
                f"confidence_tier must be 1–5, got {self.confidence_tier}"
            )

        if self.market not in ("moneyline", "run_line", "total", "prop"):
            raise ValueError(f"Unknown market: {self.market!r}")

        if len(self.feature_attributions) == 0:
            raise ValueError(
                "feature_attributions must not be empty. "
                "Picks without SHAP attributions cannot be published."
            )

        if len(self.feature_attributions) > 10:
            raise ValueError(
                f"feature_attributions should contain at most 10 entries, "
                f"got {len(self.feature_attributions)}. Top 7 is recommended."
            )

        if self.best_line.sportsbook_key not in ("draftkings", "fanduel"):
            raise ValueError(
                f"sportsbook_key must be 'draftkings' or 'fanduel', "
                f"got {self.best_line.sportsbook_key!r}"
            )

        for attr in self.feature_attributions:
            if attr.direction != ("positive" if attr.shap_value > 0 else "negative"):
                # Allow shap_value == 0 as either direction
                if attr.shap_value != 0:
                    raise ValueError(
                        f"Feature '{attr.feature_name}': direction '{attr.direction}' "
                        f"is inconsistent with shap_value {attr.shap_value}"
                    )

    # ── Serialization ─────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        """Serialize to dict for JSON response from Fly.io /predict endpoint."""
        return {
            "game_id": self.game_id,
            "market": self.market,
            "pick_side": self.pick_side,
            "model_probability": round(self.model_probability, 4),
            "implied_probability": round(self.implied_probability, 4),
            "expected_value": round(self.expected_value, 4),
            "confidence_tier": self.confidence_tier,
            "best_line": self.best_line.to_dict(),
            "feature_attributions": [a.to_dict() for a in self.feature_attributions],
            "features": self.features,
            "model_version": self.model_version,
            "generated_at": self.generated_at,
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), default=str)

    @classmethod
    def from_dict(cls, data: dict) -> "PickCandidate":
        """Deserialize from dict (e.g., HTTP response body from /predict)."""
        best_line = BestLine(
            price=data["best_line"]["price"],
            sportsbook_key=data["best_line"]["sportsbook_key"],
            snapshotted_at=data["best_line"]["snapshotted_at"],
        )
        feature_attributions = [
            FeatureAttribution(
                feature_name=a["feature_name"],
                feature_value=a["feature_value"],
                shap_value=a["shap_value"],
                direction=a["direction"],
                label=a["label"],
            )
            for a in data.get("feature_attributions", [])
        ]
        return cls(
            game_id=data["game_id"],
            market=data["market"],
            pick_side=data["pick_side"],
            model_probability=data["model_probability"],
            implied_probability=data["implied_probability"],
            expected_value=data["expected_value"],
            confidence_tier=data["confidence_tier"],
            best_line=best_line,
            feature_attributions=feature_attributions,
            features=data.get("features", {}),
            model_version=data.get("model_version", "unknown"),
            generated_at=data.get("generated_at", ""),
        )


# ── Helper Functions ───────────────────────────────────────────────────────────

def compute_implied_probability(american_odds: int) -> float:
    """
    Convert American odds to implied probability (includes vig).
    Used to populate PickCandidate.implied_probability.
    """
    if american_odds > 0:
        return 100.0 / (100.0 + american_odds)
    else:
        return abs(american_odds) / (abs(american_odds) + 100.0)


def compute_ev(model_probability: float, american_odds: int) -> float:
    """
    Compute expected value per $1 wagered.
    model_probability: calibrated P(pick_side wins), 0.0–1.0
    american_odds: best available odds for pick_side (American format)
    Returns: EV per $1 (e.g., 0.042 = 4.2 cents edge per $1 bet)
    """
    if american_odds > 0:
        net_win = american_odds / 100.0
    else:
        net_win = 100.0 / abs(american_odds)

    return model_probability * net_win - (1.0 - model_probability) * 1.0


def select_best_line(
    dk_odds: int | None,
    fd_odds: int | None,
) -> tuple[int, SportsbookKey] | None:
    """
    Select the best (highest) odds for a pick_side across DK and FD.
    Higher American odds = better payout = more favorable for the bettor.
    Returns (best_price, sportsbook_key) or None if no lines available.
    """
    candidates = []
    if dk_odds is not None:
        candidates.append((dk_odds, "draftkings"))
    if fd_odds is not None:
        candidates.append((fd_odds, "fanduel"))

    if not candidates:
        return None

    # Higher American odds = better (e.g., +120 > +100 > -110 > -130)
    return max(candidates, key=lambda x: x[0])


def sort_attributions(attributions: list[FeatureAttribution]) -> list[FeatureAttribution]:
    """Sort feature attributions by absolute SHAP value, descending. Top 7 returned."""
    sorted_attrs = sorted(attributions, key=lambda a: abs(a.shap_value), reverse=True)
    return sorted_attrs[:7]
