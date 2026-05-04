```yaml
proposal_id: moneyline-v0-2026-04-30-rev2
verdict: approve-with-conditions
lens: CSO
reasoning: >
  The data envelope changed; the methodology posture did not. Pinnacle-as-proxy
  is a defensible v0 source because the anchor feature is de-vigged log-odds —
  book juice is normalized away by construction, and the residual shading risk
  is bounded, measurable via the pre-flight audit, and reversible via the
  Kaggle/GitHub fallback. It does not compromise the "statistically-grounded
  picks" positioning so long as architecture.md is explicit that Pinnacle is
  the training proxy and DK/FD is the production anchor, and the ROI/CLV
  numbers are graded against DK/FD close. The reduced sample (≈4,000 games
  after the September-2022 warmup drop) keeps n ≥ 200 graded picks at +2% EV in
  the projection band, which is the v0 promotion floor — tighter variance is a
  cost, not a blocker. Pushing v0 out to accumulate more live ingestion would
  delay the cold-start lane by a full season for marginal sample gain; that
  trade favors shipping. Rev1 conditions carry forward; the consensus-as-
  product reject is reaffirmed and now has more force, since shipping a
  Pinnacle-proxy passthrough would be even further from the brand promise.
conditions:
  - decision_1_proxy_source: Pinnacle proxy primary is approved. architecture.md must state in plain language that training source = Pinnacle de-vigged close, serving + CLV grading source = DK/FD live close, and must include the pre-flight residual-audit numerics inline. The audit (median ≤ 1%, p95 ≤ 3%) is a hard pre-training gate — fail routes to the GitHub/Kaggle DK+FD fallback before any model is trained, no exceptions.
  - decision_2_sample_window: ≈4,000-game window approved (2023-04-01 effective start with Sep-2022 as warmup-only). If actual graded picks at +2% EV land below n=200 on the holdout, tighten the EV threshold to +3% per the proposal's mitigation; do NOT lower the sample-size floor. v0 promotion does not relax to fit a thinner holdout.
  - decision_3_carry_forward: Rev1 conditions carried forward unchanged. Logistic primary + LightGBM fallback; no consensus-as-product (now extended explicitly to "no Pinnacle-proxy passthrough as product" — the proxy is a training crutch, not a user-facing surface); on dual gate failure, escalate with options, do not relabel.
  - decision_4_recurring_metric: Train-vs-serve source asymmetry (DK/FD-vs-Pinnacle residual) becomes a recurring monthly metric on the calibration cron, not a one-time audit. Drift here is the leading indicator of proxy decay and is a roadmap item I will revisit if it widens.
escalation_target: n/a
```

## Per-decision calls

1. **Pinnacle proxy primary.** Approved — de-vigging absorbs the structural juice gap and the pre-flight audit bounds the residual shade risk; positioning holds as long as architecture.md is honest about the train-vs-serve source split.
2. **Reduced ≈4,000-game sample.** Approved — n ≥ 200 graded picks at +2% EV is preserved in the projection, and delaying v0 a full season for marginal sample is a worse roadmap trade than shipping with tighter variance bands.
3. **Carry-forward.** Confirmed — logistic + LightGBM fallback, no consensus-as-product (now also no Pinnacle-proxy passthrough), dual-gate-fail escalates to user with options.
