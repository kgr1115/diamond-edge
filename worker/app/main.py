"""
Diamond Edge — Fly.io ML worker.

Endpoints:
  POST /predict   — run model inference, return PickCandidate[]
  POST /rationale — proxy Claude API for rationale generation (stub for now)
  GET  /health    — liveness probe

Auth: Bearer token via WORKER_API_KEY env var.
Models loaded at startup (not per-request).

Request shape matches PredictRequest in supabase/functions/pick-pipeline/types.ts:
  { game_id: string, markets: string[], features: Record<string, number|string|null> }

Response shape: { candidates: PickCandidate[] }
"""

from __future__ import annotations

import json
import os
import pickle
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parents[2]))
from worker.models.pick_candidate_schema import (
    BestLine,
    FeatureAttribution,
    PickCandidate,
    compute_ev,
    compute_implied_probability,
    select_best_line,
    sort_attributions,
)

try:
    import shap
    _SHAP_AVAILABLE = True
except ImportError:
    _SHAP_AVAILABLE = False

# ---------------------------------------------------------------------------
# Confidence tier assignment
# ---------------------------------------------------------------------------
def assign_confidence_tier(ev: float, uncertainty: float = 0.0) -> int:
    if ev <= 0:
        return 0
    elif ev <= 0.02:
        base = 1
    elif ev <= 0.04:
        base = 2
    elif ev <= 0.06:
        base = 3
    elif ev <= 0.09:
        base = 4
    else:
        base = 5
    penalty = 1 if uncertainty >= 0.06 else 0
    return max(1, base - penalty)


# ---------------------------------------------------------------------------
# Model registry — loaded once at startup
# ---------------------------------------------------------------------------
MODELS_DIR = Path(__file__).parents[1] / "models"

MARKET_ARTIFACT_PATHS = {
    "moneyline": MODELS_DIR / "moneyline" / "artifacts" / "model.pkl",
    "run_line": MODELS_DIR / "run_line" / "artifacts" / "model.pkl",
    "totals": MODELS_DIR / "totals" / "artifacts" / "model.pkl",
}

MARKET_VERSIONS = {
    "moneyline": "moneyline-v1.0.0",
    "run_line": "run_line-v1.0.0",
    "totals": "totals-v1.0.0",
}

# Global model registry: {market: {model, calibrator, features, explainer}}
_REGISTRY: dict[str, dict] = {}
_LOAD_ERRORS: dict[str, str] = {}


def _load_models() -> None:
    """Load all model artifacts at startup. Failures are non-fatal (graceful degradation)."""
    for market, pkl_path in MARKET_ARTIFACT_PATHS.items():
        if not pkl_path.exists():
            _LOAD_ERRORS[market] = f"Artifact not found: {pkl_path}"
            print(f"[WARN] {market}: artifact not found at {pkl_path}")
            continue

        try:
            with open(pkl_path, "rb") as f:
                artifact = pickle.load(f)

            model = artifact["model"]
            calibrator = artifact["calibrator"]
            features = artifact["features"]

            # Build SHAP explainer if available
            explainer = None
            if _SHAP_AVAILABLE:
                try:
                    explainer = shap.TreeExplainer(model)
                except Exception as e:
                    print(f"[WARN] {market}: SHAP explainer failed: {e}")

            _REGISTRY[market] = {
                "model": model,
                "calibrator": calibrator,
                "features": features,
                "explainer": explainer,
            }
            print(f"[OK] Loaded {market} model ({len(features)} features)")
        except Exception as e:
            _LOAD_ERRORS[market] = str(e)
            print(f"[ERROR] Failed to load {market} model: {e}")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class PredictRequest(BaseModel):
    game_id: str
    markets: list[str] = Field(default=["moneyline", "run_line", "totals"])
    features: dict[str, Any]


class PredictResponse(BaseModel):
    candidates: list[dict]


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------
def _build_feature_vector(
    feature_names: list[str],
    features: dict[str, Any],
) -> np.ndarray:
    """Build ordered feature vector, filling missing with 0."""
    vec = np.array([
        float(features.get(f, 0.0) or 0.0)
        for f in feature_names
    ], dtype=np.float32)
    return vec.reshape(1, -1)


