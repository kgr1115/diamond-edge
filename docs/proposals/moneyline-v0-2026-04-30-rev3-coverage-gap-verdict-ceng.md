```yaml
proposal_id: moneyline-v0-2026-04-30-rev3-coverage-gap
verdict: approve-with-conditions
lens: CEng
reasoning: >
  Option A. The anchor feature is the de-vigged DK+FD closing log-odds — it
  carries most of the signal in a logistic with a market prior. Imputing 16.5%
  of anchor values with a season-median or sister-book substitute pollutes the
  one feature whose integrity matters most, blurs the variance-collapse guard
  (imputed values cluster near the prior, which is exactly what the guard
  watches for), and breaks train/serve parity (serving never imputes — if the
  close is missing at T-60min the game does not get a pick). A smaller all-real
  training set is the honest sample. Cold-start gates are absolute, not
  sample-size-discounted; ≈5,000 effective rows still clears n ≥ 200 graded
  picks at +2% EV with room. Bootstrap CIs handle the variance bookkeeping.
conditions:
  - holdout_same_rule: 2024 post-ASB holdout drops rows where DK AND FD close are missing. Train/serve/grade rule is identical: no real close at T-60min = no row, no pick, no graded outcome. mlb-feature-eng documents this as a single explicit predicate.
  - serve_time_parity: Live serving must refuse to emit a pick when the anchor is missing — same predicate as training. No silent fallback to a synthesized anchor.
  - architecture_md_note: Coverage gap (83.5% on 2022-09 → 2024 backfill, ≈6,034 games with real closes / ≈1,200 dropped) recorded in `models/moneyline/current/architecture.md` under a "Data coverage" section, with the drop predicate stated verbatim. Bundled report carries the post-drop train n and holdout n.
  - bootstrap_unchanged: 1000-iter bootstrap CIs and the sub-300 lower-CI ≥ −1% rule apply to the post-drop sample. No relaxation.
escalation_target: n/a
```

## Per-question summary

1. **Option A.** Anchor integrity > sample size. Imputation pollutes the one feature that carries the prior and noise-floors the variance-collapse guard.
2. **Holdout: same rule.** Drop rows where both DK and FD closes are missing. Train, holdout, and serve all use one predicate. No asymmetry.
3. **architecture.md: yes.** Documented regardless of option. The gap is a property of the data path, not of the modeling choice — future me, future Kyle, and any retrain need to see it.
