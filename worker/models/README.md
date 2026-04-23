# Diamond Edge — ML Model Overview

**Status:** Specification (Phase 1)
**Date:** 2026-04-22
**Author:** mlb-ml-engineer
**Task:** TASK-005

---

## Runtime Decision: Fly.io Python Worker

**Decision: All inference runs on a Fly.io Python worker. Supabase Edge Functions are not used for ML inference.**

Rationale:
- All three market models use **LightGBM** (Python), which requires `lightgbm`, `numpy`, `scikit-learn`, and `shap` — libraries unavailable in Deno (Supabase Edge Functions).
- Supabase Edge Functions run Deno runtime only; no Python support.
- Fly.io Machines support Python containers, scale to zero between runs, and cost <$8/month at v1 volumes (see `inference-runtime.md` for full math).
- The Fly.io worker also hosts the `/rationale` endpoint (AI Reasoning) as specified in the pick pipeline seam diagram.

**DevOps action required:** Provision a `shared-cpu-1x` Fly.io Machine (`512 MB RAM`) for the `diamond-edge-worker` app. See `inference-runtime.md` for exact spec and env vars to surface.

---

## Model Inventory

| Model | File | Target | Algorithm | Market |
|---|---|---|---|---|
| Moneyline | `moneyline/` | P(home wins) | LightGBM + Platt scaling | moneyline |
| Run Line | `run_line/` | P(home covers −1.5) | LightGBM + Platt scaling | run_line |
| Totals | `totals/` | P(over hits) | LightGBM + Platt scaling | total |

Props (player strikeouts, hits, HRs) are a **v1 stretch goal** — feature spec omitted until moneyline/run-line/totals are backtested. Do not scope prop model until Phase 2 sign-off.

**Parlay EV is explicitly out of scope for v1.** See CLAUDE.md.

---

## Model 1: Moneyline

### Problem Statement

Predict the probability that the **home team wins** a given MLB game, given information available at bet placement time (typically 12–24 hours before first pitch, finalized ~30 minutes before first pitch when confirmed lineups are posted).

- **Prediction target:** Binary — home win (1) or away win (0)
- **Output:** Calibrated probability `P(home wins) ∈ [0, 1]`
- **EV computation:** `EV = model_prob × net_payout − (1 − model_prob)` against best DK or FD line for the chosen side
- **Market-specific note:** No ties in MLB moneyline (extra innings determines winner). Binary classification is correct.

### Key Inputs

Full feature list in `moneyline/feature-spec.md`. High-level categories:

1. Starting pitcher quality (ERA splits, FIP, xFIP, K/9, BB/9, days rest, handedness)
2. Bullpen quality and usage load (recent ERA, innings pitched in last 2/3 days)
3. Team offense (OPS, wOBA, runs/game — season and rolling 14-day)
4. Team record (overall, home/away split, run differential, last-10 form)
5. Platoon advantage (lineup handedness vs opposing starter hand)
6. Park factor (run factor index)
7. Umpire tendencies (K-rate, runs above/below average)
8. Weather (temperature, wind speed, wind direction relative to CF)
9. Rest/travel (days since last game, timezone travel indicator)

### Output Distribution

Binary classifier → calibrated probability. Expected distribution at v1 launch (based on historical priors):
- Most games: home win probability between 0.40 and 0.65
- Strong favorites (ace vs weak starter, strong team): up to 0.70–0.75
- Strong underdogs: down to 0.25–0.35
- Publishable EV picks (EV > 4%): estimated ~1–3 per day, not every game

---

## Model 2: Run Line

### Problem Statement

Predict the probability that the **home team covers the run line** (typically −1.5 for favorites, +1.5 for underdogs). The run line is essentially a point spread applied to MLB — the home team must win by 2+ runs to cover −1.5.

- **Prediction target:** Binary — home covers run line (1) or not (0)
- **Output:** Calibrated probability `P(home covers) ∈ [0, 1]`
- **EV computation:** Same formula as moneyline; odds are typically around −110 for run line (closer to coin flip than moneyline)
- **Market-specific note:** Run line at −1.5 is the standard MLB spread. Pushes are extremely rare (exactly 1-run margin). The model must handle the asymmetry: a team that wins 55% of games does not cover −1.5 55% of the time.

### Key Inputs

Run line shares ~80% of features with moneyline. Additional/emphasized features:
- Starter quality gap (difference between home and away pitcher FIP) — more important here than for ML
- Team run differential variance (blowout potential vs tight games)
- Home ATS record (historical run line cover rate)
- Bullpen depth (can the team sustain a 2+ run lead through 9 innings?)

Full feature list in `run_line/feature-spec.md`.

### Output Distribution

Binary classifier. Run line is closer to 50/50 by design. Expected probabilities:
- Most games: 0.40–0.60 range (tighter than moneyline)
- Strong starter quality gap: up to 0.65
- Picks with positive EV (after accounting for −110 standard vig): estimated ~1–2 per day

