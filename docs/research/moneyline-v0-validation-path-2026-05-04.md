# Moneyline v0 — validation path research memo

**Date:** 2026-05-04
**Author:** mlb-research (research worktree)
**Decision target:** which additional validation to run on the moneyline-v0 logistic before any methodology change is even considered. Methodology-validation, not methodology-shift — locked invariants are preserved.
**Recommendation:** **walk-forward refit on a second pre-ASB 2024 holdout, plus three named baseline rivals on both holdouts**, scripted as one `validate-moneyline-v0.py` driver. Specifics in the proposal in Section 3.

---

## What the v0 holdout already tells us

- ROI +11.33% at +2% EV, bootstrap CI (+0.67%, +22.65%) on n=416 picks, 73 days.
- ECE 0.0304 raw (point), CI upper 0.0747 — wide because n=609.
- Anchor coefficient 0.977, CI (0.78, 1.17) — model accepts the line cleanly.
- Log-loss delta vs market +0.0022, CI (-0.0025, +0.0071) — point favors model, CI spans 0.
- Sum |residuals| 0.295, well above the 0.05 collapse floor.
- All on **one** post-ASB-2024 slice. 73 days, n=416 picks at +2% EV.

What this does NOT tell us:
1. Is the +11.33% a 2024-post-ASB-shaped result, or does the model carry across a different slice with a different umpire/weather/injury mix?
2. Does the +0.002 log-loss delta survive on a second slice, or is the CI-spans-zero result the truth?
3. Does the model beat *named alternatives* that are cheaper/simpler, or only beat "no model"? CEng signed off on cold-start positive, but methodology-validation needs comparison-against-alternatives — a v0 that loses to anchor-only on a second slice is variance, not edge.
4. Is the calibration drift pattern stable across the season (May vs August vs October)?

The validation needs to attack 1 and 3 first; 2 and 4 fall out of the same exercise.

---

## 1. Survey of relevant validation approaches

### A. Walk-forward / expanding-window refit

Re-fit on a strict prefix, evaluate on the next contiguous slice, repeat. The most defensible time-series validation for sports because it respects the actual data-generating order and matches how the model will be retrained in production.

For our 2022-09 → 2024-09-30 window with 2024-post-ASB already used, the natural second fold is **train 2022-09 → 2024-pre-2024-season** (≈2,400 graded games, drop predicate applied), **holdout 2024-pre-ASB** (~1,500 finals, ~250-400 graded picks). One additional fold is realistic; three folds would exhaust the data and leave the post-ASB holdout double-counted.

Cost: low (~30s training × 2, ~1 hour scripting). Look-ahead risk: structurally none if the holdout-declaration pattern is reused. Locked-invariant impact: none — the holdout-discipline + market-prior + comparison-against-current invariants all carry forward; the "current" being compared against is the v0 itself plus named alternatives.

### B. Time-series block bootstrap on the existing holdout

Resample contiguous blocks (e.g., 7-day blocks) from the existing holdout n=609 to widen the CI on ROI / ECE / log-loss. This is what `backtest-finalize-moneyline-v0.py` *should* be doing; it currently does i.i.d. bootstrap, which under-counts variance because betting outcomes within a slate are correlated (same weather, same umpire crew, same news cycle).

Cost: very low (~1 hour to swap the resample function). Information gain: tightens the honesty of the existing CI but does not produce a new out-of-sample evaluation. Useful as a complement to walk-forward, not a substitute.

### C. Comparison against named baselines

Three baselines worth running on every holdout:

1. **Market-prior only** — `p_home = sigmoid(market_log_odds_home)`. The "no model" baseline. The claim "the model beats the market" is empty without it on each slice.
2. **Anchor-only logistic** — fit a 1-feature logistic (anchor only). Distinguishes "the residuals carry signal" from "the anchor's coefficient happens to land at 0.977 and that's the entire effect."
3. **Anchor + favorite-team-win-pct residual** — minimal residual baseline. If the 11-residual model can't beat a 2-feature model on a second slice, the residuals are noise.

Cost: trivial — each is a one-line `LogisticRegression` fit on the same features dataframe. Information gain: directly attacks the "is the residual stack pulling its weight" question that the anchor coefficient CI containing 1.0 raises.

