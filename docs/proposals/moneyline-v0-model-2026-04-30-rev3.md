# Proposal: Moneyline v0 model artifact (rev3)

**Supersedes:** `docs/proposals/moneyline-v0-model-2026-04-30-rev2.md` (rev2), which itself superseded the original `docs/proposals/moneyline-v0-model-2026-04-30.md` (rev1).

**Why revised again:** Two project-level changes since rev2 collapse the rev2 risk surface back toward rev1's clean direct path:

1. Kyle upgraded The Odds API from the $59/100K tier to the **$119/5M monthly** tier (2026-04-30). Current credit balance: 4,942,000. Historical backfill is now authorized and affordable — `mlb-data-engineer`'s refined estimate is ~45K credits with the h2h-only filter, ≈1% of the 5M monthly tier, $0 incremental dollars on the existing subscription.
2. Kyle archived the LLM rationale work to save Anthropic API cost. v0 ships side + EV + confidence tier only. See `C:\Users\kgrau\.claude\projects\C--AI-Public-diamond-edge\memory\project_2026-04-30_rationale_archived.md`.

The Pinnacle proxy + Kaggle fallback path from rev2 is **retired**. Train and serve both run on DK+FD closing lines pulled from The Odds API — same source for training, holdout grading, CLV, and live serving. The proxy-mismatch risk class disappears entirely. The rationale risk class also disappears — there is no rationale to leak banned keywords or hallucinate.

Methodology stance, gates, calibration spec, feature list, cold-start lane treatment, and rollback plan are unchanged from rev1. Closing-line source reverts to rev1's intent (DK+FD direct). Training window stays at rev2's revised ≈4,500 games (2022-September through 2024) because the Odds API archive boundary at September 2022 is independent of tier — that finding stands.

