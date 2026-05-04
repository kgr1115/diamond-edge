# Proposal: Moneyline v0 model artifact

```yaml
proposal_id: moneyline-v0-2026-04-30
proposer: mlb-research
kind: model-change
lens: cross-lens
cold_start_lane: yes
claim: Ship the first moneyline artifact as a logistic regression with the de-vigged closing-line log-odds as an anchor feature plus ~11 residual structured features, isotonic-wrapped if raw reliability misses ECE ≤ 0.04 on the holdout.

evidence:
  - No incumbent model exists; comparison baseline is the market prior (closing-line implied probability, vig-removed proportional). Cold-start lane per CLAUDE.md applies — v0 promotion gates are absolute, not delta-vs-current.
  - Sample available: 2021–2024 regular seasons via MLB Stats API ≈ 9,700 games. Holdout = 2024 post-All-Star-break ≈ 1,200 games / up to 2,400 side-observations. Methodology-change floor of n ≥ 200 graded picks easily clearable post-EV-threshold.
  - Calibration audit plan: binned-10 reliability + ECE on the holdout. Isotonic post-hoc fallback if raw sigmoid output misses ECE ≤ 0.04. Logistic regression is near-natively calibrated for binary outcomes; isotonic is a one-line wrap.
  - Cost / latency: training is <30s on Vercel Fluid Compute CPU (logistic regression on ~9.7K rows × 12 features). Serve <5ms per game pre-Supabase fetch; <50ms end-to-end. Artifact ≤100KB. Zero incremental Anthropic spend (rationale is a separate artifact).
  - Market-prior awareness is structural: the log-odds enters as a feature. Variance-collapse guard is a clean numerical test — the log-odds coefficient should land near 1.0 with a non-zero intercept and at least some residual feature loading. A coefficient of 1.0 with all residuals near zero means we're shipping the market prior; that fails the guard.

comparison:
  - approach_a: market-prior-only (de-vigged DK+FD consensus close)
  - approach_b: logistic regression with market log-odds anchor + 11 residual features (primary)
  - approach_b_fallback: gradient boosting (LightGBM) with same feature set including market log-odds as explicit feature (used only if approach_b fails ROI ≥ 0% with clean calibration)
  - delta_metrics:
      - log_loss_improvement_vs_prior: target ≥ 0.002 absolute (≈1% relative); below this the model is the prior in disguise
      - ROI_holdout: target ≥ 0% on graded picks at +2% EV threshold
      - CLV_holdout: target ≥ 0%
      - ECE_holdout: target ≤ 0.04 absolute (binned 10)
      - sample_n: ≥ 200 graded picks at the chosen EV threshold
      - max_calibration_deviation: reported, no fixed cap (CEng judgment)

risks:
  - Market efficiency dominates: residual features add ≤ 0.002 log-loss improvement. Detected by the log-loss-vs-prior delta on the holdout. Mitigation: ship the market prior as the baseline product OR fall back to gradient boosting.
  - Variance collapse: the log-odds coefficient absorbs everything and the model just echoes the line, producing no picks above EV threshold. Detected by coefficient inspection + picks-per-day distribution + the variance-collapse guard. Mitigation: regularization sweep, explicit feature scaling, fallback to gradient boosting.
  - Look-ahead leakage in the residual features: `bullpen_fip_l14`, `team_wrcplus_l30`, `starter_fip` last-30 must be computed strictly from games before the snapshot pin (T-60min). Detected by mlb-feature-eng's look-ahead audit + a deliberate-leakage canary feature that should *fail* the audit.
  - Calibration drift across the season: post-All-Star-break holdout calibration may not match May-on-the-next-season calibration. Detected by mlb-calibrator's monthly reliability re-audit once live picks flow. Mitigation: monthly recalibration cron.
  - Lineup data sparsity 2021: `lineup_entries` backfill may be incomplete. Detected by mlb-data-engineer's coverage report. Mitigation: drop 2021 from training (still ≈7K games).
  - Vercel Fluid Compute cold-start on first game of the day: serve latency target is per-game ≤ 2s including model load. Mitigation: keep artifact <100KB, lazy-load once per cold container, serve subsequent games warm.

rollback:
  - Remove the model artifact from `models/moneyline/current/`; revert `models/moneyline/current/` symlink to the empty / market-prior-passthrough baseline.
  - Disable the moneyline pick generation cron via Vercel env flag `PICK_MONEYLINE_ENABLED=false`.
  - User-facing surfaces fall back to "market consensus" framing (no picks shown) until artifact replaced.
  - Max time-to-detect for regression: 7 days (≈90 graded picks at expected daily volume); CLV-negative trigger before 7 days fires earlier.

scope:
  - markets_affected: [moneyline]
  - user_facing: yes (this is the first picks artifact)
  - irreversible: no (rollback above is a config flag flip + symlink revert)

attachments:
  - docs/research/moneyline-v0-2026-04-30.md (research memo with landscape, candidate approaches, comparison framing, feature list)

cold_start_promotion_path:
  - This is the v0 cold-start artifact. Per CLAUDE.md, `pick-tester` cannot gate v0 (no current artifact to compare). Bundled report (backtest + calibration + feature-leakage audit + variance-collapse guard + rationale eval if applicable) routes directly to CEng for sign-off.
  - On CEng approve: artifact promotes to `models/moneyline/current/` and subsequent changes route through the normal `pick-tester` pipeline.
  - On CEng reject: revisit candidate approaches B (gradient boosting fallback) or surface a methodology-shift escalation to CSO.

specialist_routing (for pick-implementer):
  - mlb-data-engineer: backfill 2021–2024 regular-season games, lineups, weather, closing odds; coverage report
  - mlb-feature-eng: build the 12-feature snapshot-pinned set; look-ahead canary; train/serve parity test
  - mlb-model: train logistic regression; export joblib artifact + architecture.md + metrics.json
  - mlb-calibrator: reliability audit; isotonic wrap if needed; persist calibration set boundary
  - mlb-backtester: holdout backtest; EV threshold sweep at +1/+2/+3%; ROI + CLV + log-loss vs prior
  - mlb-rationale: deferred until v0 artifact lands; rationale eval is a separate gate
```