---

## Model 3: Totals (Over/Under)

### Problem Statement

Predict whether the total runs scored by both teams **exceeds (over) or falls below (under) the posted line** (e.g., 8.5 runs).

- **Prediction target:** Binary — over (1) or under (0) relative to the posted total line
- **Output:** Calibrated probability `P(over) ∈ [0, 1]`
- **EV computation:** Same formula; best available over or under odds from DK/FD
- **Market-specific note:** Total line varies per game (typically 6.5–12.5 in MLB). The model must incorporate the actual posted total as a feature — it encodes the market's prior. Weather (especially wind) and park factor are the most powerful features here.

### Key Inputs

Totals-specific emphasis on scoring environment:
- Both starters' run-prevention metrics (ERA, FIP, K/9, BB/9)
- Both offenses' scoring rates (OPS, wOBA, runs/game)
- Park run factor (e.g., Coors Field = +15% runs vs average)
- Weather: wind direction (to CF = offense boost), wind speed, temperature (cold air = fewer HRs)
- Posted total line (market's prior — encode the market before applying edge)
- Both teams' over/under historical tendency at this park

Full feature list in `totals/feature-spec.md`.

### Output Distribution

Binary classifier. P(over) should be centered near 0.50 but varies with environment. Expected publishable picks: ~1–2 per day when weather creates a strong edge (high wind to CF + both offenses hot, or cold dome game with two aces).

---

## Algorithm Selection Rationale

**LightGBM** chosen for all three markets over alternatives:

| Algorithm | CPU-servable | SHAP support | Calibration quality | Interpretability | Decision |
|---|---|---|---|---|---|
| Logistic regression | ✓ | Coefficients only | Good | Excellent | Too simple for feature interactions |
| Random forest | ✓ | TreeExplainer | Moderate (needs calibration) | Good | Slower than LightGBM, similar quality |
| **LightGBM** | **✓** | **TreeExplainer (fast)** | **Good (+ Platt scaling)** | **Good** | **Selected** |
| XGBoost | ✓ | TreeExplainer | Good | Good | LightGBM faster at inference |
| Neural network | CPU (small) | SHAP DeepExplainer | Requires calibration | Poor | Violates interpretability requirement |
| GPU model | ✗ | N/A | N/A | Poor | Not approved for v1 |

**GPU is not required.** LightGBM inference on a shared-cpu-1x Fly.io machine for 100 candidates takes <500ms total.

**Calibration post-processing:** Platt scaling (logistic regression on held-out validation set) applied to LightGBM raw scores. Isotonic regression as fallback if Platt overfits (small calibration set). Reliability diagram generated as part of backtesting output.

---

## SHAP Feature Attribution

LightGBM's `shap.TreeExplainer` is used to generate per-prediction SHAP values. The top-N features (by absolute SHAP value) are returned in `feature_attributions` in the `PickCandidate` output. SHAP values are in log-odds space.

The AI Reasoning agent **requires** `feature_attributions` to generate rationale. If SHAP computation fails, the pick is not published. This is enforced in the pick pipeline.

---

## Data Gaps — Surfaces to Orchestrator / Data Engineer (TASK-004)

The following features are required by the models but are **not yet available in the schema-v1 tables**. These are flagged as blockers for the data engineer:

| Gap # | Feature | Needed By | Data Source | Schema Change Required |
|---|---|---|---|---|
| G1 | Pitcher rolling stats (ERA, FIP, xFIP per 30d, 10d) | All three models | MLB Stats API game logs + Baseball Savant | New `pitcher_game_logs` or computed view |
| G2 | Bullpen innings pitched last 2d / 3d | All three models | MLB Stats API game logs | New `bullpen_usage` computed table |
| G3 | Statcast pitcher metrics (xFIP, Stuff+, barrel rate allowed) | All three models | Baseball Savant | New `statcast_pitcher_stats` table |
| G4 | Team rolling offensive stats (OPS, wOBA, runs/game last 14d) | All three models | MLB Stats API / Baseball Savant | New `team_game_logs` or computed view |
| G5 | Park run factor index | Totals (primary), all | Static reference (Statcast, updated annually) | New `park_factors` table |
| G6 | Umpire game assignment + k_rate / run_factor | Moneyline, run_line | MLB Stats API (umpires endpoint) | New `umpires` + `umpire_game_assignments` tables |
| G7 | Confirmed batting lineup (with handedness) | All three models | MLB Stats API (lineups endpoint, ~60min before first pitch) | New `game_lineups` table |
| G8 | Team home/away win pct and ATS record | All three models | Derived from `pick_outcomes` + `games` | Computed view over existing tables |
| G9 | Pythagorean win percentage | Moneyline, run_line | Derived from `games` (home/away scores) | Computed view |
| G10 | Historical H2H results (current season) | Moneyline | Derived from `games` + `pick_outcomes` | Computed view |