```yaml
proposal_id: moneyline-v0-2026-04-30-rev3
supersedes: moneyline-v0-2026-04-30-rev2
proposer: mlb-research
kind: model-change
lens: cross-lens
cold_start_lane: yes
claim: Ship the first moneyline artifact as a logistic regression with the de-vigged DK+FD consensus closing-line log-odds as an anchor feature plus ~11 residual structured features, trained on 2022-September through 2024 (≈4,500 games) with closing lines pulled directly from The Odds API for both DK and FD. Isotonic-wrapped if raw reliability misses ECE ≤ 0.04 on the holdout.

evidence:
  - No incumbent model exists; comparison baseline is the market prior (de-vigged DK+FD consensus close, vig-removed proportional). Cold-start lane per CLAUDE.md applies — v0 promotion gates are absolute, not delta-vs-current.
  - Sample available: 2022-September through 2024 regular seasons via MLB Stats API ≈ 4,500 games. Holdout = 2024 post-All-Star-break ≈ 1,200 games / up to 2,400 side-observations. Train slice ≈ 3,300 games (with September 2022 used as warmup-only for rolling features per CEng rev2 carry-forward, effective train start ≈ 2023-04-01, ≈4,000 graded training games). Methodology-change floor of n ≥ 200 graded picks is clearable — projected ≈200–400 graded picks at +2% EV threshold.
  - Closing-line source: The Odds API direct, both DK and FD, for the 2022-09 through 2024 historical window AND for production serving. One API call per game returns both books; the credit cost does not multiply per book. Train source = serve source = CLV-grading source = DK+FD via The Odds API. No proxy mismatch by construction.
  - One-time historical backfill cost: ~45K credits with the h2h-only filter (mlb-data-engineer's refined estimate). At 5M monthly credits this is ≈1% of one month's budget on Kyle's existing $119 subscription — $0 incremental dollars, ~99% of the monthly credit budget remains free for live ingestion + retraining cycles.
  - Calibration audit plan: binned-10 reliability + ECE on the holdout. Isotonic post-hoc fallback if raw sigmoid output misses ECE ≤ 0.04. Logistic regression is near-natively calibrated for binary outcomes; isotonic is a one-line wrap.
  - Cost: $0 incremental dollars (Odds API subscription is pre-paid recurring). $0 incremental Anthropic spend (rationale archived, no LLM call path in v0). Latency: training <30s on Vercel Fluid Compute CPU (≈4.5K rows × 12 features). Serve <5ms per game pre-Supabase fetch; <50ms end-to-end. Artifact ≤100KB.
  - Market-prior awareness is structural: the DK+FD-de-vigged log-odds enters as a feature. Variance-collapse guard: log-odds coefficient should land near 1.0 with a non-zero intercept and at least some residual feature loading. Coefficient of 1.0 with all residuals near zero means we are shipping the market prior; that fails the guard.

comparison:
  - approach_a: market-prior-only (de-vigged DK+FD consensus close, used as both training anchor and serve-time anchor)
  - approach_b: logistic regression with market log-odds anchor + 11 residual features (primary)
  - approach_b_fallback: gradient boosting (LightGBM) with same feature set including market log-odds as explicit feature (used only if approach_b fails ROI ≥ 0% with clean calibration AND demonstrates measurable residual nonlinearity per CEng rev1 condition)
  - delta_metrics:
      - log_loss_improvement_vs_prior: target ≥ 0.002 absolute (≈1% relative); below this the model is the prior in disguise
      - ROI_holdout: target ≥ 0% on graded picks at +2% EV threshold (graded against DK/FD live closing odds in 2024 holdout slice)
      - CLV_holdout: target ≥ 0% (CLV measured against DK/FD closing line — same source as training, no semantic mismatch)
      - ECE_holdout: target ≤ 0.04 absolute (binned 10)
      - sample_n: ≥ 200 graded picks at the chosen EV threshold
      - max_calibration_deviation: reported, no fixed cap (CEng judgment)
      - bootstrap_ci_lower_bound: per CEng rev2 — 1000-iteration bootstrap on ROI, CLV, log-loss-vs-prior, ECE; sub-300 samples ship only if lower CI bound on ROI AND CLV is ≥ −1%

risks:
  - Market efficiency dominates: residual features add ≤ 0.002 log-loss improvement. Detected by the log-loss-vs-prior delta on the holdout. Mitigation: per CSO/CEng rev1 — escalate to user, do NOT ship the prior as v0.
  - Variance collapse: the log-odds coefficient absorbs everything and the model just echoes the line, producing no picks above EV threshold. Detected by coefficient inspection + picks-per-day distribution + the variance-collapse guard. Mitigation: regularization sweep, explicit feature scaling, fallback to gradient boosting.
  - Look-ahead leakage in residual features: `bullpen_fip_l14`, `team_wrcplus_l30`, `starter_fip` last-30 must be computed strictly from games before the snapshot pin (T-60min). Detected by mlb-feature-eng's look-ahead audit + a deliberate-leakage canary feature that should fail the audit.
  - Calibration drift across the season: post-All-Star-break holdout calibration may not match May-on-the-next-season calibration. Detected by mlb-calibrator's monthly reliability re-audit once live picks flow. Mitigation: monthly recalibration cron.
  - Reduced sample (carried from rev2): ≈4,500 games vs the rev1 hypothetical ≈9,700. Wider variance bands on every metric. Detected by bootstrap CI on ROI / log-loss-vs-prior. Mitigation: tighten the EV threshold to +3% if +2% picks fall below n=200; gates remain absolute.
  - Lineup data sparsity 2022-September coverage: the post-Sep-2022 boundary is mid-season; partial-season effects on bullpen/starter rolling features. Detected by mlb-feature-eng's training-set integrity audit at the boundary. Mitigation: warmup buffer (drop September 2022 from training, use it only to populate rolling features going into 2023; effective train start = 2023-04-01); reduces sample to ≈4,000 games.
  - Vercel Fluid Compute cold-start: serve latency target per-game ≤ 2s including model load. Mitigation: artifact <100KB, lazy-load once per cold container, serve subsequent games warm.
  - One-time backfill execution variance: 45K credits is an estimate; a 2× overrun is ≈90K credits, still <2% of the 5M monthly tier. Detected by mlb-data-engineer's pre-flight credit check + post-pull credit reconciliation in metrics.json. Mitigation: cap the pull to a credit ceiling (e.g., 100K) and chunk by month if approached.

risks_dropped_vs_rev2:
  - Proxy-book shading bias — eliminated; same source train and serve.
  - Pinnacle archive ToS / freshness / staleness — eliminated; no Pinnacle ingestion.
  - GitHub/Kaggle fallback dataset hunt + version pinning — eliminated; no fallback dataset needed.
  - Per-cluster proxy-residual audit (CEng rev2 strengthening) — eliminated; no proxy.
  - Rationale hallucination / banned-keyword leak / disclaimer drift — eliminated; rationale archived, no LLM call path in v0.
  - Train-vs-serve source asymmetry as a recurring monthly metric (CSO rev2 condition_4) — eliminated; sources are identical.

rollback:
  - Remove the model artifact from `models/moneyline/current/`; revert `models/moneyline/current/` symlink to the empty / market-prior-passthrough baseline (passthrough as INTERNAL fallback only — does NOT ship as a user-facing pick per CSO rev1 condition 3).
  - Disable the moneyline pick generation cron via Vercel env flag `PICK_MONEYLINE_ENABLED=false`.
  - User-facing surfaces fall back to "no picks available" until artifact replaced (NOT "market consensus" framing — per CSO/CEng/COO rev1 conditions).
  - Max time-to-detect for regression: 7 days (≈90 graded picks at expected daily volume); CLV-negative trigger before 7 days fires earlier.

scope:
  - markets_affected: [moneyline]
  - user_facing: yes (this is the first picks artifact); pick payload = side + EV + confidence tier only (no rationale paragraph per archived-rationale directive)
  - irreversible: no (rollback above is a config flag flip + symlink revert)

attachments:
  - docs/research/moneyline-v0-2026-04-30.md (rev1 research memo — methodology landscape, candidate approaches, feature list)
  - docs/audits/moneyline-v0-data-coverage-2026-04-30.md (data-coverage audit; September-2022 archive boundary finding stands)

cold_start_promotion_path:
  - This is the v0 cold-start artifact. Per CLAUDE.md, `pick-tester` cannot gate v0 (no current artifact to compare). Bundled report (backtest + calibration + feature-leakage audit + variance-collapse guard) routes directly to CEng for sign-off.
  - Rationale-eval is NOT in the v0 gate stack — per archived-rationale directive, `pick-tester` drops `/rationale-eval` for v0 and reactivates it only when rationale work is unarchived.
  - On CEng approve: artifact promotes to `models/moneyline/current/` and subsequent changes route through the normal `pick-tester` pipeline.
  - On CEng reject: revisit candidate approach B (gradient boosting fallback) or surface a methodology-shift escalation to CSO. NO market-prior-as-product fallback (rev1 conditions preserved).

specialist_routing (for pick-implementer):
  - mlb-data-engineer:
      - execute one-time historical Odds API backfill 2022-09 through 2024, h2h-only filter, both DK and FD per call; cap pull at 100K credits with month-by-month chunking
      - file post-pull credit reconciliation in metrics.json (estimated 45K, actual X credits, balance after)
      - backfill 2022-09 through 2024 regular-season games, lineups, weather via MLB Stats API + Open-Meteo
      - coverage report (target ≥ 98% on train + holdout window)
  - mlb-feature-eng: build the 12-feature snapshot-pinned set; look-ahead canary; train/serve parity test; document serving join — at serve time the anchor feature is de-vigged DK+FD live close, IDENTICAL to training source
  - mlb-model: train logistic regression; export joblib artifact + architecture.md (must document training source = DK+FD via The Odds API, serving source = DK+FD via The Odds API, source-parity confirmed) + metrics.json
  - mlb-calibrator: reliability audit; isotonic wrap if needed; persist calibration set boundary
  - mlb-backtester: holdout backtest; EV threshold sweep at +1/+2/+3%; ROI + CLV + log-loss vs prior; 1000-iteration bootstrap CIs on ROI, CLV, log-loss-vs-prior, ECE per CEng rev2 carry-forward
  - mlb-rationale: ARCHIVED — not routed for v0 per archived-rationale directive (2026-04-30)

bundled_report_requirements (for CEng v0 sign-off):
  - holdout pre-declaration timestamp (in writing before training starts, per CEng rev1 condition_1_holdout)
  - look-ahead audit log including deliberate-leakage canary outcome (canary must FAIL the audit; an audit that catches nothing proves nothing — per CEng rev1)
  - anchor-coefficient point estimate AND 95% CI (per CEng rev1)
  - sum of |residual coefficients| post-scaling (per CEng rev1)
  - picks-per-day distribution at the chosen EV threshold (per CEng rev1)
  - ECE + max calibration deviation + reliability bins (per CEng rev1)
  - ROI/CLV at +1/+2/+3% EV thresholds (per CEng rev1)
  - log-loss-vs-prior delta (per CEng rev1)
  - train/serve parity test output (per CEng rev1)
  - 1000-iteration bootstrap CIs on ROI, CLV, log-loss-vs-prior, ECE (per CEng rev2)
  - sub-300-sample variance-aware ship rule: lower CI bound on ROI AND CLV ≥ −1% (per CEng rev2)
  - Odds API backfill credit reconciliation (per COO rev3-new condition below)

bundled_report_items_dropped_vs_rev2:
  - proxy-residual audit numerics (global + per-cluster home_favorite/road_favorite/primetime/divisional cuts) — no proxy in rev3
  - training-source-vs-serving-source statement — sources are identical, statement collapses to "DK+FD via The Odds API for both" and lives in architecture.md as a one-liner
  - rationale-eval gate output — rationale archived

lens_conditions_carried_from_rev1_and_rev2:
  - CSO decision_1 (logistic primary + LightGBM fallback): preserved. metrics.json must persist log-odds coefficient + residual feature loadings.
  - CSO decision_2 (training window): preserved with rev2's revision. 2021 dropped (Odds API archive boundary). Effective train window 2022-09 → 2024-pre-ASB; September 2022 used as warmup-only, effective training start 2023-04-01 (≈4,000 games).
  - CSO decision_3 (no consensus-as-product on dual-gate failure): preserved.
  - CSO decision_4 from rev2 (train-vs-serve residual as recurring monthly metric): VOIDED by rev3 — sources are identical, no asymmetry to monitor.
  - CEng decision_1 (logistic-first APPROVED with anchor coefficient + residual loading + picks-per-day reporting): preserved.
  - CEng decision_1_holdout (pre-declare 2024 post-ASB holdout in writing before training): preserved. Holdout pre-declaration must include the closing-line source-of-truth: training = serving = DK+FD via The Odds API.
  - CEng decision_2 (drop 2021): preserved; 2021 is independently blocked by Odds API archive limit. Drop is overdetermined.
  - CEng decision_3 (no market-prior-as-product on dual-gate failure): preserved.
  - CEng rev2 strengthened proxy audit (per-cluster cuts): VOIDED — no proxy.
  - CEng rev2 bootstrap CIs + variance-aware sub-300 ship rule: preserved.
  - CEng rev2 post-launch Pinnacle-vs-DK/FD residual metric: VOIDED — no Pinnacle.
  - COO decision_1 (Vercel Fluid Compute, ≤2s cold / ≤200ms warm latency budget, p95 alert, no worker reintroduction): preserved.
  - COO decision_2 from rev1 (Odds API historical-pull cost estimate pre-pull): RESTORED — rev2 voided this on the basis of "$0 cost path"; rev3 re-activates a credit-cost estimate (45K credits target, 100K credit ceiling, post-pull reconciliation in metrics.json) on the new tier.
  - COO decision_3 (no consensus-as-product): preserved.
  - COO cron_health (monthly recalibration cron registered with telemetry, idempotent on retry): preserved.
  - COO rev2 Pinnacle ingestion conditions (source URL + retrieval timestamp + SHA256): VOIDED — no Pinnacle ingestion.
  - COO rev2 fallback dataset version pin: VOIDED — no fallback dataset.

new_lens_review_questions:
  - CSO: rev3 collapses the proxy-mismatch risk class entirely and removes the rationale risk class. The remaining methodology questions are unchanged from rev1 (logistic-first, no consensus-as-product, training window). Anything new to weigh given the simpler data path?
  - CEng: bootstrap CIs and variance-aware sub-300 floor carry forward. The proxy per-cluster audit is dropped. Is the bundled report (rev1 conditions + bootstrap CIs) the complete v0 sign-off package, or is there a residual concern to add now that the data path is simpler?
  - COO: the credit-budget question is back — 45K-credit target on the new $119/5M tier is ≈1% of monthly budget, but the historical pull is one-shot. Confirm the credit ceiling (100K with month-chunking) is the right operational guard, and confirm post-pull reconciliation in metrics.json is sufficient for cost-audit traceability.
```
