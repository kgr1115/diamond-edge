# Diamond Edge Training Report — v1 + v2 + v4

**Date:** 2026-04-23 (v1) / 2026-04-23 (v2) / 2026-04-23 (v4 moneyline)
**Author:** mlb-ml-engineer
**Status:** v4 moneyline training complete. Walk-forward CV confirmed: overfitting was NOT the primary cause of inflated ROI. Full diagnosis below.

---

## v4 — Moneyline Walk-Forward CV (2026-04-23)

### Verdict: NO ALPHA — structural underdog-selection artifact, not model edge

### Leak sources found in v2 (confirmed)

1. **`CalibratedClassifierCV(cv=5, random k-fold)`** applied to combined 2022+2023 training set (`train_models_v2.py` lines 326-334). Random folds allow July-2023 to calibrate against April-2023, violating temporal ordering. This is the exact contamination the task brief anticipated.

2. **Early stopping val = random 15% of combined 2022+2023 train** (`train_models_v2.py` line 426-427). Non-temporal: 2023 games can validate 2022 games out of sequence. This inflates apparent generalization during model selection.

### What walk-forward v4 fixed

- Final model trains ONLY on 2022+H1-2023 (3662 games)
- H2-2023 (Jul-Oct, 1206 games) is a temporal calibration hold-out — strictly after all training data
- Early stopping val = last 10% of training window (temporal)
- 2024 holdout untouched until final evaluation
- Isotonic calibrator fit on H2-2023 raw predictions

### v4 results vs v3 (2024 holdout, vig-removed)

| Metric | v3 (random k-fold) | v4 (walk-forward) |
|--------|-------------------|-------------------|
| ROI @ 4% EV | +15.83% (1526 picks) | +15.6% (1437 picks) |
| ROI @ 6% EV | +17.82% (1325 picks) | +17.23% (1299 picks) |
| ROI @ 8% EV | +17.9% (1177 picks, WR 47.8%) | +17.8% (1172 picks, WR 49.0%) |
| Mean CLV | +0.057% | +0.036% |
| ECE (2024) | 0.013 | 0.015 |
| Log-loss (2024) | 0.683 | 0.681 |

**ROI is unchanged.** The walk-forward fix made zero material difference to the bottom-line number.

### Root cause: structural underdog-selection artifact (not overfitting)

The phantom 17-18% ROI has a different root cause than the data engineer's hypothesis. At 8% EV threshold:

- **64% of picks are underdogs (positive American odds)**, average line +184
- **Win rate: 43.6%** vs market-implied 35.3% = underdogs outperform market implied
- **But this is NOT model edge**: the model outputs near-50% for virtually every game (mean=0.510, std=0.083, max=0.727). Since novig prob for a +184 underdog is ~38%, model's 49% always exceeds novig and passes the edge gate.
- The underdogs' actual 43.6% win rate exceeds market implied (35%) because of vig shading — the market's vig markup on underdogs understates their true probability. Removing vig corrects this partially but the model contributes no signal.
- **CLV = +0.036%** (effectively zero, compared to threshold of >1.0% for real alpha). Lines do not move toward model predictions.

### What the model IS doing

The LightGBM model reaches best_iteration=25 on 3662 training games. With only 25 trees at depth 5, it extracts modest signal from pitcher ERA/FIP and bullpen ERA but outputs a narrow probability range (0.10–0.73, std=0.083). For ~70% of games it outputs 0.45–0.57. The isotonic calibrator then maps these to actual win rates, which are also near 50%. The EV gate sees these near-50% model outputs and passes every game where the odds line prices the team below 40%.

### Calibration metrics (v4, 2024 holdout)

| Metric | Value | Target | Pass |
|--------|-------|--------|------|
| Log-loss | 0.681 | <0.69 | PASS |
| Brier | 0.244 | <0.25 | PASS |
| ECE | 0.015 | <0.025 | PASS |
| Max calibration deviation | 0.066 | <0.05 | FAIL (borderline) |
| Probs > 0.80 | 0 | 0 | PASS |
| Mean P(home win) | 0.510 | ~0.52 | Drift 0.011 |

ECE passes. Max deviation borderline fail (0.066 vs 0.05) — model is slightly miscalibrated in the 0.45-0.55 bucket where it has most of its predictions.

### What to do next (v5 moneyline)

The phantom ROI can only be addressed by either:
1. **Fix the EV gate**: require model probability to exceed novig by a meaningful margin (e.g., +5pp minimum, not just any positive edge). This would reduce pick volume significantly and may reveal true ROI.
2. **More training data**: 3 seasons (2021-2023) with walk-forward protocol. More data = more iterations = wider prob range = fewer near-50% outputs passing the gate.
3. **Probability range fix**: cap EV gate to only bet games where model prob is in [0.35, 0.65] but deviates significantly from novig (e.g., >0.10 gap). Games where model says 0.50 and novig says 0.38 are not real picks.

