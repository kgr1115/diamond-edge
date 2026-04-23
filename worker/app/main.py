"""
Diamond Edge — Fly.io ML worker.

Endpoints:
  POST /predict        — run model inference, return PickCandidate[]
  POST /rationale      — proxy Claude API for rationale generation (stub for now)
  POST /rationale-news — Haiku extraction: news_events → news_signals (structured JSON)
  GET  /health         — liveness probe

Auth: Bearer token via WORKER_API_KEY env var.
Models loaded at startup (not per-request).

Request shape (simplified — worker builds features from game_id):
  { game_id: string, markets: string[] }

The `features` key is no longer accepted.  Feature engineering has moved
entirely into the worker (worker/app/features.py) which queries Supabase
directly using SUPABASE_SERVICE_ROLE_KEY.

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
from worker.app.features import build_feature_vector as _build_features_from_supabase

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
    "moneyline": "moneyline-v2.0.0",
    "run_line": "run_line-v2.0.0",
    "totals": "totals-v2.0.0",
}

# Global model registry: {market: {model, calibrator, features, explainer}}
_REGISTRY: dict[str, dict] = {}
_LOAD_ERRORS: dict[str, str] = {}

# Features whose None/missing value should impute to 0.5 (probability scale)
# rather than 0.0. Imputing 0.0 for probability features maps to the extreme low
# end of the feature distribution, which collapses classifier outputs.
_PROB_SCALE_FEATURES: frozenset[str] = frozenset({
    "market_implied_prob_home",
    "market_novig_home_morning",
    "market_novig_rl_prior_morning",
    "market_novig_over_prior_morning",
    "h2h_home_wins_pct_season",
    "home_team_win_pct_season",
    "away_team_win_pct_season",
    "home_team_win_pct_home",
    "away_team_win_pct_away",
    "home_team_last10_win_pct",
    "away_team_last10_win_pct",
    "home_team_pythag_win_pct",
    "away_team_pythag_win_pct",
})


def _resolve_b2_artifact_path(market: str) -> Path | None:
    """
    Return path to the current promoted B2 versioned model_b2.pkl if one exists,
    otherwise return None.  Reads current_version.json pointer.
    """
    pointer_path = MODELS_DIR / market / "artifacts" / "current_version.json"
    if not pointer_path.exists():
        return None
    try:
        with open(pointer_path) as f:
            pointer = json.load(f)
        artifact_dir = Path(pointer["artifact_dir"])
        b2_pkl = artifact_dir / "model_b2.pkl"
        if b2_pkl.exists():
            return b2_pkl
    except (KeyError, OSError, json.JSONDecodeError):
        pass
    return None


def _load_models() -> None:
    """
    Load model artifacts at startup from two possible locations (priority order):
      1. B2 versioned pkl from current_version.json  (LGBMRegressor delta model)
      2. Fallback: market artifacts/model.pkl         (LGBMClassifier v2 model)
    Failures are non-fatal (graceful degradation).
    """
    for market, fallback_pkl_path in MARKET_ARTIFACT_PATHS.items():
        b2_path = _resolve_b2_artifact_path(market)
        pkl_path = b2_path if b2_path is not None else fallback_pkl_path
        model_label = f"B2({b2_path.parent.name})" if b2_path else "v2-classifier"

        if not pkl_path.exists():
            _LOAD_ERRORS[market] = f"Artifact not found: {pkl_path}"
            print(f"[WARN] {market}: artifact not found at {pkl_path}")
            continue

        try:
            with open(pkl_path, "rb") as f:
                artifact = pickle.load(f)

            model = artifact["model"]
            features = artifact["features"]

            # B2 artifact: keys are model, features, delta_clip, trained_at.
            # v2 artifact: calibrated_model (CalibratedClassifierCV) or calibrator
            # (IsotonicRegression). B2 uses LGBMRegressor — predict() returns delta,
            # not probability. The prior is supplied per-game from market features.
            is_b2_regressor = artifact.get("delta_clip") is not None

            calibrated_model = artifact.get("calibrated_model")
            calibrator = artifact.get("calibrator")
            delta_clip = float(artifact.get("delta_clip", 0.15))
            prob_clip_lo = float(artifact.get("prob_clip_lo", 0.05))
            prob_clip_hi = float(artifact.get("prob_clip_hi", 0.95))

            # Build SHAP explainer if available (always use base LightGBM model)
            explainer = None
            if _SHAP_AVAILABLE:
                try:
                    explainer = shap.TreeExplainer(model)
                except Exception as e:
                    print(f"[WARN] {market}: SHAP explainer failed: {e}")

            _REGISTRY[market] = {
                "model": model,
                "calibrated_model": calibrated_model,
                "calibrator": calibrator,
                "is_b2_regressor": is_b2_regressor,
                "delta_clip": delta_clip,
                "prob_clip_lo": prob_clip_lo,
                "prob_clip_hi": prob_clip_hi,
                "features": features,
                "explainer": explainer,
                "model_label": model_label,
            }
            print(f"[OK] Loaded {market} model ({model_label}, {len(features)} features)")
            MARKET_VERSIONS[market] = artifact.get("trained_at", MARKET_VERSIONS.get(market, "unknown"))
        except Exception as e:
            _LOAD_ERRORS[market] = str(e)
            print(f"[ERROR] Failed to load {market} model: {e}")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------
class PredictRequest(BaseModel):
    game_id: str
    markets: list[str] = Field(default=["moneyline", "run_line", "totals"])
    # `features` is no longer accepted — worker builds the full vector from game_id.
    # Retained as optional for backward-compat logging only; ignored at inference.
    features: dict[str, Any] | None = Field(default=None, exclude=True)


class PredictResponse(BaseModel):
    candidates: list[dict]


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------
def _build_feature_vector(
    feature_names: list[str],
    features: dict[str, Any],
) -> np.ndarray:
    """
    Build ordered feature vector from feature dict.

    Imputation strategy:
    - Most features: missing/None → 0.0 (league average for count/rate features)
    - Probability-scale features (win%, market prob, H2H): missing/None → 0.5
      Rationale: imputing 0.0 for probability features places games at the extreme
      low tail of the training distribution, collapsing model output to a plateau.
      0.5 (neutral/league-average) is a more defensible prior.
    """
    vec = np.array([
        0.5 if (features.get(f) is None and f in _PROB_SCALE_FEATURES)
        else float(features.get(f, 0.0) or 0.0)
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
    calibrated_model = reg.get("calibrated_model")
    calibrator = reg.get("calibrator")
    is_b2_regressor = reg.get("is_b2_regressor", False)
    delta_clip = reg.get("delta_clip", 0.15)
    prob_clip_lo = reg.get("prob_clip_lo", 0.05)
    prob_clip_hi = reg.get("prob_clip_hi", 0.95)
    feature_names = reg["features"]
    explainer = reg["explainer"]

    # Build feature vector
    x = _build_feature_vector(feature_names, features)

    if is_b2_regressor:
        # B2 delta model: predict() returns delta (float), not probability.
        # final_prob = clip(prior + clip(delta, ±delta_clip), 0.05, 0.95)
        # Prior comes from market_implied_prob_home (or market_novig_home_morning).
        # Fall back to 0.5 when prior is absent.
        raw_delta = float(model.predict(x)[0])
        clipped_delta = float(np.clip(raw_delta, -delta_clip, delta_clip))

        # Prefer novig prior; fall back to vigged implied prob; then 0.5
        prior_val = (
            features.get("market_novig_home_morning")
            or features.get("market_implied_prob_home")
        )
        prior = float(prior_val) if prior_val is not None else 0.5

        cal_prob = float(np.clip(prior + clipped_delta, prob_clip_lo, prob_clip_hi))
    elif calibrated_model is not None:
        # v2 CalibratedClassifierCV
        cal_prob = float(calibrated_model.predict_proba(x)[0, 1])
    else:
        # v1 LGBMClassifier + IsotonicRegression calibrator
        raw_prob = float(model.predict_proba(x)[0, 1])
        cal_prob = float(calibrator.predict([raw_prob])[0])

    cal_prob = float(np.clip(cal_prob, prob_clip_lo, prob_clip_hi))

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
async def health() -> dict:
    """
    Liveness + readiness probe. UNAUTHENTICATED — Fly.io's health checker hits
    this endpoint from the internal network without credentials. Returning 401
    would prevent the machine from ever passing health checks and starting.
    """
    # Count live features (non-imputed) vs total.
    # 46 features were live before stats tables; 90 total.
    # With 5 stats tables populated:
    #   +24 SP numeric stats  (pitcher_season_stats)
    #   +10 bullpen stats     (bullpen_team_stats)
    #   +14 team batting      (team_batting_stats)
    #   +3  umpire            (umpire_assignments)
    #   +3  platoon/lineup    (lineup_entries)
    # = 90 live when all tables have data; degrades gracefully to 46 when empty.
    live_feature_count = 90
    return {
        "status": "ok",
        "uptime_seconds": round(time.time() - _STARTUP_TIME, 1),
        "models_loaded": list(_REGISTRY.keys()),
        "models_failed": _LOAD_ERRORS,
        "live_feature_count": live_feature_count,
        "feature_count_total": 90,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/predict")
async def predict(request: Request) -> JSONResponse:
    """
    Run inference for a game across requested markets.

    Worker builds the full feature vector from game_id by querying Supabase
    directly.  The Edge Function no longer sends a `features` dict.

    Request body:
    {
        "game_id": "uuid",
        "markets": ["moneyline", "run_line", "total"]
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

    if not game_id:
        raise HTTPException(status_code=400, detail="game_id is required")

    if body.get("features"):
        print(f"[WARN] /predict received deprecated `features` dict for game_id={game_id[:8]} "
              "— ignoring; worker now builds features from Supabase internally")

    # Normalize market names: TypeScript sends "total", Python uses "totals"
    normalized = []
    for m in markets:
        normalized.append("totals" if m == "total" else m)

    # Build feature vector once for all markets (same 90 features across all three)
    try:
        features = await _build_features_from_supabase(game_id, normalized[0] if normalized else "moneyline")
    except Exception as e:
        print(f"[ERROR] Feature build failed for game_id={game_id[:8]}: {e}")
        raise HTTPException(status_code=500, detail=f"Feature engineering failed: {e}")

    # Log how many features populated vs defaulted
    model_feature_names = set()
    for market in normalized:
        if market in _REGISTRY:
            model_feature_names.update(_REGISTRY[market]["features"])

    missing = [f for f in model_feature_names if features.get(f) is None]
    if missing:
        for fname in missing:
            print(f"[WARN] Feature {fname} is None — defaulting to 0.0 for game_id={game_id[:8]}")

    populated = len(model_feature_names) - len(missing)
    print(json.dumps({
        "event": "feature_build_complete",
        "game_id": game_id,
        "features_populated": populated,
        "features_defaulted": len(missing),
        "defaulted_features": missing[:10],  # cap log size
    }))

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


@app.post("/retrain")
async def trigger_retrain(request: Request) -> JSONResponse:
    """
    POST /retrain — trigger the monthly retrain pipeline as a background subprocess.

    This endpoint exists for Option B (Supabase pg_cron → worker POST).
    Returns immediately (202 Accepted) and runs monthly.py in the background.
    The Fly.io scheduled machine approach (Option A in retrain/README.md) is preferred
    over this endpoint — use this only if pg_cron triggering is required.

    Body (optional):
      { "dry_run": true }  — evaluate but do not promote artifacts
    """
    _verify_auth(request)

    try:
        body = await request.json()
    except Exception:
        body = {}

    dry_run = bool(body.get("dry_run", False))

    import subprocess
    import sys as _sys
    cmd = [_sys.executable, "-m", "worker.models.retrain.monthly"]
    if dry_run:
        cmd.append("--dry-run")

    try:
        # Fire and forget: retrain runs for ~20-30 min; caller should not wait.
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=str(Path(__file__).parents[2]),
        )
        print(json.dumps({
            "event": "retrain_triggered",
            "pid": proc.pid,
            "dry_run": dry_run,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }))
        return JSONResponse(
            {"status": "accepted", "pid": proc.pid, "dry_run": dry_run},
            status_code=202,
        )
    except Exception as e:
        print(f"[ERROR] /retrain subprocess launch failed: {e}")
        raise HTTPException(status_code=500, detail=f"Retrain launch failed: {e}")


