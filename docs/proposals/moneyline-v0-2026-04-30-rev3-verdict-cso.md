```yaml
proposal_id: moneyline-v0-2026-04-30-rev3
verdict: approve-with-conditions
lens: CSO
reasoning: >
  Rev3 is the cleanest of the three revisions. DK+FD direct via the Odds API
  collapses train source = serve source = CLV-grading source, which voids the
  entire proxy-mismatch risk class and the rev2 monthly residual metric I
  added. That is a pure simplification — fewer moving parts, the same v0
  promotion bar, and ≈1% of the new tier's monthly credit budget. On the
  rationale archive: it does temporarily soften the "AI-explained" half of the
  v1 positioning, but Kyle's explicit framing is personal tool + portfolio
  during this phase, not aggressive paid-SaaS. "Statistically-grounded" with a
  calibrated probability and a tier label is a complete product surface for
  that mode. The "AI-explained" promise stays in CLAUDE.md as the long-run
  surface and reactivates the moment Kyle reopens paid-SaaS. Not a positioning
  violation; a deliberate phasing. Carry-forward conditions hold; the train-
  vs-serve residual metric is correctly voided.
conditions:
  - decision_1_data_path: DK+FD direct approved. architecture.md states "training source = serving source = CLV-grading source = DK+FD via The Odds API" as a one-liner; rev2 train-vs-serve residual monthly metric is voided.
  - decision_2_rationale_archive: Approved for the personal-tool/portfolio phase. When Kyle reopens paid-SaaS mode, un-archiving rationale and reactivating /rationale-eval is a precondition for the first paid-tier launch — log this as a roadmap item, not a v0 blocker.
  - decision_3_carry_forward: Rev1 conditions preserved unchanged — logistic primary + LightGBM fallback, 2022-Sep through 2024 sample with Sep-2022 warmup-only, no consensus-as-product on dual-gate failure (escalate to user with options). CEng's bootstrap CIs + sub-300 variance-aware ship rule confirmed in scope.
escalation_target: n/a
```

## Per-decision calls

1. **DK+FD direct.** Confirmed — eliminates the rev2 asymmetry by construction; pure win on methodology cleanliness, no positioning cost.
2. **Rationale archive.** Approved for this phase — "statistically-grounded" alone is a coherent surface for personal-tool + portfolio framing; un-archive is a roadmap precondition for paid-SaaS reopen, not a v0 issue.
3. **Carry-forward.** Confirmed — logistic + LightGBM fallback, 2022-Sep–2024 with warmup, no consensus-as-product, bootstrap CIs + sub-300 rule preserved; train-vs-serve residual metric voided.
