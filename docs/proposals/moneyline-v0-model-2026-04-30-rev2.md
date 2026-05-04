# Proposal: Moneyline v0 model artifact (rev2)

**Supersedes:** `docs/proposals/moneyline-v0-model-2026-04-30.md` (rev1).
**Why revised:** Two findings from mlb-data-engineer change the data envelope without changing the methodology.
1. The Odds API historical archive starts September 2022 — 2021 closing odds are unavailable at any credit price.
2. The $30 historical-pull cost (≈half a month of the $59 tier) is off the table this cycle. Free / near-free closing-line source is required.

Methodology stance, gates, calibration spec, feature list, cold-start lane treatment, and rollback plan are unchanged from rev1. Training window and closing-line source are revised. All three lens-holders' rev1 conditions are preserved or strengthened.

```yaml
proposal_id: moneyline-v0-2026-04-30-rev2
supersedes: moneyline-v0-2026-04-30
proposer: mlb-research
kind: model-change
lens: cross-lens
cold_start_lane: yes
claim: Ship the first moneyline artifact as a logistic regression with the de-vigged closing-line log-odds as an anchor feature plus ~11 residual structured features, trained on 2022-September through 2024 (≈4,500 games). Closing lines sourced free from a Pinnacle archive as proxy book; isotonic-wrapped if raw reliability misses ECE ≤ 0.04 on the holdout.

evidence:
  - No incumbent model exists; comparison baseline is the market prior (closing-line implied probability, vig-removed proportional). Cold-start lane per CLAUDE.md applies — v0 promotion gates are absolute, not delta-vs-current.
  - Sample available: 2022-September through 2024 regular seasons via MLB Stats API ≈ 4,500 games. Holdout = 2024 post-All-Star-break ≈ 1,200 games / up to 2,400 side-observations. Train slice ≈ 3,300 games. Methodology-change floor of n ≥ 200 graded picks is clearable — projected ≈200–400 graded picks at +2% EV threshold based on rev1 distribution (tighter than rev1 ≈300–600 but above floor).
  - Closing-line source: Pinnacle archive (free) as proxy book. The anchor feature is de-vigged log-odds — book-specific juice (Pinnacle ≈2%, DK/FD ≈4-5%) is normalized away by construction. Residual is per-game shading; closing-line-efficiency literature (Levitt 2004; Pinnacle research blog 2019; Wunderdog 2022) shows median |Pinnacle_devigged_p − DK/FD_devigged_p| ≤ 1% on bulk of MLB games. See `docs/research/moneyline-v0-closing-line-alternatives-2026-04-30.md`.
  - Pre-flight residual-shade audit: before training, compute per-game |pinnacle_devigged_p − dk_fd_devigged_p| on 2026 in-flight games where both are captured in production. Pass condition: median ≤ 1%, 95th percentile ≤ 3%. Fail → switch to fallback closing-line source (pre-built DK+FD-preserving GitHub/Kaggle dataset, validated against MLB Stats API outcomes).
  - Calibration audit plan: binned-10 reliability + ECE on the holdout. Isotonic post-hoc fallback if raw sigmoid output misses ECE ≤ 0.04. Logistic regression is near-natively calibrated for binary outcomes; isotonic is a one-line wrap.
  - Cost: $0 incremental data-pull cost. Pinnacle archive is free; MLB Stats API is free; Open-Meteo historical is free. The $30 Odds API historical line is removed.
  - Latency / artifact: training <30s on Vercel Fluid Compute CPU (logistic regression on ~4.5K rows × 12 features). Serve <5ms per game pre-Supabase fetch; <50ms end-to-end. Artifact ≤100KB. Zero incremental Anthropic spend.
  - Market-prior awareness is structural: the Pinnacle-de-vigged log-odds enters as a feature. Variance-collapse guard: log-odds coefficient should land near 1.0 with non-zero intercept and at least some residual feature loading. Coefficient of 1.0 with all residuals near zero means we are shipping the (proxy) market prior; that fails the guard.

comparison:
  - approach_a: market-prior-only (Pinnacle de-vigged close, used as both training anchor and serve-time anchor)
  - approach_b: logistic regression with market log-odds anchor + 11 residual features (primary)
  - approach_b_fallback: gradient boosting (LightGBM) with same feature set including market log-odds as explicit feature (used only if approach_b fails ROI ≥ 0% with clean calibration)
  - delta_metrics:
      - log_loss_improvement_vs_prior: target ≥ 0.002 absolute (≈1% relative); below this the model is the prior in disguise
      - ROI_holdout: target ≥ 0% on graded picks at +2% EV threshold (graded against DK/FD live closing odds in 2024 holdout slice — DK/FD prices come from the Pinnacle-trained model's serve-time joins to live DK/FD captures already in production for 2026)
      - CLV_holdout: target ≥ 0% (CLV measured against DK/FD closing line for the holdout, NOT Pinnacle — preserves the production CLV semantic)
      - ECE_holdout: target ≤ 0.04 absolute (binned 10)
      - sample_n: ≥ 200 graded picks at the chosen EV threshold
      - max_calibration_deviation: reported, no fixed cap (CEng judgment)
      - proxy_residual_audit: pre-training pass condition (median ≤ 1%, p95 ≤ 3%) — is itself a gate

risks:
  - Proxy-book shading bias (NEW): training on Pinnacle close, serving on DK/FD close, may introduce a systematic small bias on games DK/FD shade harder than Pinnacle (publicly-favored teams, primetime games). Detected by pre-flight residual-shade audit + per-tier reliability deviation on holdout. Mitigation: a constant additive recalibration term can correct mean shift; per-game-cluster mismatch (e.g., bias only on home favorites > -180) requires switching to fallback dataset.
  - Closing-line source freshness (NEW): Pinnacle archive is community-maintained; staleness or coverage gaps possible mid-2024. Detected by pre-training coverage audit (target ≥ 98% game coverage on the train + holdout window). Mitigation: fallback to pre-built DK+FD-preserving dataset.
  - Reduced sample (NEW vs rev1): ≈4,500 games vs rev1's ≈9,700 games. Wider variance bands on every metric. Detected by bootstrap CI on ROI / log-loss-vs-prior. Mitigation: tighten the EV threshold to +3% if +2% picks fall below n=200; gates remain absolute.
  - Holdout shrinkage from cohort window: 2024 post-ASB holdout ≈1,200 games is unchanged (the holdout is post-Sep-2022 already). No mitigation needed.
  - Market efficiency dominates: residual features add ≤ 0.002 log-loss improvement. Detected by the log-loss-vs-prior delta on the holdout. Mitigation: per CSO/CEng rev1 — escalate to user, do NOT ship the prior as v0.
  - Variance collapse: the log-odds coefficient absorbs everything and the model just echoes the line. Detected by coefficient inspection + picks-per-day distribution + variance-collapse guard. Mitigation: regularization sweep, explicit feature scaling, fallback to gradient boosting.
  - Look-ahead leakage in residual features: `bullpen_fip_l14`, `team_wrcplus_l30`, `starter_fip` last-30 must be computed strictly from games before the snapshot pin (T-60min). Detected by mlb-feature-eng's look-ahead audit + a deliberate-leakage canary.
  - Calibration drift across the season: post-ASB holdout calibration may not match May-on-the-next-season. Detected by mlb-calibrator's monthly reliability re-audit once live picks flow. Mitigation: monthly recalibration cron.
  - Lineup data sparsity 2022-September coverage: the post-Sep-2022 boundary is mid-season; partial-season effects on bullpen/starter rolling features. Detected by mlb-feature-eng's training-set integrity audit at the boundary. Mitigation: warmup buffer (drop September 2022 from training, use it only to populate rolling features going into 2023; effective train start = 2023-04-01); reduces sample to ≈4,000 games.
  - Vercel Fluid Compute cold-start: serve latency target per-game ≤ 2s including model load. Mitigation: artifact <100KB, lazy-load once per cold container, serve subsequent games warm.

rollback:
  - Remove the model artifact from `models/moneyline/current/`; revert `models/moneyline/current/` symlink to the empty / market-prior-passthrough baseline (passthrough as INTERNAL fallback only — does NOT ship as a user-facing pick per CSO rev1 condition 3).
  - Disable the moneyline pick generation cron via Vercel env flag `PICK_MONEYLINE_ENABLED=false`.
  - User-facing surfaces fall back to "no picks available" until artifact replaced (NOT "market consensus" framing — per CSO/CEng/COO rev1 conditions).
  - Max time-to-detect for regression: 7 days (≈90 graded picks at expected daily volume); CLV-negative trigger before 7 days fires earlier.

scope:
  - markets_affected: [moneyline]
  - user_facing: yes (this is the first picks artifact)
  - irreversible: no (rollback above is a config flag flip + symlink revert)

attachments:
  - docs/research/moneyline-v0-2026-04-30.md (rev1 research memo — methodology landscape, candidate approaches, feature list)
  - docs/research/moneyline-v0-closing-line-alternatives-2026-04-30.md (NEW — closing-line source survey + recommendation)
  - docs/audits/moneyline-v0-data-coverage-2026-04-30.md (data-coverage audit motivating this revision)

cold_start_promotion_path:
  - This is the v0 cold-start artifact. Per CLAUDE.md, `pick-tester` cannot gate v0. Bundled report (backtest + calibration + feature-leakage audit + variance-collapse guard + proxy-residual audit + rationale eval if applicable) routes directly to CEng for sign-off.
  - On CEng approve: artifact promotes to `models/moneyline/current/` and subsequent changes route through the normal `pick-tester` pipeline.
  - On CEng reject: revisit candidate approaches B (gradient boosting fallback) or surface a methodology-shift escalation to CSO. NO market-prior-as-product fallback (rev1 conditions preserved).

specialist_routing (for pick-implementer):
  - mlb-data-engineer:
      - run pre-flight proxy-residual audit on 2026 in-flight DK/FD vs Pinnacle (BLOCKER for ingestion start)
      - ingest Pinnacle archive 2022-09 through 2024 (free; document source URL + retrieval timestamp in metrics.json)
      - backfill 2022-09 through 2024 regular-season games, lineups, weather via MLB Stats API + Open-Meteo
      - coverage report (target ≥ 98% on train + holdout window)
  - mlb-feature-eng: build the 12-feature snapshot-pinned set; look-ahead canary; train/serve parity test; document serving join — at serve time the anchor feature IS de-vigged DK+FD live close (NOT Pinnacle), so train-vs-serve source mismatch is explicit and the proxy-shade risk lives here
  - mlb-model: train logistic regression; export joblib artifact + architecture.md (must document training source = Pinnacle proxy, serving source = DK+FD live, with the residual-audit numerics inline) + metrics.json
  - mlb-calibrator: reliability audit; isotonic wrap if needed; persist calibration set boundary; per-tier deviation report flagged for proxy-shade signature (e.g., systematic bias on home favorites)
  - mlb-backtester: holdout backtest; EV threshold sweep at +1/+2/+3%; ROI + CLV (CLV computed vs DK/FD close, not Pinnacle) + log-loss vs prior
  - mlb-rationale: deferred until v0 artifact lands; rationale eval is a separate gate

lens_conditions_carried_from_rev1:
  - CSO decision_1 (logistic primary + LightGBM fallback): preserved. metrics.json must persist log-odds coefficient + residual feature loadings.
  - CSO decision_2 (training window 2022–2024): preserved with revision. 2021 already dropped per CEng rev1; rev2 further drops Jan–Aug 2022 due to Odds-API archive boundary. Effective train window 2022-09 → 2024-pre-ASB; with September 2022 used as warmup-only, effective training start 2023-04-01 (≈4,000 games).
  - CSO decision_3 (no consensus-as-product): preserved.
  - CEng decision_1 (logistic-first APPROVED with anchor coefficient + residual loading + picks-per-day reporting): preserved. NEW: also report proxy-residual audit numerics in the bundled v0 report.
  - CEng decision_1_holdout (pre-declare 2024 post-ASB holdout in writing before training): preserved. The holdout pre-declaration must include the closing-line source-of-truth: training = Pinnacle proxy, serving + holdout grading = DK/FD.
  - CEng decision_2 (drop 2021 unless lineup coverage ≥ 95%): preserved; 2021 is independently blocked by Odds API archive limit. Drop is now overdetermined.
  - CEng decision_3 (no market-prior-as-product on dual-gate failure): preserved.
  - COO decision_1 (Vercel Fluid Compute, p95 latency budget, no worker reintroduction): preserved. Confirmed: rev2 reduces compute load (4.5K rows vs 9.7K), so latency budget is unchanged or easier.
  - COO decision_2 (training window — one-time Odds API cost estimate filed pre-pull): VOIDED by rev2 — there is no Odds API historical pull. Replacement condition: file the Pinnacle archive source URL + retrieval timestamp in commit + metrics.json for reproducibility.
  - COO decision_3 (no consensus-as-product): preserved.
  - COO cron_health (monthly recalibration cron registered with telemetry, idempotent on retry): preserved.

new_lens_review_questions:
  - CSO: is training on Pinnacle and serving on DK+FD an acceptable methodology compromise for v0? The de-vigging argument says yes; the pre-flight residual audit is the empirical test. Methodology-agnosticism is preserved (logistic vs LightGBM is still open); the data choice is what changed.
  - CEng: is the proxy-residual audit (median ≤ 1%, p95 ≤ 3%) a sufficient gate, or do you want a stricter bar? Should training-vs-serving source asymmetry be tracked as a recurring metric post-launch?
  - COO: $0 cost path achieved; the watch-item is data-source operational reliability — Pinnacle archive maintenance is third-party-dependent. Is a quarterly source-health check a fair operational ask?
```