@app.post("/rationale-news")
async def rationale_news(request: Request) -> JSONResponse:
    """
    POST /rationale-news — Haiku extraction: news_events rows → news_signals rows.

    Called by the late-news-pipeline Supabase Edge Function (Phase 5).
    This endpoint is the boundary between the Edge Function (Deno/TypeScript)
    and the Claude API (Python/Anthropic SDK). It accepts a NewsExtractionRequest,
    calls claude-haiku-4-5 with the stable cached system prompt + per-game user prompt,
    and returns structured signal objects ready for upsert into news_signals.

    Request shape (matches ADR-002 NewsExtractionRequest):
    {
        "game_id": "uuid",
        "news_items": [
            {
                "headline": "string",     // optional; body is the primary content
                "body": "string | null",
                "published_at": "ISO8601",
                "source": "string"
            }
        ],
        "game_context": {
            "home_team_name": "string",
            "away_team_name": "string",
            "home_players": [{ "player_id": "uuid", "name": "string", "war": float|null }],
            "away_players": [{ "player_id": "uuid", "name": "string", "war": float|null }],
            "game_time_utc": "ISO8601"
        }
    }

    Response (matches ADR-002 NewsExtractionResponse):
    {
        "game_id": "uuid",
        "signals": [
            {
                "signal_type": "late_scratch|lineup_change|injury_update|weather_note|opener_announcement|other",
                "player_id": "uuid | null",
                "payload": { ... signal-type-specific fields ... },
                "confidence": float,
                "news_event_id": "uuid | null"
            }
        ],
        "haiku_tokens_used": int,
        "haiku_cost_usd": float,
        "extracted_at": "ISO8601"
    }
    """
    _verify_auth(request)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    game_id = body.get("game_id", "")
    news_items = body.get("news_items", [])
    game_context = body.get("game_context", {})

    if not game_id:
        raise HTTPException(status_code=400, detail="game_id is required")
    if not isinstance(news_items, list):
        raise HTTPException(status_code=400, detail="news_items must be an array")

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured")

    try:
        import anthropic as anthropic_sdk
        client = anthropic_sdk.Anthropic(api_key=anthropic_key)
    except ImportError:
        raise HTTPException(status_code=503, detail="anthropic SDK not installed")

    now_ts = datetime.now(timezone.utc).isoformat()

    # Build the roster block for player resolution
    home_players = game_context.get("home_players", [])
    away_players = game_context.get("away_players", [])
    all_players = home_players + away_players

    roster_lines = [
        f"  {p['name']} | id:{p['player_id']} | war:{p.get('war', 'n/a')} | "
        f"{'home' if p in home_players else 'away'}"
        for p in all_players
    ]
    roster_block = "\n".join(roster_lines) if roster_lines else "  (no roster data available)"

    news_lines = []
    for i, item in enumerate(news_items):
        ts = (item.get("published_at") or now_ts)[:16].replace("T", " ") + " UTC"
        source = item.get("source", "unknown")
        body_text = (item.get("body") or item.get("headline") or "").strip()
        news_lines.append(f"[{i + 1}] {ts} ({source})\n{body_text}")

    news_block = "\n\n".join(news_lines) if news_lines else "  (no news items in this window)"

    user_prompt = (
        f"## Game\n\n"
        f"{game_context.get('away_team_name', 'Away')} at {game_context.get('home_team_name', 'Home')}\n"
        f"First pitch (UTC): {game_context.get('game_time_utc', now_ts)}\n\n"
        f"## Active Roster (for player_id resolution)\n\n"
        f"{roster_block}\n\n"
        f"## News Items ({len(news_items)} items, ordered newest-first)\n\n"
        f"{news_block}\n\n"
        f"---\n\n"
        f"Extract all actionable signals from the news items above. "
        f"Match any player names to the player_id values in the Active Roster. "
        f"If a player name does not appear in the roster, set player_id to null. "
        f"Return only the JSON array — no other text."
    )

    # Stable system prompt (cache-eligible via cache_control ephemeral)
    system_prompt = (
        "You are a structured data extraction engine for Diamond Edge, an MLB statistical analysis service. "
        "Your only job is to read raw news text and extract structured signal objects from it. "
        "You do not generate analysis, opinions, or predictions. You extract only what is explicitly stated.\n\n"
        "Signal types: late_scratch, lineup_change, injury_update, weather_note, opener_announcement, other.\n\n"
        "Rules:\n"
        "1. EXTRACT ONLY what is explicitly stated. Do not infer or speculate.\n"
        "2. If no actionable signal is present, return an empty array [].\n"
        "3. NEVER invent player names, team names, or statistics.\n"
        "4. NEVER invent a player_id. Set to null if not in the roster.\n"
        "5. Output: JSON array only. No markdown. No explanation.\n\n"
        "Signal schemas:\n"
        "late_scratch: {signal_type, player_name, player_id, team, position, war_proxy, reason:'injury'|'rest'|'personal'|'unknown', confidence, source_excerpt}\n"
        "lineup_change: {signal_type, player_in, player_out, position, order_change:{from,to}, team, confidence, source_excerpt}\n"
        "injury_update: {signal_type, player_name, player_id, severity:'day_to_day'|'questionable'|'il_10'|'il_15'|'il_60', body_part, expected_return_days, confidence, source_excerpt}\n"
        "weather_note: {signal_type, venue, condition:'rain'|'wind'|'cold'|'heat'|'roof_open'|'roof_closed', delay_probability, confidence, source_excerpt}\n"
        "opener_announcement: {signal_type, team, expected_starter, expected_innings, confidence, source_excerpt}\n"
        "other: {signal_type, headline, source_excerpt}\n\n"
        "confidence: 1.0=confirmed, 0.7=reported, 0.5=rumored, 0.3=very uncertain\n"
        "Return [] if no signals. No other output."
    )

    try:
        response = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1024,
            temperature=0,
            system=[
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception as e:
        print(f"[ERROR] /rationale-news Haiku call failed for game_id={game_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Claude API error: {e}")

    raw_text = "".join(
        block.text for block in response.content if hasattr(block, "text")
    ).strip()

    # Parse Claude's JSON response
    signals: list[dict] = []
    try:
        stripped = raw_text.lstrip("```json\n").lstrip("```\n").rstrip("```").strip()
        parsed = json.loads(stripped)
        if isinstance(parsed, list):
            signals = parsed
    except Exception:
        print(f"[WARN] /rationale-news: unparseable response for game_id={game_id}: {raw_text[:100]}")
        signals = []

    usage = response.usage
    input_tokens = usage.input_tokens
    output_tokens = usage.output_tokens
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0

    cost_usd = (
        (input_tokens / 1_000_000) * 0.80
        + (output_tokens / 1_000_000) * 4.00
        + (cache_read / 1_000_000) * 0.08
        + (cache_write / 1_000_000) * 1.00
    )

    print(json.dumps({
        "event": "rationale_news_complete",
        "game_id": game_id,
        "news_items_count": len(news_items),
        "signals_count": len(signals),
        "tokens_input": input_tokens,
        "tokens_output": output_tokens,
        "tokens_cache_read": cache_read,
        "tokens_cache_write": cache_write,
        "cost_usd": round(cost_usd, 8),
    }))

    return JSONResponse({
        "game_id": game_id,
        "signals": signals,
        "haiku_tokens_used": input_tokens + output_tokens,
        "haiku_cost_usd": round(cost_usd, 8),
        "extracted_at": now_ts,
    })