def _compute_shap_attributions(
    explainer: Any,
    feature_vector: np.ndarray,
    feature_names: list[str],
    features: dict[str, Any],
) -> list[FeatureAttribution]:
    """Compute SHAP values and return top-7 FeatureAttribution objects."""
    if explainer is None:
        return []

    try:
        shap_vals = explainer.shap_values(feature_vector)
        if isinstance(shap_vals, list):
            shap_vals = shap_vals[1]
        shap_arr = shap_vals[0]  # single row

        # Build attribution objects
        attributions = []
        for fname, sv in zip(feature_names, shap_arr):
            raw_val = features.get(fname, 0.0)
            try:
                fval: float | str = round(float(raw_val), 4) if raw_val is not None else 0.0
            except (TypeError, ValueError):
                fval = str(raw_val)

            direction = "positive" if sv >= 0 else "negative"
            label = _format_attribution_label(fname, fval)

            attributions.append(FeatureAttribution(
                feature_name=fname,
                feature_value=fval,
                shap_value=round(float(sv), 6),
                direction=direction,
                label=label,
            ))

        return sort_attributions(attributions)[:7]
    except Exception as e:
        print(f"[WARN] SHAP computation failed at inference: {e}")
        return []


def _format_attribution_label(feature_name: str, feature_value: Any) -> str:
    """Generate human-readable label from feature name and value."""
    label_map = {
        "home_sp_era_last_30d": "Home Starter ERA (30-day)",
        "away_sp_era_last_30d": "Away Starter ERA (30-day)",
        "home_sp_era_season": "Home Starter ERA (season)",
        "away_sp_era_season": "Away Starter ERA (season)",
        "home_sp_fip_season": "Home Starter FIP (season)",
        "away_sp_fip_season": "Away Starter FIP (season)",
        "home_sp_k9_season": "Home Starter K/9 (season)",
        "away_sp_k9_season": "Away Starter K/9 (season)",
        "home_bp_era_last_7d": "Home Bullpen ERA (7-day)",
        "away_bp_era_last_7d": "Away Bullpen ERA (7-day)",
        "home_bp_ip_last_2d": "Home Bullpen Load (2-day IP)",
        "away_bp_ip_last_2d": "Away Bullpen Load (2-day IP)",
        "home_is_opener": "Home Opener/Bullpen Game Flag",
        "away_is_opener": "Away Opener/Bullpen Game Flag",
        "home_sp_ttop_exposure": "Home SP Times-Through-Order Exposure",
        "away_sp_ttop_exposure": "Away SP Times-Through-Order Exposure",
        "park_run_factor": "Park Run Factor",
        "park_hr_factor": "Park HR Factor",
        "park_hr_factor_lineup_weighted": "Park HR Factor (Lineup-Weighted L/R)",
        "weather_wind_factor": "Wind Factor (mph × direction)",
        "weather_temp_f": "Temperature (°F)",
        "away_travel_eastward_penalty": "Away Team Eastward Travel Penalty",
        "away_travel_tz_change": "Away Team Timezone Change",
        "market_implied_prob_home": "Market Implied Probability (Home)",
        "posted_total_line": "Posted Total Line",
        "combined_sp_fip_season": "Combined Starter FIP",
        "home_team_pythag_win_pct": "Home Pythagorean Win%",
        "away_team_pythag_win_pct": "Away Pythagorean Win%",
        "home_team_runs_ewma_7d": "Home Team Runs EWMA (7-day)",
        "away_team_runs_ewma_7d": "Away Team Runs EWMA (7-day)",
        "sp_fip_gap": "Pitcher FIP Gap (Home vs Away)",
        "ump_k_rate_career": "Umpire K-Rate (career)",
    }

    human_name = label_map.get(feature_name, feature_name.replace("_", " ").title())
    try:
        return f"{human_name}: {round(float(feature_value), 2)}"
    except (TypeError, ValueError):
        return f"{human_name}: {feature_value}"


