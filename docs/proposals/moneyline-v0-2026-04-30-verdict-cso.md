```yaml
proposal_id: moneyline-v0-2026-04-30
verdict: approve-with-conditions
lens: CSO
reasoning: >
  Logistic-with-market-anchor is the right methodological posture for v0. It
  honors the locked Methodology Stance (market-prior awareness is structural,
  not bolted on), keeps the iteration loop fast so the cold-start lane closes
  in days not weeks, and gives a clean diagnostic — the log-odds coefficient
  near 1.0 — for the variance-collapse guard. LightGBM as a documented fallback
  preserves agnosticism without front-loading complexity. On training window,
  2022–2024 (≈7K games) is the right call for product direction: lineup
  sparsity in 2021 risks training/serving parity drift on a feature class we
  rely on, and the marginal ≈2.7K games from 2021 will not change v0 promotion
  outcomes at the n≥200 floor — but it can taint calibration. Let mlb-data-eng
  run the coverage report; if 2021 lineups come back clean, include them, but
  the default is 2022–2024. On the fallback product question: shipping a
  market-prior-only "consensus" surface as Diamond Edge picks fails the v1
  positioning of "statistically-grounded, AI-explained picks" and damages the
  roadmap by setting a precedent that we monetize repackaged closing lines. If
  both logistic and LightGBM fail v0 gates, the answer is hold-and-re-research
  (escalate to the user), not relabel-and-ship.
conditions:
  - decision_1_approach: Logistic primary with LightGBM fallback ships as proposed; mlb-model must persist the log-odds coefficient and residual-feature loadings in metrics.json so the variance-collapse diagnostic is auditable, and architecture.md must justify the choice empirically against the LightGBM fallback if logistic clears gates first.
  - decision_2_window: Default to 2022–2024 (≈7K games). mlb-data-engineer's 2021 coverage report is a precondition; include 2021 only if lineup_entries coverage ≥ 95% across both halves of the season. Document the choice in architecture.md.
  - decision_3_fallback: No "consensus product" ship. If both logistic and LightGBM fail v0 gates, escalate to the user with options (extend feature set, defer moneyline v0, switch first market) — do not relabel the market prior as a Diamond Edge pick. Roadmap-level: a transparent "market consensus" view can exist later as a free explanatory surface alongside picks, but it is not the picks product.
escalation_target: n/a
```

## Per-decision calls

1. **Approach.** Logistic-first is correct — it is the cheapest test of "does residual signal exist beyond the line?" and the LightGBM fallback keeps us methodology-agnostic without adding cold-start complexity.
2. **Training window.** Default 2022–2024; promote 2021 to inclusion only if mlb-data-engineer's coverage report confirms lineup parity, because calibration-set integrity matters more than the marginal sample.
3. **Fallback product.** Reject the consensus-as-product framing — it conflicts with v1 positioning; on dual gate failure, escalate to the user with concrete next-step options.
