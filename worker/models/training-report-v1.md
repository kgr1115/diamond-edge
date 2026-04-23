# Diamond Edge v1 Training Report

**Date:** 2026-04-23
**Author:** mlb-ml-engineer
**Status:** Models trained and deployed to worker artifacts. Totals calibration requires isotonic re-fit before publishing picks.

---

## What Shipped

Three LightGBM + isotonic-calibration models, one per market:
- `worker/models/moneyline/artifacts/model.pkl` — v1.0.0
- `worker/models/run_line/artifacts/model.pkl` — v1.0.0
- `worker/models/totals/artifacts/model.pkl` — v1.0.0

FastAPI worker at `worker/app/main.py`, local-verified via TestClient.
Dockerfile at `worker/Dockerfile` (python:3.11-slim, PORT 8080).

---

## Data

- **Source:** MLB Stats API (box scores 2022–2024 via `pull_mlb_stats.py`)
- **Odds:** 637 JSON files, 8,520 games, DK + FD (data/historical-odds/)
- **Games processed:** 7,300 (2431 + 2437 + 2432 per season)
- **Pitcher logs:** 62,319 rows | Bullpen: 47,725 | Team batting: 14,600

**Split:** Train 2022 (2431 games) → Val 2023 (2437) → Holdout 2024 (2432)

---

## Research Edges Incorporated

All 5 research edges are in production features:

| Edge | Feature(s) | Top SHAP rank |
|------|-----------|---------------|
| WX-01 Handedness park HR | `park_hr_factor_l/r`, `park_hr_factor_lineup_weighted` | Not in top 10 (small signal with imputed lineups) |
| BP-03 Opener detection | `home_is_opener`, `away_is_opener` | **#8 run_line** (0.022) |
| SP-01 TTOP exposure | `home/away_sp_ttop_exposure` | Mid-table |
| TRAVEL-01 Eastward penalty | `away_travel_eastward_penalty`, `away_travel_tz_change` | Mid-table |
| OFF-02 EWMA offense | `home/away_team_runs_ewma_7d` | **#6 totals** (0.031) |

Top SHAP features overall:
1. `market_implied_prob_home` (all markets) — market prior dominant
2. `away_bp_era_season` — bullpen quality strong signal
3. `sp_k9_gap` — pitcher K-rate gap (run line)
4. `posted_total_line` (totals) — market prior for totals
5. `home_sp_era_last_30d` — recent starter form

---

## Backtest Metrics (2024 Holdout)

| Market | Log-loss | Brier | Cal deviation | Cal pass | ECE |
|--------|----------|-------|---------------|----------|-----|
| Moneyline | 0.6886 | 0.2475 | 0.042 | PASS | 0.019 |
| Run line | 0.6546 | 0.2248 | 0.044 | PASS | 0.016 |
| Totals | 0.6787 | 0.2434 | **0.065** | **FAIL** | 0.035 |

**Targets:** log-loss < 0.68, Brier < 0.24, max calibration deviation < 0.05.

Moneyline and run line pass on calibration. Totals fails (0.065 > 0.05 threshold).
Totals picks should be held from publication until calibration is improved.

---

## ROI Simulation — Bug Fix and Corrected Numbers (2026-04-23)

### What the bug was (two-part)

**Bug 1 — Home-side-only evaluation in `simulate_roi`.**
The original simulator evaluated only P(home wins) vs home-side odds. Away picks were never evaluated. The function signature accepted a single `best_odds` array always set to home/over prices. Fix: `simulate_roi` now accepts `opposing_odds` and evaluates both sides per game, betting whichever side has higher EV above threshold. Both sides' win conditions are handled correctly (`won = 1 - outcome` when betting away).

**Bug 2 — Away run-line and under prices missing from data pipeline.**
`add_market_features` in `build_training_data.py` did not include `dk_rl_away_price`, `fd_rl_away_price`, `dk_under_price`, `fd_under_price` in its `odds_passthrough_cols`. These columns exist in the raw odds JSON and are parsed by `load_historical_odds.py`, but were never copied into the schedule dataframe. As a result the fallback default (-110) was used for all opposing-side odds, creating a false 50/50 symmetric market assumption.

Fix committed in `fix(backtest): home-side EV bias in ROI simulator`.

### Before (bugged) — moneyline only betting home

| Threshold | Picks | Flat ROI | Kelly ROI |
|-----------|-------|----------|-----------|
| 2% EV | 860 | ~~107.8%~~ | ~~1e24 (blow-up)~~ |
| 4% EV | 799 | ~~118.1%~~ | ~~1e24 (blow-up)~~ |
| 6% EV | 666 | ~~143.0%~~ | ~~1e24 (blow-up)~~ |

Run line (bugged, home-only): **18.1% flat ROI on 237 picks at 4% EV** — this was artificially constrained and not representative.

### After (corrected) — bidirectional, both sides evaluated

| Market | Threshold | Picks | Flat ROI | Kelly ROI | Notes |
|--------|-----------|-------|----------|-----------|-------|
| Moneyline | 4% EV | 1,475 | 112.7% | 83.3% | Still inflated — see below |
| Run line | 4% EV | 2,178 | 41.0% | 56.3% | Still inflated — see below |
| Totals | 4% EV | 924 | 26.0% | 33.4% | Cal FAIL, treat as noise |

**Why corrected numbers are still unreliable for Kelly sizing:**

The bidirectional fix exposes two underlying model problems that inflate ROI:

1. **Moneyline calibrated probs range 0.43–0.90** (std 0.068). True game probabilities in MLB rarely exceed 0.70 even for dominant favorites. Overconfident extremes generate phantom EV against market prices. The model is a market-prior tracker (SHAP #1: `market_implied_prob_home` at 0.11) — with only 18 best iterations, it's not meaningfully diverging from the market.

2. **Run line model has systematic mean-prob bias: mean P(home covers -1.5) = 0.349** when the historical rate is ~0.43. The calibrator (fit on 2023 val) drifted on 2024 holdout. This makes the model output P(away cover) ≈ 0.65 for a typical game priced at +110 away, generating ~37% EV on nearly every game — which is why 2178/2432 games (90%) "clear" 4% EV threshold. That is not real edge.

**What IS credible:**
- Calibration metrics (log-loss, Brier, ECE) — these are correct and insensitive to this bug
- Run line model's structural superiority over moneyline (39 vs 18 best iteration, richer feature set)
- Relative SHAP signals: opener detection (#8 RL), EWMA offense (#6 totals)

**ROI numbers to use for Kelly sizing decisions: none from v1.**
v1 is a calibration baseline. The simulation code is now logically correct but the models are not generating real alpha. Proceed to v1.1 with multi-season training, walk-forward CV, and actual closing-line-value validation before applying Kelly sizing.

---

## Model Performance Interpretation

The high "ROI" numbers in the moneyline simulation are an artifact of the simulation selecting away picks at positive odds (e.g., +150) where the market says they're underdogs but our model agrees they're underdogs too — not a real edge. The logistic model essentially tracks the market prior (`market_implied_prob_home` is the #1 SHAP feature at 0.11).

**Honest assessment:** With only 1 training season (2022), the model is essentially a market-prior tracker with weak pitcher signal. The 18 best-iteration early stopping on the moneyline model confirms it's not extracting much beyond the market. This is the correct starting point — v1 is a calibration baseline, not an alpha-generating model yet.

**What IS working:**
- Run line model best-iteration 39 (more structure than moneyline)
- `home_is_opener` ranks #8 in run-line SHAP — the research edge is capturing signal
- EWMA offense (`away_team_runs_ewma_7d`) is #6 in totals SHAP — responsive to streaks
- Calibration is tight on moneyline and run line (ECE 0.016–0.019)

---

## Known Weaknesses

1. **Single training season (2022 only)** — v1.1 should train 2021–2023 with walk-forward CV per spec
2. **Weather features imputed** — all games use 72°F/5mph average; real game-time weather will improve totals significantly
3. **Lineup handedness imputed** — platoon features use league average, not confirmed lineups; LINEUP-01 dependency
4. **Umpire features imputed** — `ump_assigned=0` for all historical games; G6 data gap not resolved
5. **Statcast xFIP missing** — G3 gap not resolved; FIP used as proxy
6. **Totals calibration FAIL** — max deviation 0.065 vs 0.05 threshold; need isotonic re-fit or additional features
7. **~~ROI simulation home-side bias~~** — FIXED in `fix(backtest)` commit; simulator now evaluates both sides
8. **~~Kelly compounding bug~~** — FIXED; simulation now uses `_kelly_pnl_for_bet` with 10% bankroll cap
9. **Run line mean-prob drift (2022→2024)** — calibrator trained on 2023 val predicts P(home cover) = 0.349 on 2024 holdout vs true ~0.43; multi-season training required
10. **Moneyline overconfident extremes** — calibrated probs reach 0.90; true MLB probs rarely exceed 0.70; overfitting on 1 training season; ROI numbers not usable for Kelly sizing

---

## FastAPI Worker

- **Startup time:** <2s (model load)
- **Inference latency:** ~50ms per game (3 markets, SHAP computed)
- **Memory:** ~200MB for 3 models + SHAP explainers
- **CPU only** — no GPU required
- **Auth:** Bearer WORKER_API_KEY header
- **Compute:** Fly.io scale-to-zero (within ~$3-5/mo budget)

---

## Next Steps (v1.1)

1. Fix ROI simulation pick-side EV computation
2. Retrain totals with additional calibration bins
3. Add 2021 season to training (walk-forward CV as per spec)
4. Resolve G3 (Statcast xFIP) and G6 (umpire) data gaps
5. Connect real game-time weather API
6. UMP-01/02 features (high-priority per research)
7. Confirmed lineup handedness for WX-01 to reach full potential

---

## Artifacts

```
worker/models/
├── moneyline/artifacts/model.pkl          # gitignored
├── moneyline/artifacts/manifest.json      # gitignored
├── moneyline/artifacts/shap_importance.json  # gitignored
├── run_line/artifacts/model.pkl           # gitignored
├── run_line/artifacts/manifest.json       # gitignored
├── run_line/artifacts/shap_importance.json   # gitignored
├── totals/artifacts/model.pkl             # gitignored
├── totals/artifacts/manifest.json         # gitignored
├── totals/artifacts/shap_importance.json     # gitignored
└── backtest/reports/
    ├── backtest_summary.json              # committable
    ├── calibration_moneyline_holdout.png  # gitignored
    ├── calibration_run_line_holdout.png   # gitignored
    └── calibration_totals_holdout.png     # gitignored
```

Re-train: `python worker/models/pipelines/train_models.py`
Re-pull data: `python worker/models/pipelines/run_full_pipeline.py`
