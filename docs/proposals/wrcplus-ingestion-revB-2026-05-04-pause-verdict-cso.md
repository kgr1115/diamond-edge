```yaml
proposal_id: wrcplus-ingestion-revB-2026-05-04-pause
verdict: approve-with-conditions
lens: CSO
decision: Option C (pivot to Stuff+ via Savant pitch-arsenal-stats)
reasoning: >
  Three filters point the same direction. Strategically, the highest residual
  in v0 is pitcher quality, not batter quality — Stuff+ targets the bigger
  lever wRC+ was always a second-order patch on. Methodologically, A asks me
  to override CEng's gate to ship a feature whose own implementer says will
  not pull weight, and B ships a stale FG-parity number whose L30 rolling
  variant collapses to a near-constant carry of last year's value (low
  loading, same comparison-against-current bar still has to be cleared).
  Pipeline-discipline-wise, both A and B consume the pinned holdout
  (`moneyline-v0-holdout-2026-05-03`) on a low-confidence candidate; C
  consumes it on a higher-EV one. The orchestrator brief pre-authorized
  exactly this pivot for exactly this failure mode — invoking it before
  building-and-failing the residual is the cheaper path to the same place.
  Personal-tool / portfolio phase has no clock pressure that would justify
  trading holdout quality for an extra week of speed. wRC+ work is shelved,
  not killed — re-openable as a future research proposal if Stuff+ lands and
  pitcher residuals compress enough that batter-quality becomes the next
  binding constraint.
conditions:
  - Restart the pipeline at Stage 1 (`pick-research`) with `mlb-research`
    spec'ing Stuff+ source/formula/coverage. Do NOT carry over rev A/B
    research artifacts — Stuff+ is a different metric class with different
    leakage surface (per-pitch run-value rollups, arsenal mix weighting,
    sample-size floors per pitcher-pitch type).
  - Auto-fire CEng + COO on the resulting research proposal in parallel per
    the auto-chain rule. Cross-lens sign-off required before
    `pick-implementer` runs (this is a feature-class addition, not a
    same-class swap).
  - Hard-cap the Stuff+ implementation at one pinned-holdout consumption.
    If Stuff+ also fails the residual loading bar (|coef| < 0.02 or
    ROI/CLV/ECE deltas insufficient for v0 sign-off path), do NOT attempt a
    third feature pivot on the same holdout — declare a new holdout slice
    and escalate to the user with the candidate-2 retrain numbers in hand.
  - Preserve the wRC+ work product. The `wrcplus-ingestion-revB-2026-05-04-implementer-pause.md`
    receipts (constants table, sabermetrics endpoint probe, formula variants,
    park-factor source diagnosis) are the basis of any future re-open. Do
    not delete; reference from the Stuff+ proposal's "alternatives
    considered" section.
  - Production v0 stays live unchanged through tonight's 22:00 UTC cron
    and beyond. The 200-pick live ECE re-check remains the binding evidence
    for the next CEng v0 decision regardless of what Stuff+ produces.
flag_for_next_research_cycle:
  - The park-factor source mismatch surfaced here (FG uses Statcast-regressed
    multi-year per-team factors; we use `park_factor_runs.runs_factor` from
    FG/B-Ref aggregates) is a latent feature-fidelity issue beyond wRC+.
    Any future feature that bakes in park-adjusted run expectancies will hit
    the same wall. Worth a research note on whether to source FG's actual
    park-factor table or accept a documented bias on park-adjusted features.
  - The MLB Stats API sabermetrics endpoint ignoring intra-season
    startDate/endDate is a structural constraint on any future "pull FG-parity
    season-aggregate metric" path. Document it once in the research index so
    it is not re-discovered on a future ingester.
escalation_target: n/a
```
