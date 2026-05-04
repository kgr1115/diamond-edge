# TASK-005 â€” ML Feature Engineering + Model Design

**Agent:** mlb-ml-engineer
**Phase:** 1
**Date issued:** 2026-04-22
**Status:** In progress

---

## Objective

Define the full feature engineering scope and select the statistical model(s) for moneyline, run-line, and totals markets (no parlays in v1); make and justify the Fly.io worker vs. Supabase Edge Function inference runtime decision with a cost estimate; and design the backtesting harness â€” all producing output that exactly matches the PickCandidate schema in `docs/api/ml-output-contract.md`.

---

## Context

- Markets in scope for v1: moneyline, run_line, total. Props are v1 stretch (include if clean). Parlays explicitly deferred to v1.1 â€” do not scope parlay EV.
- Minimum confidence threshold for publication: `confidence_tier >= 3` (EV > 4%). LOCKED DECISION. Your model must produce calibrated confidence tiers 1â€“5 per the tier derivation table in `ml-output-contract.md`.
- Free tier users see NO rationale and NO model data. Pro tier: model_probability. Elite tier: model_probability + expected_value + SHAP. Your output schema feeds all of these â€” tier gating happens downstream at the API layer.
- LLM rationale is grounded in `feature_attributions` (SHAP-style, top N). If attributions are missing or empty, rationale cannot be written. This is a hard dependency.
- Budget: $300/mo total. Statistical model must be CPU-servable (gradient boosting, logistic regression, XGBoost, LightGBM). GPU is not approved for v1 â€” flag explicitly if you believe it's required.
- Vercel function timeout is 10s (Hobby) / 60s (Pro). If inference + feature lookup exceeds this, it goes to Fly.io worker. Supabase Edge Functions (Deno) don't support Python natively â€” Python models must run on Fly.io. This is the key runtime fork.
- Data sources: MLB Stats API (schedules, rosters, box scores), Baseball Savant/Statcast (pitch-level, batted-ball), odds from `odds` table (populated by TASK-004). Weather fields are in `games` table.
- No future data leakage. Every feature must be available at bet placement time. This is non-negotiable.

---

## Inputs

- `CLAUDE.md` â€” locked constraints
- `docs/api/ml-output-contract.md` â€” the PickCandidate schema your model must produce exactly; the confidence tier derivation table; the pick pipeline seam diagram
- `docs/schema/schema-v1.md` â€” `games`, `odds`, `teams`, `players` tables (your input data lives here)
- `docs/api/api-contracts-v1.md` â€” downstream consumers (tier gating table shows which model outputs go to which tier)

---

## Deliverable Format

Artifacts committed under the repo root `C:\AI\Public\diamond-edge`:

Per ADR-001, model artifacts live under `worker/` (the Fly.io Python worker directory).

1. **`worker/models/README.md`** â€” Top-level model overview:
   - One section per market model (moneyline, run_line, total)
   - For each: problem statement, prediction target, inputs, output distribution
   - Runtime decision: Fly.io worker vs. Supabase Edge Function â€” written up with cost rationale

2. **`worker/models/moneyline/feature-spec.md`** â€” Feature engineering document:
   - Full feature list: exact name (matching `feature_attributions.feature_name` in PickCandidate), source table/API, transformation, leak audit status
   - Minimum: starter ERA splits (30d, season), bullpen usage + rest, team record (home/away split), park factor, platoon advantage, umpire handedness tendency (if available), weather (temp, wind speed/dir)
   - Any feature requiring data not yet in the schema must be flagged as a data gap for TASK-004

3. **`worker/models/run_line/feature-spec.md`** â€” Same format (can share many features with moneyline)

4. **`worker/models/totals/feature-spec.md`** â€” Same format (weather and park factor are especially important here)

5. **`worker/models/backtest-harness.md`** â€” Backtesting spec:
   - Date range: minimum 3 MLB seasons (2021â€“2023 historical; 2024 holdout)
   - Train/validation/test split rationale
   - Evaluation metrics: log-loss, calibration curve (reliability diagram), ROI simulation at flat $100 bet sizing, Sharpe ratio on picks above publication threshold
   - How to run it: script path, command, expected output

6. **`worker/models/calibration-spec.md`** â€” Confidence tier mapping:
   - Final mapping from EV + uncertainty â†’ confidence_tier 1â€“5
   - Must be validated against backtests (not just the suggested table in ml-output-contract.md)
   - Include the reliability diagram spec (how you'll verify the model is calibrated)

7. **`worker/models/inference-runtime.md`** â€” Runtime decision document:
   - State the chosen runtime (Fly.io OR Supabase Edge Function)
   - Estimate inference latency (P50 and P99)
   - Estimate monthly cost at 10 predictions/day (steady state) and 100 predictions/day (peak)
   - Show Fly.io pricing math if Fly.io chosen (smallest instance that handles the workload)
   - Confirm the decision stays within the $300/mo budget envelope

8. **`worker/models/pick_candidate_schema.py`** â€” Python dataclass or TypedDict matching `ml-output-contract.md` exactly:
   - This is the contract the AI Reasoning agent and pick pipeline will import
   - Must match every field in the PickCandidate interface from `docs/api/ml-output-contract.md`

---

## Definition of Done

- [ ] Feature specs exist for all three markets (moneyline, run_line, total).
- [ ] Every feature in each spec has: source (table column or API field), transformation, and explicit leak audit confirmation ("available at bet placement time: YES").
- [ ] Data gaps (features requiring data not yet in the schema) are listed and surfaced to orchestrator.
- [ ] `inference-runtime.md` commits to Fly.io OR Edge Function with cost estimate â€” does not leave it open.
- [ ] Cost estimate for chosen runtime is within the $300/mo envelope.
- [ ] Backtesting harness spec covers at least 3 seasons, defines train/val/test split, and specifies calibration curve as an output.
- [ ] `calibration-spec.md` defines the final confidence_tier mapping with a plan to validate against backtest data.
- [ ] `worker/models/pick_candidate_schema.py` matches `docs/api/ml-output-contract.md` field-for-field.
- [ ] `feature_attributions` array is specified in enough detail that the AI Reasoning agent can cite them without hallucinating (i.e., every attribution has `feature_name`, `feature_value`, `shap_value`, `direction`, `label` per contract).
- [ ] Runtime decision is communicated to orchestrator so TASK-006 (DevOps) can provision the correct infra.
- [ ] No parlay features or parlay model scoped.

---

## Dependencies

**Requires (before starting):**
- `docs/api/ml-output-contract.md` â€” DONE (TASK-001): PickCandidate schema defined
- `docs/schema/schema-v1.md` â€” DONE (TASK-001): input data tables defined

**Does NOT require:**
- TASK-004 complete â€” you design against the schema; actual data comes from TASK-004 pipeline
- TASK-006 complete â€” you specify the runtime; DevOps provisions it

**This task unblocks:**
- TASK-006 (DevOps) â€” needs runtime decision to provision Fly.io or confirm Edge Function suffices
- TASK-007 (AI Reasoning) â€” needs feature_attributions spec to write grounded rationale prompts
- Pick pipeline implementation (Phase 2) â€” needs the model to actually run

**New secrets/env vars to surface to DevOps (if Fly.io chosen):**
- `FLY_APP_NAME` â€” for the ML worker
- `MODEL_ENDPOINT_URL` â€” URL of the Fly.io prediction endpoint