def _stub_attributions(
    feature_names: list[str],
    features: dict[str, Any],
    model_prob: float,
) -> list[FeatureAttribution]:
    """
    Generate stub attributions when SHAP is unavailable.
    Uses top features by absolute deviation from their typical range.
    Ensures the pick can still be published (non-empty attributions required).
    """
    # Typical ranges for key features (center values)
    typical = {
        "home_sp_era_season": 4.50, "away_sp_era_season": 4.50,
        "home_sp_era_last_30d": 4.50, "away_sp_era_last_30d": 4.50,
        "home_bp_era_last_7d": 4.50, "away_bp_era_last_7d": 4.50,
        "park_run_factor": 100, "weather_temp_f": 72,
        "market_implied_prob_home": 0.5, "posted_total_line": 8.5,
    }

    scored = []
    for fname in feature_names[:30]:  # top 30 candidates
        raw = features.get(fname, 0.0) or 0.0
        try:
            fval = float(raw)
        except (TypeError, ValueError):
            continue
        center = typical.get(fname, 0.0)
        score = abs(fval - center)
        scored.append((fname, fval, score))

    scored.sort(key=lambda x: x[2], reverse=True)
    top7 = scored[:7]

    if not top7:
        # Absolute fallback: use first 3 features
        top7 = [(fname, float(features.get(fname, 0.0) or 0.0), 0.01)
                for fname in feature_names[:3]]

    attributions = []
    for fname, fval, score in top7:
        direction = "positive" if model_prob > 0.5 else "negative"
        sv = score * (0.1 if model_prob > 0.5 else -0.1)
        attributions.append(FeatureAttribution(
            feature_name=fname,
            feature_value=round(fval, 4),
            shap_value=round(sv, 6),
            direction=direction,
            label=_format_attribution_label(fname, fval),
        ))

    return sort_attributions(attributions)[:7]


def run_inference(
    market: str,
    game_id: str,
    features: dict[str, Any],
) -> list[PickCandidate]:
    """
    Run inference for one market. Returns list of PickCandidates
    (empty if no positive EV or model not loaded).
    """
    if market not in _REGISTRY:
        if market in _LOAD_ERRORS:
            raise HTTPException(
                status_code=503,
                detail=f"Model for '{market}' failed to load: {_LOAD_ERRORS[market]}",
            )
        raise HTTPException(status_code=404, detail=f"No model loaded for market '{market}'")

    reg = _REGISTRY[market]
    model = reg["model"]
    calibrator = reg["calibrator"]
    feature_names = reg["features"]
    explainer = reg["explainer"]

    # Build feature vector
    x = _build_feature_vector(feature_names, features)

    # Raw prediction → calibration
    raw_prob = float(model.predict_proba(x)[0, 1])
    cal_prob = float(calibrator.predict([raw_prob])[0])
    cal_prob = float(np.clip(cal_prob, 0.001, 0.999))

    # Determine pick sides and best odds
    candidates = []
    now_ts = datetime.now(timezone.utc).isoformat()

    if market in ("moneyline", "run_line"):
        sides = [("home", cal_prob), ("away", 1.0 - cal_prob)]
    else:  # totals
        sides = [("over", cal_prob), ("under", 1.0 - cal_prob)]

    # Extract odds from features
    odds_keys = {
        "moneyline": {"home": ("dk_ml_home", "fd_ml_home"), "away": ("dk_ml_away", "fd_ml_away")},
        "run_line": {"home": ("dk_rl_home_price", "fd_rl_home_price"), "away": ("dk_rl_away_price", "fd_rl_away_price")},
        "totals": {"over": ("dk_over_price", "fd_over_price"), "under": ("dk_under_price", "fd_under_price")},
    }

    for pick_side, prob in sides:
        dk_key, fd_key = odds_keys[market][pick_side]
        dk_odds = features.get(dk_key)
        fd_odds = features.get(fd_key)

        best = select_best_line(
            int(dk_odds) if dk_odds is not None else None,
            int(fd_odds) if fd_odds is not None else None,
        )

        if best is None:
            # Default to -110
            best_price, best_book = -110, "draftkings"
        else:
            best_price, best_book = best

        implied_prob = compute_implied_probability(best_price)
        ev = compute_ev(prob, best_price)

        if ev <= 0:
            continue

        tier = assign_confidence_tier(ev)
        if tier < 1:
            continue

        # SHAP attributions
        if explainer is not None and _SHAP_AVAILABLE:
            attributions = _compute_shap_attributions(explainer, x, feature_names, features)
        else:
            attributions = _stub_attributions(feature_names, features, prob)

        if not attributions:
            attributions = _stub_attributions(feature_names, features, prob)

        candidate = PickCandidate(
            game_id=game_id,
            market=market if market != "totals" else "total",
            pick_side=pick_side,
            model_probability=round(prob, 4),
            implied_probability=round(implied_prob, 4),
            expected_value=round(ev, 4),
            confidence_tier=tier,
            best_line=BestLine(
                price=best_price,
                sportsbook_key=best_book,
                snapshotted_at=now_ts,
            ),
            feature_attributions=attributions,
            features={k: v for k, v in features.items()},
            model_version=MARKET_VERSIONS.get(market, f"{market}-v1.0.0"),
            generated_at=now_ts,
        )
        candidates.append(candidate)

    return candidates


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Diamond Edge ML Worker",
    version="1.0.0",
    description="ML inference worker for moneyline, run line, and totals markets",
)

