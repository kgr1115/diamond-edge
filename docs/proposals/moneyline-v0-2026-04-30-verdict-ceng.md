```yaml
proposal_id: moneyline-v0-2026-04-30
verdict: approve-with-conditions
lens: CEng
reasoning: >
  Logistic-with-market-log-odds-anchor is the right shape for a cold-start: it
  is structurally market-aware (the prior enters as a feature, not a hope),
  near-natively calibrated on binary outcomes, fast to retrain, and yields a
  clean numerical variance-collapse test (anchor coefficient near 1.0 with
  non-trivial residual loading). The Cold-Start Lane gates (ROI ≥ 0%, CLV ≥ 0%,
  ECE ≤ 0.04, log-loss-vs-prior ≥ 0.002, n ≥ 200) are achievable with this
  approach on the proposed 2024 post-ASB holdout — but achievability is not
  PASS. I sign off on the artifact only when the bundled report lands. On
  training window, 2021's lineup_entries sparsity is a parity-and-leakage hazard
  larger than the marginal sample-size benefit at this n; I am not willing to
  trust a sparse-data audit to catch every NULL-imputation that quietly leaks.
  On fallback product: shipping a market-prior-only product violates the
  empirical bar. By construction it has zero edge over the line — that is not
  "no edge yet, we'll improve," it is "we are charging for the closing line."
  Hold-and-re-research, do not ship the prior as v0.
conditions:
  - decision_1_approach: >
      Logistic-first APPROVED. mlb-model must report (a) fitted anchor
      coefficient with 95% CI, (b) sum of |residual coefficients| post-scaling,
      (c) picks-per-day distribution at the chosen EV threshold — these are the
      variance-collapse evidence. LightGBM fallback is pre-authorized only if
      logistic clears calibration but fails ROI ≥ 0% with a measurable residual
      nonlinearity case; a fallback for "I prefer trees" is rejected.
  - decision_1_holdout: >
      Pre-declare the 2024 post-ASB holdout in writing before training starts.
      mlb-feature-eng must produce a deliberate-leakage canary that fails the
      look-ahead audit; an audit that catches nothing proves nothing.
  - decision_2_window: >
      Train on 2022–2024 (≈7K games). Drop 2021. The lineup_entries sparsity
      risk is asymmetric — sample-size loss is bounded, leakage from
      sparse-NULL handling is not. If mlb-data-engineer's coverage report shows
      2021 lineup_entries ≥ 95% complete on the same join keys used at serve
      time, this condition relaxes to "include 2021"; otherwise drop.
  - decision_3_fallback: >
      Reject "ship market prior as v0 product." If logistic and LightGBM both
      fail the cold-start gates, hold; route a CSO escalation on whether to
      re-scope (props/totals first, defer moneyline) or commission a deeper
      research cycle. A market-prior product is a transparency surface, not a
      picks product, and conflating the two undermines every promotion gate
      that follows.
  - cross_cutting: >
      Bundled CEng v0 report must include: holdout pre-declaration timestamp,
      look-ahead audit log including canary outcome, anchor-coefficient and
      residual-loading numerics, ECE + max calibration deviation + reliability
      bins, ROI/CLV at +1/+2/+3% EV thresholds, log-loss-vs-prior delta, and
      train/serve parity test output. Any missing item = automatic send-back,
      not an "approve-pending."
escalation_target: n/a
```

## Per-decision summary

1. **Approach.** Logistic-first is empirically defensible at this n; the anchor coefficient + residual loading is the cleanest variance-collapse test we can ask for, and gates are achievable but not pre-met.
2. **Training window.** Drop 2021 unless the lineup_entries coverage report comes back ≥ 95% on serve-time join keys; the leakage asymmetry outranks the sample-size benefit.
3. **Fallback product.** Reject. A by-construction-zero-edge product fails the empirical bar this framework enforces; hold-and-re-research and route the scope question to CSO instead.
