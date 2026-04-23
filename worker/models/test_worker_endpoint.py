"""
Test the /predict endpoint with a synthetic model artifact.
Creates a minimal LightGBM + calibrator, saves to moneyline/artifacts/model.pkl,
then calls /predict and validates the full response shape.
"""
from __future__ import annotations

import json
import pickle
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, str(Path(__file__).parents[2]))

from worker.models.pipelines.train_models import MONEYLINE_FEATURES

# ── 1. Train a trivial synthetic model ────────────────────────────────────
print("1. Creating synthetic moneyline model...")
np.random.seed(99)
n = 500
features = [f for f in MONEYLINE_FEATURES]
X = np.random.randn(n, len(features)).astype(np.float32)
y = (X[:, 0] - X[:, 2] > 0).astype(int)  # home ERA better → home win

model = lgb.LGBMClassifier(
    n_estimators=50, num_leaves=8, min_child_samples=10,
    verbose=-1, n_jobs=1, random_state=42,
)
model.fit(X[:400], y[:400])
raw_val = model.predict_proba(X[400:])[:, 1]
cal = IsotonicRegression(out_of_bounds="clip")
cal.fit(raw_val, y[400:].astype(float))

artifact = {"model": model, "calibrator": cal, "features": features}
pkl_path = Path(__file__).parents[1] / "models" / "moneyline" / "artifacts" / "model.pkl"
pkl_path.parent.mkdir(parents=True, exist_ok=True)
with open(pkl_path, "wb") as f:
    pickle.dump(artifact, f)
print(f"   Saved synthetic artifact to {pkl_path}")

# ── 2. Test /predict via FastAPI TestClient ───────────────────────────────
print("2. Testing /predict endpoint with synthetic model...")
from fastapi.testclient import TestClient
from worker.app.main import app, _REGISTRY, _LOAD_ERRORS

# Reload models (simulate startup)
from worker.app.main import _load_models
_load_models()

client = TestClient(app)

# Sample feature dict with enough keys to produce a valid prediction
sample_features = {f: round(float(np.random.randn()), 4) for f in features}
# Set odds so we get a positive EV pick
sample_features["dk_ml_home"] = 110    # +110 underdog
sample_features["fd_ml_home"] = 115    # FD slightly better
sample_features["dk_ml_away"] = -130
sample_features["fd_ml_away"] = -125
sample_features["dk_rl_home_price"] = -110
sample_features["fd_rl_home_price"] = -108
sample_features["dk_over_price"] = -110
sample_features["fd_over_price"] = -108
# Force high ERA gap to push model prob > implied
sample_features["home_sp_era_season"] = 2.50  # strong home starter
sample_features["away_sp_era_season"] = 5.80  # weak away starter

resp = client.post("/predict", json={
    "game_id": "smoke-test-001",
    "markets": ["moneyline"],
    "features": sample_features,
})
print(f"   Status: {resp.status_code}")
assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

data = resp.json()
candidates = data["candidates"]
print(f"   Candidates returned: {len(candidates)}")

for c in candidates:
    print(f"   Candidate: market={c['market']}, side={c['pick_side']}, "
          f"prob={c['model_probability']}, EV={c['expected_value']}, "
          f"tier={c['confidence_tier']}")
    assert c["market"] == "moneyline"
    assert c["pick_side"] in ("home", "away")
    assert 0.0 <= c["model_probability"] <= 1.0
    assert isinstance(c["expected_value"], float)
    assert c["confidence_tier"] in (1, 2, 3, 4, 5)
    assert len(c["feature_attributions"]) > 0
    assert len(c["feature_attributions"]) <= 7
    assert c["best_line"]["sportsbook_key"] in ("draftkings", "fanduel")
    for attr in c["feature_attributions"]:
        assert attr["direction"] in ("positive", "negative")
        assert isinstance(attr["shap_value"], float)
        assert attr["label"] != ""

# Test /rationale stub
print("3. Testing /rationale endpoint...")
if candidates:
    rat_resp = client.post("/rationale", json={
        "pick": candidates[0],
        "game_context": {
            "home_team": {"name": "New York Yankees", "abbreviation": "NYY", "record": "15-10"},
            "away_team": {"name": "Boston Red Sox", "abbreviation": "BOS", "record": "12-13"},
            "game_time_local": "7:05 PM ET",
            "venue": "Yankee Stadium",
            "probable_home_pitcher": {"full_name": "Gerrit Cole"},
            "probable_away_pitcher": {"full_name": "Kutter Crawford"},
            "weather": {"condition": "Clear", "temp_f": 68, "wind_mph": 8, "wind_dir": "SE"},
        },
        "tier": "elite",
    })
    print(f"   Status: {rat_resp.status_code}")
    assert rat_resp.status_code == 200
    rat_data = rat_resp.json()
    assert "rationale_text" in rat_data
    assert "rationale_preview" in rat_data
    print(f"   Preview: {rat_data['rationale_preview'][:80]}...")

print("\n/predict + /rationale endpoint tests PASS")

# ── 3. Health check with model loaded ─────────────────────────────────────
print("4. Health check with model loaded...")
health_resp = client.get("/health")
assert health_resp.status_code == 200
health = health_resp.json()
print(f"   Models loaded: {health['models_loaded']}")
assert "moneyline" in health["models_loaded"], "moneyline model should be loaded"

print("\nALL WORKER ENDPOINT TESTS PASSED")