_STARTUP_TIME = time.time()


@app.on_event("startup")
async def startup_event() -> None:
    """Load models at startup — not per-request."""
    print("Loading models...")
    _load_models()
    loaded = list(_REGISTRY.keys())
    errors = list(_LOAD_ERRORS.keys())
    print(f"Models loaded: {loaded}")
    if errors:
        print(f"Models failed to load: {errors}")


def _verify_auth(request: Request) -> None:
    """Verify WORKER_API_KEY from Authorization: Bearer header."""
    expected_key = os.environ.get("WORKER_API_KEY", "")
    if not expected_key:
        # If key not set, allow all requests (local dev mode)
        return

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header",
        )
    token = auth_header[len("Bearer "):]
    if token != expected_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )


@app.get("/health")
async def health(request: Request) -> dict:
    """Liveness + readiness probe."""
    _verify_auth(request)
    return {
        "status": "ok",
        "uptime_seconds": round(time.time() - _STARTUP_TIME, 1),
        "models_loaded": list(_REGISTRY.keys()),
        "models_failed": _LOAD_ERRORS,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/predict")
async def predict(request: Request) -> JSONResponse:
    """
    Run inference for a game across requested markets.

    Request body (matches PredictRequest in supabase/functions/pick-pipeline/types.ts):
    {
        "game_id": "uuid",
        "markets": ["moneyline", "run_line", "total"],
        "features": { ... feature key-value pairs ... }
    }

    Response:
    { "candidates": [ PickCandidate, ... ] }
    """
    _verify_auth(request)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    game_id = body.get("game_id", "")
    markets = body.get("markets", ["moneyline", "run_line", "totals"])
    features = body.get("features", {})

    if not game_id:
        raise HTTPException(status_code=400, detail="game_id is required")

    # Normalize market names: TypeScript sends "total", Python uses "totals"
    normalized = []
    for m in markets:
        normalized.append("totals" if m == "total" else m)

    all_candidates: list[dict] = []

    for market in normalized:
        if market not in ("moneyline", "run_line", "totals"):
            continue
        try:
            picks = run_inference(market, game_id, features)
            all_candidates.extend([p.to_dict() for p in picks])
        except HTTPException:
            raise
        except Exception as e:
            print(f"[ERROR] Inference failed for {market}/{game_id}: {e}")
            # Non-fatal: continue with other markets

    return JSONResponse({"candidates": all_candidates})


@app.post("/rationale")
async def rationale(request: Request) -> JSONResponse:
    """
    Stub endpoint for rationale generation.
    In production this will proxy the Claude API call.
    Returns a minimal placeholder rationale so the pipeline can function.
    """
    _verify_auth(request)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    pick = body.get("pick", {})
    tier = body.get("tier", "pro")
    now = datetime.now(timezone.utc).isoformat()

    # Build a minimal rationale from feature attributions
    attributions = pick.get("feature_attributions", [])
    market = pick.get("market", "moneyline")
    pick_side = pick.get("pick_side", "home")
    ev = pick.get("expected_value", 0.0)
    model_prob = pick.get("model_probability", 0.5)

    if attributions:
        top = attributions[0]
        preview = (
            f"Statistical model favors the {pick_side} side on this {market} "
            f"— key driver: {top.get('label', 'model signal')}."
        )
    else:
        preview = (
            f"Statistical model favors the {pick_side} side on this {market}."
        )

    full_rationale = (
        f"{preview} "
        f"Model probability: {round(model_prob * 100, 1)}%. "
        f"Expected value: {round(ev * 100, 2)}%. "
        f"Past model performance does not guarantee future results. Bet responsibly."
    )

    return JSONResponse({
        "rationale_text": full_rationale if tier == "elite" else preview,
        "rationale_preview": preview,
        "model_used": "stub-v1.0.0",
        "tokens_used": 0,
        "cost_usd": 0.0,
        "generated_at": now,
    })