### D. Conformal prediction for prediction intervals

Wrap the model in inductive conformal prediction (split-conformal: hold out a calibration slice, derive a quantile threshold, produce prediction sets with 1−α coverage guarantee). For binary classification this collapses to either {0}, {1}, or {0,1} sets at the user's chosen α.

Cost: medium (a day of work, requires a new calibration slice that doesn't overlap holdout). Information gain for moneyline: low. Conformal sets give coverage guarantees on prediction *sets*, not on point probabilities; for a binary outcome the set is almost always {0,1} at useful α and you learn little. Useful for props (continuous outcome) and for downstream Kelly sizing once a real edge exists. Not the right tool here.

### E. Forward paper-trade window

Wait for live picks to accumulate, grade them, compare to the holdout-claimed ROI. This is already wired (the live cron writes graded picks; CEng's `live_ece_recheck_at_200_picks` condition formalizes the check at 200-400 graded picks).

Cost: zero engineering, ~6-12 weeks calendar wait. Information gain: highest possible (real out-of-sample, real money model). This is the *eventual* validation; it is not a substitute for an additional historical holdout because it doesn't change anything we can act on this week.

### F. UI shadow backfill of the existing 416 holdout picks

Insert the 416 holdout picks into the `picks` table as `visibility='shadow'` so Kyle can scroll them on the history page. Pure data-plumbing, no validation content beyond what's already in `holdout-predictions.parquet`. Useful for product-feel and for sanity-checking the rendering layer; does not change confidence in the model.

Cost: low (a script + a `visibility` column or flag). Information gain for validation: zero. Worth doing as a separate UX item, not as part of validation.

### G. Re-train with `batter_game_log.wrc_plus` populated

Two of 11 residuals (`team_wrcplus_l30_home/away`) are zeroed because the source column is unfilled. Re-populating wRC+ would let the L2 fit those coefficients and the residual loadings would shift. CEng accepted this as a v0 follow-up.

Cost: substantial (mlb-data-engineer needs to ingest wRC+ from a Statcast/FanGraphs source — that is a separate project with its own coverage audit). Information gain: structurally changes the model, so it tests a *different* model, not the validation of the current one. Wrong question for this memo. Belongs in a separate `kind: feature-change` proposal.

### H. Backfill 2025 historical odds for an additional out-of-sample slice

Pull DK+FD historical from The Odds API for 2025-pre-2026-04-23 (the date the live games table starts). Estimated 5-10K credits, well below the 100K ceiling. Yields ~2,200 additional games on a slice the model has never seen.

Cost: medium (5-10K Odds API credits + game/lineup/weather backfill via MLB Stats API + Open-Meteo, ~1 day of mlb-data-engineer time + ~6-12 hours wall clock for the backfills). Look-ahead risk: same as the original backfill (well-controlled). Information gain: very high — a genuine never-touched slice from a different season with different starters / umpires / labor situation. Stronger than walk-forward because walk-forward is still inside the same calendar window the model trained on; 2025 is an honest forward step.

### I. Bigger one-shot holdout (train 2023 only, holdout full 2024)

Trades train sample (3,282 → ~2,400) for holdout sample (609 → ~2,400). Tighter CIs on ROI / ECE / log-loss; weaker fit. Conceptually the same exercise as walk-forward with one fold instead of two, and worse — it discards the full 2024-pre-ASB train signal that walk-forward keeps.

Cost: low. Information gain: the same as one walk-forward fold but bundled with a deliberately weakened model. Walk-forward dominates this option.

---

## 2. Evaluation matrix

| Approach | Adds vs current holdout | Cost (effort + $) | Look-ahead risk | Locked-invariant impact |
|---|---|---|---|---|
| A. Walk-forward (1 extra fold, 2024-pre-ASB holdout) | Second OOS slice (~250-400 picks). Catches 2024-post-ASB-specific overfit. | ~1 day scripting, $0 | None if pre-declared | None |
| B. Block bootstrap on existing holdout | Honest CI accounting for slate correlation. No new OOS data. | ~1 hour | None | None — strengthens existing reporting |
| C. Named baselines on both holdouts | Tests "residuals pull weight" and "anchor-only is enough" directly | ~2 hours | None | None — adds explicit comparison rivals |
| D. Conformal prediction | Coverage guarantees on prediction sets | ~1 day | Requires extra calib slice | None, but wrong tool for binary |
| E. Forward paper-trade | Real-money out-of-sample | $0 eng, 6-12 weeks calendar | Zero | None — already wired |
| F. UI shadow backfill | Product-feel; zero validation content | ~half day | Zero | None — orthogonal |
| G. Re-train with wRC+ populated | Tests a *different* model, not this one | days-to-weeks (data eng project) | Re-introduces train/serve mismatch risk until parity tests pass | Different model — needs its own holdout if done |
| H. 2025 backfill + OOS evaluate | Genuine forward slice, ~2,200 new games | ~1 day eng + 5-10K credits + ~12h wall | Low (same audit pattern) | None |
| I. Bigger one-shot holdout | Worse than A | ~1 day | None | Discards train signal; weak choice |

---

## 3. Recommended path (proposal schema)

```yaml
proposal_id: moneyline-v0-validation-walkforward-baselines-2026-05-04
proposer: mlb-research (research worktree)
kind: validation  # NOT a model-change; methodology stance unchanged
lens: CEng (informational; no veto required since locked invariants preserved)
claim: >
  Run a single-script validation driver that (a) refits the v0 logistic on a
  prefix-only training window ending 2024-pre-ASB and evaluates on the
  pre-ASB 2024 slice, (b) evaluates three named baselines (market-prior-only,
  anchor-only logistic, anchor+favorite-win-pct logistic) on BOTH the existing
  post-ASB holdout AND the new pre-ASB holdout, (c) re-runs ROI/log-loss/ECE
  bootstrap with 7-day-block resampling on both slices. Produces a single
  validation report at docs/audits/moneyline-v0-validation-2026-05-04.json
  + a markdown summary at docs/audits/moneyline-v0-validation-2026-05-04.md.
  Goal: confirm the v0 ROI generalizes off the post-ASB-2024 slice and
  confirm the residual stack pulls weight against named alternatives. No
  model artifact change ships out of this; it is a confidence pass.
evidence:
  - Existing v0 has one OOS holdout of 73 days / n=416 picks. Single-slice
    ROI estimates have known wide variance in MLB betting; second slice is
    standard practice.
  - The anchor coefficient CI (0.78, 1.17) contains 1.0; the log-loss delta
    CI spans zero. Both are signals that the residuals' contribution is on
    the edge of detectability at this n. Named-baseline comparison
    (anchor-only logistic, market-prior) is the direct test of whether the
    residual stack is doing work.
  - The pre-ASB 2024 slice (2024-04-01 through 2024-07-15, ~104 days,
    expected ~1,400 finals / ~300-450 graded picks at +2% EV after the
    Option A drop predicate) is structurally available — feature parquets
    do not yet include it as a holdout because the original declaration
    chose post-ASB. A new pre-declaration must be filed BEFORE any refit
    runs.
  - All four models (v0 + 3 baselines) use features already in
    data/features/moneyline-v0/*.parquet. No new ingestion. Marginal cost
    is one Python script and ~30s of training.
comparison:
  - approach_a: validate v0 only on the existing post-ASB-2024 holdout (status quo)
  - approach_b: walk-forward refit + named baselines + block bootstrap (recommended)
  - approach_c: backfill 2025 historical odds for a forward slice (strongest, but ~1 day eng + 5-10K credits + ~12h wall; recommended as a follow-up if approach_b uncovers a slice-specific result)
  - delta_metrics:
      v0_holdout_roi_post_asb_2024: 0.1133 (CI lower 0.0067, n_picks 416) — known
      v0_holdout_roi_pre_asb_2024: TBD — target same sign, CI lower >= -1%
      anchor_only_roi_both_slices: TBD — v0 should beat by >= 1pp on at least one slice
      market_prior_roi_both_slices: TBD — v0 should beat by >= 2pp on each slice
      log_loss_delta_vs_market_pre_asb_2024: TBD — target positive point, CI may span zero
      ece_pre_asb_2024: TBD — target <= 0.04 absolute (no isotonic wrap unless breached)
      block_bootstrap_roi_ci_lower_post_asb_2024: TBD — should not flip sign vs i.i.d. CI; if it does, the existing CI was over-confident
risks:
  - Refit on a smaller training prefix (2022-09 → 2024-pre-pre-ASB-2024,
    effective train start 2023-04-01 through 2024-03-28, ~2,000-2,400
    games after drop predicate) may not converge to the same coefficient
    structure. Detected by side-by-side coefficient comparison in the
    validation report.
  - The pre-ASB-2024 holdout pre-declaration MUST be filed before any
    feature/model run touches it. The same `holdout-declaration.json`
    pattern applies — file as
    `models/moneyline/validation-holdout-declaration-pre-asb-2024.json`.
    Any deviation invalidates the audit.
  - Block bootstrap with 7-day blocks on n=609 means ~87 blocks; CI
    stability is fine but at the small end. Report block-size sensitivity
    (5-day, 7-day, 10-day) to make the choice transparent.
  - "Validation passes" is not a license to change the EV threshold or
    re-tune anything on the new slice. The existing +2% threshold and
    isotonic-wrap-on-breach rule stay locked for v0; the validation slice
    is reported, not optimized against.
rollback:
  - Validation produces no shipped artifact — there is nothing to roll back.
  - If the validation surfaces a real failure (v0 ROI flips negative on
    pre-ASB-2024, OR v0 fails to beat anchor-only on either slice by >= 1pp),
    that is a `kind: model-change` discussion for CEng/CSO, NOT an
    auto-rollback of v0. v0 stays current until a successor is approved.
scope:
  - markets_affected: [moneyline]
  - user_facing: no
  - irreversible: no
  - touches_locked_invariants: no — preserves calibrated probabilities,
    holdout discipline (new pre-declaration files first), comparison
    against named baselines, market-prior awareness
attachments:
  - models/moneyline/holdout-declaration.json (existing post-ASB-2024 declaration — pattern to copy)
  - models/moneyline/current/holdout-predictions.parquet (existing OOS predictions to compare against)
  - data/features/moneyline-v0/{train,holdout}.parquet (feature source — train.parquet already covers 2023-04-01 through 2024-07-15; holdout.parquet covers 2024-07-19 onward)
  - scripts/features/build-moneyline-v0.py (feature build that needs to be re-run with new pre-ASB-2024 holdout window)
  - scripts/model/train-moneyline-v0.py (training script to refit on prefix-only window)

execution_plan_summary:
  step_1_pre_declare:
    - File models/moneyline/validation-holdout-declaration-pre-asb-2024.json
      with training_window 2022-09-01 to 2024-03-28 (effective train start
      2023-04-01 — same warmup pattern), holdout_window 2024-04-01 to
      2024-07-15, drop predicate identical to existing declaration, EV
      threshold default +2%. Commit BEFORE step 2.
  step_2_rebuild_features:
    - Run scripts/features/build-moneyline-v0.py with the new declaration
      to produce data/features/moneyline-v0-validation-pre-asb-2024/{train,
      holdout}.parquet. The build is idempotent on the source DB; ~30
      minutes wall clock at most given the inline-bulk-load optimization.
  step_3_train_validation_model:
    - Run an adapted train-moneyline-v0.py against the new train.parquet,
      writing to models/moneyline/validation-pre-asb-2024/ (NOT current/).
      Save model.joblib + scaler.joblib + metrics.json + holdout-predictions.parquet.
  step_4_baseline_fits:
    - In a single new script scripts/model/validate-moneyline-v0.py: fit
      market-prior-only (no fit, just sigmoid of anchor), anchor-only
      logistic, and anchor+favorite-win-pct logistic on each training
      window. Produce predictions on each holdout. The favorite-win-pct
      feature is computed inline from the existing market_log_odds_home
      column (favorite = sign(log_odds), win-pct = season-to-date W/L of
      that team available in the existing batter/pitcher game-log joins).
  step_5_block_bootstrap:
    - Re-run ROI/ECE/log-loss bootstrap on both v0 holdouts with 7-day
      contiguous blocks (and report 5-day + 10-day for sensitivity).
      Replace or supplement the existing i.i.d. bootstrap in
      backtest-finalize-moneyline-v0.py with a `--block-size` flag.
  step_6_report:
    - Write docs/audits/moneyline-v0-validation-2026-05-04.{json,md} with
      a 4-model × 2-slice × {ROI, log-loss-delta, ECE, n_picks, block-bootstrap-CI}
      table and a one-paragraph verdict.
  step_7_decision:
    - All four cells of the v0 row positive ROI with CI lower > -1%, and v0
      beats anchor-only by >= 1pp on at least one slice → validation PASS,
      no further action; bank the result for the next CEng cycle.
    - Any cell of the v0 row negative or v0 loses to anchor-only on both
      slices by >= 1pp → escalate as a `kind: model-change` discussion
      (likely candidate is the LightGBM fallback per the original rev3
      `approach_b_fallback`).

success_criteria:
  - Single docs/audits/ markdown report with the 4×2 table populated.
  - v0 ROI on pre-ASB-2024 slice: positive point, CI lower >= -1% (sub-300
    rule applies if n_picks lands in [200, 300)).
  - v0 beats market-prior baseline by >= 2pp ROI on each slice.
  - v0 beats anchor-only baseline by >= 1pp ROI on at least one slice
    (residual stack must pull weight somewhere).
  - Block bootstrap CI lower bound on post-ASB-2024 ROI does not flip sign
    vs the existing i.i.d. bootstrap (if it does, existing reporting was
    over-confident — flag for CEng).
```

---

## 4. Why this beats Kyle's five candidates

Kyle's five candidates broke into:

- **Walk-forward (his #1)** — the right shape, but his framing missed the named-baseline rivals. Walk-forward against itself proves the model is consistent; walk-forward against market-prior + anchor-only proves the residual stack is doing work. A walk-forward fold that just shows "v0 holds up on pre-ASB too" without a named-baseline comparison leaves the same residual-stack-significance question the existing log-loss-CI-spans-zero result already raised. The recommended path is his #1 plus the named baselines (Section C) plus the block bootstrap honesty fix (Section B), bundled into one driver. Strict superset.
- **UI backfill (his #2)** — orthogonal product work, not validation. Worth doing separately; doesn't change confidence in the model. Recommend treating as a `kind: skill` or `kind: backend` proposal of its own.
- **Bigger one-shot holdout (his #3)** — strictly dominated by walk-forward. Walk-forward gets the same OOS evaluation without throwing away the 2024-pre-ASB train signal. Skip.
- **Re-train with wRC+ populated (his #4)** — tests a *different* model, not this one. Wrong question for a validation pass. The wRC+ ingester fix is already on CEng's follow-up list as a separate `kind: feature-change` proposal; doing it here muddies the validation by changing two things at once.
- **2025 backfill (his #5)** — strongest single signal of the five but >= a day of mlb-data-engineer time, 5-10K credits, and 12h backfill wall. Recommend as a **follow-up if step_7 escalates** rather than the immediate next move. The walk-forward + baselines path delivers most of the confidence in 1 day of work with $0 credits; if it surfaces a slice-specific result, the 2025 forward slice becomes the natural tiebreaker. Order: walk-forward first, 2025 only if needed.

The recommended path is option H of his list reordered: do the cheap, high-information validation now (A + B + C bundled), and queue 2025 as the second-stage check only if the first stage yields a mixed verdict.

---

## Locked-invariant check

| Invariant | Impact |
|---|---|
| Calibrated probabilities | Preserved — no model artifact changes |
| Backtest discipline (pre-declared holdout) | Preserved — new validation holdout pre-declared in step_1 BEFORE any data touches it |
| CLV-aware ROI | Preserved — CLV remains 0 by construction for v0 (same source train/serve); validation reports ROI as primary, log-loss as secondary, both with CIs |
| Comparison-against-current | Strengthened — adds three explicit named baselines (market-prior, anchor-only, anchor+1) to make "v0 better than what" answerable |
| Market-prior awareness | Preserved — market-prior is one of the named baselines and the v0 anchor remains the de-vigged DK+FD line |

No CSO/CEng/COO consultation required. No paid spend. No production mutation. No methodology shift.
