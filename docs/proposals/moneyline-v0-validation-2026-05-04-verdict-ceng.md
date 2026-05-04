```yaml
proposal_id: moneyline-v0-validation-2026-05-04
verdict: approve-with-conditions
lens: CEng
reasoning: >
  The validation is honest and the headline reading is right: v0 is not broken,
  but the in-sample CI on the original holdout was narrower than the data
  earned. Block bootstrap at 5d and 7d flips the post-ASB lower-CI sign
  (+0.84% iid -> -2.42% 7d), and the pre-ASB walk-forward refit fails the
  declaration's "lower CI bound >= -1%" floor on both iid (-3.98%) and block
  (-3.47%). Point estimates are positive on both slices (+11.33% post-ASB,
  +4.82% pre-ASB), so the model still pulls weight on average, but the
  variance picture is wider than rev3 bundled. None of this retroactively
  un-signs-off v0 -- cold-start was framed as point-positive ROI under the
  pre-declared discipline, which still holds -- but it tightens the confidence
  budget that the live re-check was already meant to backstop.
  The v0-loses-to-anchor-only-by-2pp on pre-ASB is slice variance, not a
  residual-stack-is-marginal verdict: the CIs overlap heavily (v0 +4.82%
  vs anchor-only +6.79%, both with ~9-12pp half-widths), favwinpct adds
  nothing on either slice, and v0_current applied to pre-ASB returns +6.81%
  ROI -- effectively tying anchor-only on the slice when fit on the full
  window. The walk-forward refit's worse pre-ASB result reads as a
  training-size artefact (2,416 vs 3,282 rows), not evidence the residual
  stack is dead. Anchor-only beats v0 on one slice by 2pp; v0 beats
  anchor-only on the other by 5pp. The strict "both slices by >= 1pp"
  fallback trigger does not fire, and a liberal reading is unjustified
  given the variance.
  Cross-window diagnostic adds the load-bearing finding: v0_current at +3%
  EV on pre-ASB-2024 returns +10.62% ROI with 7d-block CI (+2.22%, +19.78%)
  -- positive block-bootstrap lower bound on a slice the production model
  never trained on. That is stronger evidence than anything in the original
  rev3 bundle. It points to lifting the EV floor, not pulling it back.
  Net: keep v0 in production, do not trigger the LightGBM fallback, do not
  pull picks back to shadow-only, but tighten three things -- raise EV floor
  to +3%, formalize block bootstrap as a permanent reporting requirement,
  and accelerate the 231-game October-2024 re-pull because it directly
  attacks the train-size artefact this validation surfaced.
conditions:
  - lift_ev_floor_to_plus_3pct:
      action: Move the live serving EV threshold from +2.0% to +3.0% before
        any new picks publish. Implement in apps/web/lib/picks/ (the EV
        threshold constant or env var that gates pick publication) and
        update models/moneyline/current/architecture.md to record the new
        live serving threshold (the trained model itself is unchanged).
      trigger_to_revisit: After 200-400 graded live picks at +3% EV, re-run
        /calibration-check + /backtest on the live slate. If live ROI is
        negative AND live ECE breaches 0.04, escalate to a kind:model-change
        discussion. If live ROI is positive at +3% with live ECE <= 0.04,
        consider lowering back to +2% as a separate proposal with the live
        slate as evidence.
      rationale: The validation table shows v0_current on pre-ASB-2024 at
        +3% EV has 7d-block CI lower bound +2.22% (positive) -- the only
        cell-table slice/threshold combination with a positive block-CI
        lower bound on out-of-sample data. +2% had the lower bound that
        block bootstrap flipped. Lifting to +3% trades pick volume (~339
        post-ASB vs 416 at +2%, ~450 pre-ASB vs 569) for a CI shape that
        survives honest variance accounting. The live re-check then gates
        whether +3% holds.
  - block_bootstrap_permanent_in_backtest_finalize:
      action: Add 7-day block bootstrap as a REQUIRED reporting field in
        scripts/model/backtest-finalize-moneyline-v0.py and any future
        per-market backtest-finalize script. Report iid + 5d + 7d + 10d
        block CIs side-by-side in metrics.json under a roi_ci_block_bootstrap
        key. The --block-size flag added in this validation cycle stays;
        what changes is that the default reporting includes block CIs, not
        just iid.
      trigger_to_revisit: None -- this is a permanent reporting tightening,
        not a conditional. Future kind:model-change proposals that omit
        block CIs from their evidence get sent back at scope-gate.
      rationale: i.i.d. bootstrap under-counts variance on slate-correlated
        outcomes. The cell-table evidence shows the difference is material
        (sign flip at 5d/7d on the post-ASB +2% cell). Reporting both keeps
        future promotion decisions honest about what the data does and does
        not earn.
  - prioritize_october_2024_repull:
      action: Re-pull the 231 stalled 2024-09-30+ games NOW (before next
        retrain cycle), not at next-cycle retrain as the rev3 verdict
        originally framed. This is a mlb-data-engineer task; output is a
        kind:data-backfill brief routed through the normal gate.
      trigger_to_revisit: When the 231 games land, mlb-feature-eng rebuilds
        train.parquet, mlb-model retrains v0 on the refreshed train (~3,500
        rows clearing the original floor), mlb-backtester re-runs the
        4x2 cell table with block bootstrap on both holdouts. If pre-ASB
        v0_walkforward CI lower bound clears -1% with the larger train, the
        train-size-artefact reading is confirmed and the rev3 train-floor
        waiver is consumed cleanly. If it does not clear, the residual stack
        is genuinely marginal and a kind:model-change discussion (LightGBM
        or richer baseline) is on the table.
      rationale: The cross-window diagnostic shows v0_current (full window,
        n=3,282) generalizes to pre-ASB-2024 better than v0_walkforward
        (n=2,416) does on the same picks (+6.81% vs +4.82%). Larger train
        helps. The 231 games are the cheapest path to validating that
        reading, and they were already a pinned follow-up.
  - live_ece_recheck_unchanged:
      action: The rev3 condition `live_ece_recheck_at_200_picks` stands
        unchanged. Block bootstrap evidence does NOT move the trigger
        threshold to a more conservative number -- the right response to
        thin in-sample CIs is the live data itself, not finer-grained
        in-sample arithmetic. 200-400 graded live picks at the new +3% EV
        floor remains the binding evidence.
      trigger_to_revisit: At 200 graded live picks, run /calibration-check;
        at 400 if 200 is borderline. Same isotonic-fallback infrastructure.
  - lightgbm_fallback_NOT_triggered:
      action: Do NOT trigger the approach_b_fallback LightGBM run. The
        pre-declaration's escalation clause requires "v0 ROI negative on
        either slice OR v0 loses to anchor-only on BOTH slices by >= 1pp."
        Neither condition fires (point ROI is positive on both slices;
        anchor-only loses by 5.31pp on post-ASB and wins by 1.97pp on
        pre-ASB -- one slice, not both). Strict reading is correct here;
        the pre-declaration was written to avoid exactly this kind of
        license-creep.
      trigger_to_revisit: If the October re-pull retrain returns v0 ROI
        below 0 on either slice OR loses to anchor-only on BOTH slices
        by >= 1pp at the refreshed train n, LightGBM fallback fires
        automatically per the original pre-declaration. Until then it
        stays parked.
      rationale: A liberal "trigger anyway, just for comparison" reading
        would consume the cold-start lane's single bypass for nothing --
        LightGBM as a head-to-head against v0 needs its own pre-declared
        holdout regardless. If the user wants a LightGBM comparison run
        on principle (not as a fallback trigger), it routes through a fresh
        kind:model-change proposal with its own pre-declaration; that is
        a separate decision.
  - no_visibility_shadow_pullback:
      action: Do NOT move live picks to visibility='shadow'. Picks continue
        to publish at the new +3% EV floor as live picks. The variance
        picture is wider than rev3 bundled, but the point estimate is
        positive on every cell-table cell that has picks, and the +3%
        block-CI lower bound on the cross-window pre-ASB diagnostic is
        positive. Shadow-only is the response to a model we suspect is
        broken; the data does not support that read.
      trigger_to_revisit: If live ROI at +3% goes negative across the first
        100+ graded picks, pull to shadow as an emergency measure pending
        the calibration re-check. If live ROI is positive or noisy-positive,
        leave live.
escalation_target: n/a
```

