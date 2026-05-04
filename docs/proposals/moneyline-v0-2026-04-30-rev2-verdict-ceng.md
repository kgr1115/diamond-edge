```yaml
proposal_id: moneyline-v0-2026-04-30-rev2
verdict: approve-with-conditions
lens: CEng
reasoning: >
  Train-on-Pinnacle / serve-on-DK+FD is a manageable proxy mismatch, not a
  look-ahead bug — the asymmetry is across books at the same time pin, not
  across time. De-vigging normalizes juice; the residual is per-game shading
  that is bounded, measurable, and post-hoc correctable. But the audit as
  proposed is too thin: a single 2026 in-flight median/p95 cut hides the
  failure mode that actually matters — systematic shading on an identifiable
  cluster (home favorites, primetime, public sides). The audit needs a
  per-cluster cut, not just a global one. On sample size, ≈4,500 games with
  projected 200–400 graded picks at +2% EV clears the n ≥ 200 floor on paper
  but lands point-estimate ROI/CLV inside their own confidence bands at the
  bottom of the range. I will not raise the floor to 300 — that turns a sample
  problem into a refusal-to-decide. I want bootstrap CIs reported alongside
  point estimates so the variance is visible in the verdict, not buried.
conditions:
  - rev1_carry: All rev1 conditions preserved as written (logistic-first with anchor coefficient + 95% CI + residual loadings + picks-per-day; LightGBM fallback on demonstrable nonlinearity only; reject market-prior-as-product; pre-declared holdout in writing; deliberate-leakage canary).
  - proxy_audit_strengthened: Pre-flight residual-shade audit must report median ≤ 1% and p95 ≤ 3% globally AND per-cluster on (home_favorite_<-150, road_favorite, primetime_national_TV, divisional). Any cluster with median > 1.5% or p95 > 4% blocks training on Pinnacle and triggers fallback dataset.
  - bootstrap_cis: Bundled report must include 1000-iteration bootstrap CIs on ROI, CLV, log-loss-vs-prior, and ECE. n ≥ 200 floor holds; sub-300 samples ship only if the lower CI bound on ROI and CLV is ≥ −1% (variance-aware floor, not point-estimate floor).
  - post_launch_metric: Pinnacle-vs-DK/FD per-game residual is logged as a recurring serve-time metric with a monthly review trigger if the rolling 30-day median crosses 1.5%.
  - bundled_report_additions: Proxy-residual numerics (global + per-cluster), bootstrap CIs on all four metrics, training-source vs serving-source statement in metrics.json.
escalation_target: n/a
```

## Per-decision summary

1. **Proxy asymmetry.** Manageable mismatch, not a leakage bug; the residual-shade audit is the right protocol but needs per-cluster cuts to catch the failure mode that actually breaks the proxy assumption.
2. **Sample size.** Hold the n ≥ 200 floor; require bootstrap CIs and a variance-aware lower-bound check (lower CI ≥ −1% on ROI and CLV) so sub-300 samples ship only when the variance is bounded, not assumed away.
3. **Operational guard.** Add Pinnacle-vs-DK/FD residual as a live recurring metric so the proxy assumption is monitored, not declared.
