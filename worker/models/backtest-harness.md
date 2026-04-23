# Backtesting Harness — Specification

**Date:** 2026-04-22
**Author:** mlb-ml-engineer
**Task:** TASK-005

---

## Purpose

The backtesting harness validates model performance before any pick is published. It answers three questions:

1. **Does the model predict the right outcomes?** (log-loss, Brier score)
2. **Is the model calibrated?** (reliability diagram — does a predicted 60% win 60% of the time?)
3. **Does the model make money?** (ROI simulation at flat $100 bet sizing, Sharpe ratio on picks above publication threshold)

Without all three passing, the model does not ship.

---

## Data Coverage

| Season | Role | Rationale |
|---|---|---|
| 2021 | Training fold A | Partial COVID season; normalized rosters, still useful |
| 2022 | Training fold B | Full 162-game season |
| 2023 | Training fold C | Full season; expanded playoffs, some lineup changes |
| **2024** | **Holdout (test set)** | **Never seen during training or calibration. No exceptions.** |

**Minimum 3 seasons of training data is locked.** 2021 is included despite the pandemic-era roster irregularities; the model learns to discount partial seasons if needed via cross-validation.

**2025 data:** Not yet complete as of 2026-04-22. If sufficient 2025 data is available at model training time (150+ games per team), fold into training and push the holdout to 2025.

---

## Train / Validation / Test Split

```
2021 ──────────────────────── 2022 ──────────────────────── 2023 ──── | ── 2024
[────────────── TRAINING (2021–2023) ──────────────────────────────]   [TEST]
│                                                                        │
└── Walk-forward CV within training set:                                └── Held out
    Fold 1: Train 2021 first half → Validate 2021 second half
    Fold 2: Train 2021 full + 2022 first half → Validate 2022 second half
    Fold 3: Train 2021–2022 full + 2023 first half → Validate 2023 second half
```

**Walk-forward rationale:** Standard K-fold CV would leak future seasons into training. Walk-forward preserves temporal order — the model is always trained on the past and validated on the future. This mirrors the production setting.

**Calibration fitting:** Platt scaling is fit on the **validation folds** (not training folds) to avoid calibration leakage into the test set.

**Test set is sacred:** The 2024 holdout is touched exactly once — after all hyperparameter tuning and calibration is finalized on the training/validation data. Never iterate on the test set.

---

## Evaluation Metrics

### 1. Log-Loss (Primary Accuracy Metric)

```
log_loss = −(1/N) Σ [y_i * log(p_i) + (1 − y_i) * log(1 − p_i)]
```

- Lower is better. Random baseline: `log_loss ≈ 0.693`
- Target: `log_loss < 0.68` on holdout (meaningful improvement over baseline)
- Report separately for moneyline, run_line, and totals

### 2. Brier Score

```
brier_score = (1/N) Σ (p_i − y_i)²
```

- Range 0–1; lower is better. Random baseline: 0.25.
- Target: `brier_score < 0.23` on holdout

### 3. Calibration Curve (Reliability Diagram)

Bin predictions into deciles (0–10%, 10–20%, ..., 90–100%) and plot:
- X-axis: mean predicted probability per bin
- Y-axis: actual win rate per bin
- Perfect calibration = diagonal line

**Pass criterion:** No bin deviates from perfect calibration by more than ±5 percentage points after Platt scaling. Pre-calibration curves are included for comparison.

Output: `reports/calibration_{market}_holdout.png` — reliability diagram for the 2024 holdout set.

### 4. ROI Simulation — Flat $100 Bet Sizing

For every game in the holdout set where EV > 0 (model probability > implied probability):
- Simulate a $100 bet on the pick_side at the best available line (DK or FD)
- Track wins and losses based on actual outcomes
- Compute: total wagered, total profit/loss, ROI %

```python
def simulate_roi(picks: list[dict]) -> dict:
    """
    picks: list of {model_prob, best_price (American), actual_outcome (0 or 1)}
    Returns ROI stats for bets where EV > 0.
    """
    ev_positive_picks = [p for p in picks if compute_ev(p['model_prob'], p['best_price']) > 0]
    total_wagered = len(ev_positive_picks) * 100
    total_profit = sum(
        compute_profit(100, p['best_price']) if p['actual_outcome'] == 1
        else -100
        for p in ev_positive_picks
    )
    roi_pct = (total_profit / total_wagered) * 100 if total_wagered > 0 else 0.0
    return {
        'n_picks': len(ev_positive_picks),
        'total_wagered': total_wagered,
        'total_profit': total_profit,
        'roi_pct': roi_pct,
    }
```

