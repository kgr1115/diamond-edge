# Calibration Specification — Confidence Tier Mapping

**Date:** 2026-04-22
**Author:** mlb-ml-engineer
**Task:** TASK-005

---

## Purpose

This document defines:
1. How raw LightGBM scores are converted to calibrated probabilities
2. How EV and uncertainty are combined to produce `confidence_tier` (1–5)
3. How calibration quality is validated against backtest data
4. The reliability diagram specification

The confidence tier is the number users see first. It must be trustworthy — a tier-5 pick that loses 70% of the time destroys the product. Calibration correctness is non-negotiable.

---

## Step 1 — Probability Calibration (Raw Score → Calibrated Probability)

LightGBM produces raw log-odds scores that are generally well-ordered but not calibrated (the magnitude of the score doesn't directly correspond to win probability percentages).

**Method: Platt Scaling (Logistic Regression on Holdout)**

```python
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegression
import lightgbm as lgb

# 1. Train LightGBM on training folds
lgb_model = lgb.LGBMClassifier(...)
lgb_model.fit(X_train, y_train)

# 2. Get raw scores on validation fold (held out from training)
val_scores = lgb_model.predict_proba(X_val)[:, 1]  # raw probabilities (not yet calibrated)

# 3. Fit Platt scaling on validation fold only
platt = LogisticRegression()
platt.fit(val_scores.reshape(-1, 1), y_val)

# 4. Apply calibration at inference time
def calibrate(raw_prob: float) -> float:
    return platt.predict_proba([[raw_prob]])[0][1]
```

**Validation:** After Platt scaling, generate reliability diagram on 2024 holdout. Each decile bin must have actual win rate within ±5% of predicted probability. If any bin fails, try isotonic regression calibration as fallback:

```python
from sklearn.isotonic import IsotonicRegression
iso = IsotonicRegression(out_of_bounds='clip')
iso.fit(val_scores, y_val)
calibrated_prob = iso.predict([raw_prob])[0]
```

Isotonic regression is more flexible but can overfit on small validation sets. Use Platt by default; switch to isotonic only if Platt miscalibrates by >5% in any bin.

---

## Step 2 — EV Computation

Expected value is computed from the calibrated probability and the best available line:

```python
def compute_ev(model_prob: float, american_odds: int) -> float:
    """
    model_prob: calibrated P(pick_side wins), 0.0–1.0
    american_odds: American odds for the pick_side (e.g., -110, +150)
    Returns: EV per $1 wagered
    """
    if american_odds > 0:
        net_win = american_odds / 100.0      # e.g., +150 → win $1.50 per $1 bet
    else:
        net_win = 100.0 / abs(american_odds)  # e.g., -110 → win $0.909 per $1 bet

    ev = model_prob * net_win - (1 - model_prob) * 1.0
    return ev
```

**Best line selection:** Take the maximum `american_odds` across DK and FD for the pick_side (better odds = higher EV). Compute EV against this best line only.

---

## Step 3 — Uncertainty Estimation (Bootstrap CI)

Calibrated probability has uncertainty from limited training data and model variance. Bootstrap uncertainty is estimated at inference time using LightGBM's built-in ensemble variance.

**Method:** Train 50 LightGBM models with different `random_state` seeds on bootstrap samples of the training data. At inference, take the standard deviation of the 50 predictions:

```python
def compute_uncertainty(feature_vector: np.ndarray, ensemble: list) -> float:
    """
    ensemble: list of 50 LightGBM models trained on bootstrap samples
    Returns: std dev of predictions across ensemble (uncertainty)
    """
    preds = np.array([m.predict_proba(feature_vector)[0][1] for m in ensemble])
    return preds.std()
```

**Uncertainty thresholds:**
- Low uncertainty: std < 0.03 (model is confident, all ensemble members agree)
- Medium uncertainty: 0.03 ≤ std < 0.06
- High uncertainty: std ≥ 0.06 (ensemble members disagree significantly)

High uncertainty can penalize the confidence tier (tier knocked down by 1) even if EV is positive.

---

## Step 4 — Confidence Tier Mapping

### Baseline Tier from EV

| Tier | EV Range | Interpretation |
|---|---|---|
| 1 | 0% < EV ≤ 2% | Marginal edge; likely within noise for small samples |
| 2 | 2% < EV ≤ 4% | Moderate edge; model favors pick but not strongly |
| 3 | 4% < EV ≤ 6% | Good edge; **minimum publication threshold** |
| 4 | 6% < EV ≤ 9% | Strong edge; clear model signal |
| 5 | EV > 9% | Premium edge; rare (expect 0–1 per day on a full slate) |

This baseline matches the architect's suggested table. **Validation against backtests is required before locking.**

### Uncertainty Adjustment

After assigning the EV-based tier, apply an uncertainty penalty:

```python
def assign_confidence_tier(ev: float, uncertainty: float) -> int:
    # Step 1: EV-based baseline tier
    if ev <= 0:
        return 0  # no pick (filtered before this)
    elif ev <= 0.02:
        base_tier = 1
    elif ev <= 0.04:
        base_tier = 2
    elif ev <= 0.06:
        base_tier = 3
    elif ev <= 0.09:
        base_tier = 4
    else:
        base_tier = 5

    # Step 2: Uncertainty penalty
    if uncertainty >= 0.06:
        penalty = 1  # knock down one tier for high uncertainty
    else:
        penalty = 0

    # Step 3: Floor at 1 (never below 1 for EV-positive picks)
    return max(1, base_tier - penalty)
```

### Validation Against Backtest

The tier boundaries above are **starting points**. After running the backtest, validate each tier:

| Tier | Expected win rate (moneyline, −110 book) | Min required ROI |
|---|---|---|
| 1 | 52.4% (break-even at −110) | Break-even ± noise |
| 2 | 53–54% | Slightly positive |
| 3 | 54–56% | Positive (>2% ROI) |
| 4 | 56–59% | Positive (>5% ROI) |
| 5 | >59% | Positive (>8% ROI) |

**If tier N's actual win rate in the holdout does not match expectations:**
- Shift EV thresholds ±1% until tiers are empirically consistent
- Update `assign_confidence_tier` boundaries
- Document the adjustment in the backtest report

**The tier boundaries in this document are updated after backtest validation before the model ships.**

---

## Reliability Diagram Specification

The reliability diagram (calibration curve) is the primary visual artifact for calibration sign-off.

### How to Generate

```python
import matplotlib.pyplot as plt
from sklearn.calibration import calibration_curve

def plot_reliability_diagram(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    market: str,
    n_bins: int = 10,
    output_path: str = None,
) -> None:
    """
    Plots reliability diagram for a model on holdout data.
    y_true: actual outcomes (0/1)
    y_prob: calibrated model probabilities
    """
    fraction_of_positives, mean_predicted_value = calibration_curve(
        y_true, y_prob, n_bins=n_bins, strategy='quantile'  # equal-size bins
    )

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 10))

    # Top: reliability diagram
    ax1.plot([0, 1], [0, 1], 'k--', label='Perfect calibration')
    ax1.plot(mean_predicted_value, fraction_of_positives, 's-', label=market)
    ax1.fill_between(
        mean_predicted_value,
        fraction_of_positives - 0.05,
        fraction_of_positives + 0.05,
        alpha=0.2, label='±5% tolerance band',
    )
    ax1.set_xlabel('Mean Predicted Probability')
    ax1.set_ylabel('Fraction of Positives')
    ax1.set_title(f'Reliability Diagram — {market} — 2024 Holdout')
    ax1.legend()

    # Bottom: histogram of predicted probabilities
    ax2.hist(y_prob, bins=n_bins, edgecolor='black')
    ax2.set_xlabel('Predicted Probability')
    ax2.set_ylabel('Count')
    ax2.set_title('Prediction Distribution')

    plt.tight_layout()
    if output_path:
        plt.savefig(output_path, dpi=150)
    plt.close()
```

### Pass/Fail Criteria

The model ships if **all** of the following hold on the 2024 holdout:

- [ ] No calibration bin deviates from perfect calibration by more than **±5 percentage points**
- [ ] Brier score < 0.24
- [ ] Log-loss < 0.68
- [ ] Bins are reasonably populated (≥ 30 samples per bin) — if a tail bin has < 30 samples, note it but do not fail

If any criterion fails, recalibrate (try isotonic regression) or investigate feature leakage before shipping.

---

## Calibration Sensitivity to Feature Completeness

Until data gaps G1–G5 are filled by the data engineer:
- The model cannot be fully trained
- Calibration validation cannot be completed
- Confidence tier boundaries cannot be finalized

**Interim state:** A placeholder model using only the features available in the current schema (team record, weather from `games` table, market odds from `odds` table — roughly 10 features) can be trained for development/testing purposes. This placeholder model is **not publishable** and must not be exposed to users. It exists only to validate the pipeline plumbing.

---

## How `confidence_tier` Feeds the Pipeline

```
LightGBM raw score
        ↓
Platt scaling (calibrated probability)
        ↓
EV computation (vs best DK/FD line)
        ↓
Bootstrap uncertainty (std across 50-model ensemble)
        ↓
assign_confidence_tier(ev, uncertainty) → confidence_tier ∈ {1,2,3,4,5}
        ↓
Filter: confidence_tier >= 3 → PickCandidate published
        ↓
feature_attributions (SHAP top 7, |shap| ≥ 1e-4) computed
        ↓
PickCandidate written to Fly.io /predict response
```

The filter `confidence_tier >= 3` (EV > 4%) is a **locked decision** per TASK-005 brief. Do not relax this threshold for v1.

### SHAP near-zero filter (pick-scope-gate proposal #6, 2026-04-24)

Attributions with `|shap_value| < 1e-4` are dropped from `feature_attributions` before the top-7 truncation in `sort_attributions` (see `worker/models/pick_candidate_schema.py`). If fewer than 2 attributions survive (Pro tier's citation floor in `worker/app/rationale.py`), the next-highest-by-magnitude dropped entries are backfilled so the rationale generator always has the Pro-tier floor to cite, and a `[WARN] near-zero SHAP filter` log line is emitted.

Rationale: the degenerate B2 moneyline model (`manifest_b2.json.shap_top10`) emits many exactly-zero SHAP values; without filtering, the rationale layer cites features the model has no opinion about. Filtering upstream (at pick-write time) rather than downstream (at rationale-render time) keeps the picks table clean AND preserves cache-hash stability for `rationale_cache.prompt_hash`.

The threshold is stored as `SHAP_NEAR_ZERO_THRESHOLD = 1e-4` in `pick_candidate_schema.py`. The minimum backfill floor is `MIN_ATTRIBUTIONS_FLOOR = 2`, matching Pro's 2-citation rationale-eval rule. Applies to NEW picks only; historical rows are not retroactively filtered.

---

## Known Calibration Risks

| Risk | Mitigation |
|---|---|
| Small sample in extreme bins (>75% or <25% predicted prob) | Flag bins with <30 samples; do not fail on them |
| Overfit calibration on validation fold | Use 3-fold walk-forward CV for Platt fitting, not single fold |
| LOB% and xFIP from Statcast may not have full 2021–2023 history | Use FIP as fallback; note coverage gap in backtest report |
| Model confidence artificially high for starting pitcher prop (v1 stretch) | Props deferred to v1.1; not calibrated in this spec |
| Season-long calibration drift (model trains on April but used in September) | Add month/day-of-season as a feature; monitor calibration monthly post-launch |