**The model is NOT ready to ship pick signals.** The ROI number is structurally inflated and CLV confirms no alpha.

---

---

## v2 Summary (2026-04-23)

### Root Cause Investigation Results

**Drift audit (2022+2023 train vs 2024 holdout):**
- 47 features flagged |z|>2, but no single smoking-gun feature
- Largest true-signal drifts (ignoring `year` and `sp_id` identifiers):
  - Batting metrics (ISO, HR/pg, OPS, BA) all drifted -4 to -9σ toward lower values in 2024 — league-wide offensive decline
  - `fd_over_price` drifted +7.5σ (+22 cents) — FanDuel re-priced totals vig
  - `dk_under_price` drifted -5.6σ (-32 cents) — DK under prices shifted
  - SP days rest slightly higher in 2024 (+0.1 days, +4-5σ)

**Smoking gun on run-line ROI — base rate, not model alpha:**
- Home covers run line (`home_score - away_score >= 2`) rate by season: 2022=36.0%, 2023=35.7%, 2024=35.3% — STABLE across all 3 seasons
- The v1 training report's claim that "true historical rate is ~0.43" was incorrect — that figure comes from industry-wide run-line ATS stats that include pushes and use different definitions
- Our specific target definition has a consistent base rate of ~35.4%
- Away team covers +1.5 at rate ~64.6% — market prices away +1.5 at approximately -110 to -115 (implied ~52%)
- The gap (64.6% actual vs ~52% implied) generates phantom EV of ~+12% per game for virtually every away +1.5 pick
- This is a **market-pricing structural artifact**, not model edge. The away run line at +1.5 is systematically underpriced in odds-market terms because sportsbooks set run line vig as a symmetric markup on the moneyline-implied probability, not on the empirical cover rate

**What this means for the product:**
- v2 models are well-calibrated on their own terms (ECE 0.010-0.016, all passing)
- The ROI simulator cannot measure edge until we compute **Closing Line Value (CLV)** — comparing our model's opening-line probability to closing-line probability
- v2 artifacts are the correct models to ship; the simulator output is not a meaningful ROI estimate

### v2 Calibration Metrics (2024 Holdout)

| Market | Log-loss | Brier | ECE | Max dev | ECE pass | Cal pass | probs>0.80 |
|--------|----------|-------|-----|---------|----------|----------|-----------|
| Moneyline | 0.6826 | 0.2448 | 0.013 | 0.071 | PASS | FAIL | 0 |
| Run line | 0.6456 | 0.2267 | 0.010 | 0.057 | PASS | FAIL | 0 |
| Totals | 0.6770 | 0.2424 | 0.016 | 0.071 | PASS | FAIL | 0 |

ECE target (0.025): ALL PASS. Max calibration deviation target (0.05): ALL FAIL.
Hard probability clip at [0.10, 0.80]: ENFORCED (0 probs > 0.80).

Run line P(home cover) mean: 0.3586 vs actual 0.3532 — drift only 0.005 (FIXED from v1 0.349).

### v2 EV Sweep — 2024 Holdout

| Market | EV thr | Picks | Flat ROI | WR | Why ROI is inflated |
|--------|--------|-------|----------|----|---------------------|
| Moneyline | 4% | 1,613 | +108% | 0.492 | Model bets away side at positive odds even when slight underdog |
| Run line | 4% | 2,172 | +42% | 0.643 | 91% away picks at +1.5; away covers at 64.6% base rate |
| Totals | 4% | 687 | +37% | 0.626 | Under side systematically below market implied prob |

**None of these ROI figures represent real alpha.** They are artifacts of base rates embedded in the market structure and our EV threshold calculation method.

### What IS credible in v2

1. ECE < 0.025 for all 3 markets — model probabilities are well-calibrated
2. Run line P(home cover) drift < 0.01 — the v1 calibration drift is fixed
3. Zero probabilities above 0.80 — hard clip preventing overconfident picks
4. Side check at 4% EV: home and away Brier scores nearly equal (0.244 vs 0.222) — no residual side bias
5. SHAP attributions stable and interpretable

### What to fix in v3

1. **CLV-based evaluation**: Compare model prob at pick time to closing line. No CLV framework = no valid EV measurement
2. **Vig removal from EV calculation**: Current EV computes against market American odds directly. Should first remove the vig (compute fair odds) then compute EV — this eliminates the structural phantom EV on away run line
3. **2024 training leakage check**: Confirm 2024 never touched training
4. **Separate run-line EV model**: Run line requires the model to disagree with the market-implied cover probability, not just quote the base rate

---

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
