# Moneyline v0 — Research Memo

**Date:** 2026-04-30
**Author:** mlb-research
**Scope:** First model artifact, moneyline market only. Cold-start lane.
**Comparison baseline:** market prior (closing-line implied probability with vig removed). No incumbent model exists.

---

## Landscape

MLB moneyline is a low-edge market: closing-line implied probabilities are well-calibrated and ROI for naive predictors is negative-to-flat. Recent public-facing work (Kovalchik 2023 on tennis carries directly; Boice/FiveThirtyEight Elo retired but the framing remains a useful floor; Baumer & Matthews 2014; pinned community evidence on r/sportsbook and Statathon write-ups) converges on three robust patterns: (1) market-aware blends beat from-scratch models almost always at low n; (2) starter-quality + park + bullpen + lineup quality + weather captures most pre-game signal; (3) calibration matters more than raw discrimination because Kelly sizing is sensitive to bias near 0.5.

Sources: Boice (FiveThirtyEight Elo retirement post 2023); Baumer & Matthews, "openWAR" (J. Quant. Anal. Sports 2014); Pinnacle "Betting Resources" closing-line efficiency essays; Statathon 2024 winning entries (lightgbm + market features); Kovalchik on calibration in tennis betting (J. Sports Analytics 2023).

## Candidate approaches

**A. Market-prior-only baseline.** No model. Implied probability from de-vigged DK/FD closing line. Calibrated by construction. Costs nothing. This is the floor every other approach must beat — and it's surprisingly hard to beat at n=200.

**B. Gradient boosting on engineered features (LightGBM / XGBoost / CatBoost).** Tabular workhorse. Trains in seconds on 4 seasons (~9.7K games). Serves in <50ms. Native CPU on Vercel Fluid Compute. Calibration is post-hoc (isotonic or sigmoid). Risk: ignores market unless market features are included; tends to overfit at low sample.

**C. Logistic regression with market log-odds + a small structured feature set.** The market log-odds enters as a feature with a coefficient near 1.0; remaining coefficients capture residual signal. Trivial to train, trivial to serve, near-impossible to overfit at n=9.7K, calibrated near-natively for binary. The "market-prior-aware blend" form preferred in efficient-market literature.

**D. Bayesian hierarchical (Stan / PyMC team-strength priors).** Conceptually appealing. Cost: training time on Vercel is borderline; iteration loop is slow; no clear empirical advantage at moneyline at this sample.

**E. Game simulation (lineup-vs-pitcher Monte Carlo).** High effort to build, high feature surface, doesn't engage market without a wrapper. Better v1.x than v0.

**F. Stacked / neural tabular (TabNet, FT-Transformer).** No empirical case at this n. Cold-start risk.

## Recommendation

**Primary: Approach C — logistic regression with market log-odds anchor + residual structured features.** Cheapest to train, cheapest to serve (<5ms), structurally market-aware (the log-odds coefficient near 1.0 is the testable diagnostic), and the variance-collapse guard becomes a clean numerical check (does the model produce p ≠ market_p on enough games?). Calibration is near-native; isotonic post-hoc is a one-line wrap if reliability fails. At n=9.7K this is the form least likely to overfit and most likely to clear the v0 ECE ≤ 0.04 bar.

**Fallback: Approach B — gradient boosting (LightGBM) with the same feature set plus the market log-odds as an explicit feature.** Used if the logistic model fails to clear ROI ≥ 0% on the holdout despite clean calibration — i.e., if there's residual nonlinearity worth capturing. Same serving constraints (CPU, <50ms), same calibration wrap.

**Why not the others.** Market-prior-only is the comparison floor, not a product (no edge). Bayesian/simulation/neural have no empirical case at this sample and slow the iteration loop. The bar is empirical advantage, not methodological novelty.

## Comparison framing

- **Holdout shape:** 2024 regular season, post-All-Star-break (≈1,200 games). Train on 2021–2023 + 2024 pre-break. Holdout is contiguous and time-forward — no random split.
- **Sample n:** ≈1,200 games × ≈2 sides = up to 2,400 observations; v0 floor is ≥200 graded picks after EV threshold filter.
- **Metrics:** ROI on staked picks, CLV vs closing line, ECE (binned 10), max calibration deviation, log-loss vs market-prior baseline, picks-per-day distribution.
- **Promotion bar (cold-start, from CLAUDE.md):** ROI ≥ 0%, CLV ≥ 0%, ECE ≤ 0.04, ≥200 graded picks, look-ahead audit clean, variance-collapse guard clean, rationale eval PASS, CEng sign-off.
- **Beat-the-prior margin:** log-loss improvement ≥ 0.002 vs market-prior on the holdout (≈1% relative). Below that, the model is the prior in disguise — ship the prior.

## What downstream specialists need to know

**mlb-feature-eng — first feature set (≈12 features, snapshot-pinned at T-60min):**
1. `market_log_odds_home` — de-vigged DK+FD consensus, the anchor
2. `starter_fip_home` / `starter_fip_away` — last-30-day, MLB Stats API
3. `starter_days_rest_home` / `_away`
4. `bullpen_fip_l14_home` / `_away`
5. `team_wrcplus_l30_home` / `_away` — lineup quality, lineup-aware once `lineup_entries` is locked
6. `park_factor_runs` — venue-level, static table
7. `weather_temp_f` / `weather_wind_out_mph` — already in `games`/weather columns
8. `b2b_flag_home` / `_away` — back-to-back game indicator
9. `home_field` — boolean

No Statcast in v0. No umpire effects in v0 (umpire moves totals more than moneyline). News/sentiment deferred to v1.x.

**mlb-model:** scikit-learn `LogisticRegression(C=1.0)` or `LogisticRegressionCV` with stratified time-series CV for the C sweep. Artifact = `joblib` pickle, <100KB. No GPU, no >300s training. Serve via Vercel Function with a single-row predict; budget <50ms incl. Supabase fetch.

**mlb-calibrator:** binary isotonic on the holdout's pre-break slice if reliability fails the ECE ≤ 0.04 bar; otherwise ship raw sigmoid. Calibration set must be disjoint from selection set.

**mlb-backtester:** EV threshold sweep at +1%, +2%, +3% expected value vs DK+FD best line; report ROI/CLV at each. CLV computation uses closing-line-vig-removed implied probability.

---

## Open questions (escalate if blocking)

- 2021 data quality for `lineup_entries` — if MLB Stats API backfill is sparse, drop to 2022–2024 (still ≈7K games).
- Vig-removal method for market prior: shin-vs-proportional. Default proportional; document choice in artifact `architecture.md`.