## What I'm explicitly approving

The validation report's MIXED finding is correct and the v0 artifact at
`models/moneyline/current/` continues to ship -- with the live serving EV
threshold raised from +2% to +3% before any further pick publishes. The
rev3 conditions stand; this verdict adds three.

## What I'm explicitly NOT approving

- Triggering the LightGBM fallback. The pre-declaration's strict trigger
  did not fire. A "while we're here" run consumes the cold-start lane for
  nothing.
- Pulling picks to shadow-only. The data does not show a broken model;
  it shows a wider CI than the i.i.d. bootstrap reported.
- Moving the live ECE re-check to a more conservative pick threshold than
  200-400. In-sample arithmetic does not substitute for live evidence; the
  right response to thin in-sample CIs is the live cron data, on schedule.
- Re-running anything that touches the validation holdouts for selection.
  The pre-declaration's `what_changes_invalidate_this_declaration` clause
  is in force; the next slice that gets touched gets a fresh declaration.

## What pick-implementer / pick-publisher should do next

1. **Implement the EV floor lift** (+2% to +3%) in `apps/web/lib/picks/`
   wherever the threshold gate lives, plus the architecture.md note. Routes
   through `pick-implementer` -> `pick-tester` -> `pick-publisher` as a
   normal pipeline pass; this is a kind:model-change at the serving layer
   (no artifact change), pre-declared here.
2. **Add block bootstrap to backtest-finalize as a default** in
   `scripts/model/backtest-finalize-moneyline-v0.py`. Update metrics.json
   schema to include `roi_ci_block_bootstrap` as a required field.
3. **Open a data-backfill brief** for the 231 stalled October-2024 games
   immediately, routed to `mlb-data-engineer`. When the games land, kick
   off the refreshed-train retrain + cell-table re-run as documented in
   the condition.
4. **Track the live ECE re-check** in the orchestrator's pinned-follow-up
   memory at the 200-pick mark. Same condition as rev3.

## Audit trail

- Validation pre-declaration: `models/moneyline/validation-holdout-declaration-pre-asb-2024.json`
- Validation cell table: `models/moneyline/validation-pre-asb-2024/validation-cell-table.json`
- Validation report: `docs/audits/moneyline-v0-validation-2026-05-04.{md,json}`
- Research memo: `docs/research/moneyline-v0-validation-path-2026-05-04.md`
- Prior v0 sign-off: `docs/proposals/moneyline-v0-2026-04-30-rev3-bundled-report-verdict-ceng.md`
- This verdict: `docs/proposals/moneyline-v0-validation-2026-05-04-verdict-ceng.md`