**Target ROI:** > 0% on 2024 holdout across each market. Positive ROI on holdout is the minimum threshold. A model with negative holdout ROI does not ship.

**Broken out by:**
- Market (moneyline, run_line, totals)
- Confidence tier (1–5)
- Season half (April–June vs July–September — does the model degrade late in the season?)
- Home vs away picks

### 5. Sharpe Ratio on Publishable Picks (confidence_tier ≥ 3)

```
sharpe_ratio = mean_roi_per_pick / std_dev_roi_per_pick
```

Computed only on picks at or above the publication threshold (EV > 4%, tier ≥ 3). Measures risk-adjusted return per bet.

- Target: Sharpe ratio > 0.1 on holdout publishable picks (modest positive edge, not noise)
- Report annualized and as-is

### 6. Pick Frequency

Report how many picks per game-day the model generates above each confidence tier threshold. If the model produces 30 "tier 5" picks per day, the tier mapping is wrong (overconfident). Expected:

| Tier | Expected picks/day (15-game slate) |
|---|---|
| ≥ 1 | 10–20 (most games have some positive EV) |
| ≥ 2 | 5–12 |
| ≥ 3 (publication) | 2–6 |
| ≥ 4 | 0–3 |
| 5 | 0–1 |

If the model produces 0 tier-3+ picks per day consistently, the EV thresholds are too tight or the model is underconfident — recalibrate.

---

## Bet Odds Data

Historical odds must be sourced from a historical odds provider (not The Odds API, which is real-time only). Options:

1. **Retrospective odds database** — OddsPortal or Odds API historical endpoint (paid tier), or a Kaggle MLB betting dataset for 2021–2024
2. **Approximation** — Use season-average vig (−110/−110 for most markets) as a proxy for backtesting. This is acceptable for v1 backtesting; line-specific EV is a v1.1 enhancement.

For v1 backtesting, use **−110/−110 approximation** for moneyline and totals (captures vig cost), and ±1.5 run line at −110. Flag this approximation clearly in backtest reports — line quality is ignored, only direction of edge is tested.

---

## Script Spec

```
worker/
├── models/
│   ├── backtest/
│   │   ├── run_backtest.py         ← Main entry point
│   │   ├── data_loader.py          ← Loads historical games + odds (CSV or DB)
│   │   ├── feature_builder.py      ← Builds feature vectors from raw data
│   │   ├── train.py                ← LightGBM training + Platt calibration
│   │   ├── evaluate.py             ← Log-loss, Brier, calibration curve, ROI
│   │   └── reports/                ← Generated output
│   │       ├── calibration_moneyline_holdout.png
│   │       ├── calibration_run_line_holdout.png
│   │       ├── calibration_totals_holdout.png
│   │       └── backtest_summary.json
```

### How to Run

```bash
# Full backtest (all three markets, all seasons)
python worker/models/backtest/run_backtest.py --markets moneyline run_line totals

# Single market
python worker/models/backtest/run_backtest.py --markets moneyline

# With saved model artifacts (for re-running evaluation only)
python worker/models/backtest/run_backtest.py --eval-only --model-dir worker/models/artifacts/
```

### Expected Output

```json
{
  "backtest_date": "2026-04-22",
  "holdout_season": 2024,
  "moneyline": {
    "log_loss": 0.675,
    "brier_score": 0.228,
    "roi_pct_all_positive_ev": 1.8,
    "roi_pct_tier3_plus": 4.2,
    "sharpe_tier3_plus": 0.14,
    "n_picks_holdout": 847,
    "n_picks_tier3_plus_holdout": 183,
    "calibration_max_deviation_pct": 3.2
  },
  "run_line": { ... },
  "totals": { ... }
}
```

---

## Leakage Safeguards in the Harness

The feature builder enforces leakage prevention programmatically:

```python
class FeatureBuilder:
    def build_features(self, game_date: date, game_id: str) -> dict:
        """
        Builds feature vector for a game. Enforces cutoff: all lookback
        queries are bounded by game_date - 1 day (at minimum).
        Raises LeakageError if any feature lookup touches game_date's results.
        """
        cutoff = game_date - timedelta(days=1)
        # All DB queries include: WHERE game_date <= cutoff
        ...
```

A `LeakageAuditTest` suite (`tests/test_leakage.py`) verifies every feature function individually by asserting that swapping the actual game's outcome does not change any feature value.

---

## Retraining Schedule

- **v1 launch:** Train on 2021–2023, test on 2024 holdout. Ship if metrics pass.
- **Mid-season update:** After 60+ games in the live season, retrain on 2021–2024 + first 60 games of current season. Use latest season's second half as rolling validation.
- **Annual retraining:** Before each season (March), retrain on 3 most recent full seasons.
