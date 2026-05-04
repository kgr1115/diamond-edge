```yaml
proposal_id: stuff-plus-ingestion-2026-05-04
verdict: approve-with-conditions
lens: CEng
reasoning: >
  Reading 2 — strict. The pinned holdout's invalidator #6 says "any feature-spec
  change that lands AFTER training starts (re-train with the new spec,
  re-declare)." It does not carve out zero-coefficient slots, and I will not
  add the carve-out post hoc. The pragmatic reading is sympathetic but it
  rests on three claims I cannot verify cleanly without consuming the holdout:
  (a) that the wRC+ slots are in fact zero-load on this holdout (their
  coefficient is zero on the TRAINING fit; we do not know what they would
  weigh under a refit on a slightly different feature payload), (b) that
  swapping a feature in the same "residual class" preserves the audit's
  intent (residual class is a CSO-level framing, not a contract clause),
  and (c) that no other change rides along with the swap. The contract was
  written precisely to remove this judgment call from the pre-promotion
  moment. The cold-start lane already gave v0 one bypass; the holdout is
  the next line of defense and it gets read literally.
  The CEng-correct path is to NOT consume the pinned holdout on a
  +0-to-2pp expected band against an unverified contract reading. Declare
  a fresh holdout slice from existing-on-disk data (no new backfill needed
  to start), retrain, evaluate. The pinned 2024-post-ASB slice stays
  untouched and remains the next clean slice for a future model-class
  change (e.g., LightGBM) where the expected delta justifies the
  consumption. The verification gate at ±0.20 xFIP is fine as a
  formula-correctness check, but it is not a substitute for fresh holdout
  discipline.
conditions:
  - fresh_holdout_required_before_retrain:
      action: Declare a new holdout slice in writing BEFORE the retrain
        runs. Persist as `models/moneyline/holdout-declaration-stuffplus-2026-05-04.json`
        with the same schema as the pinned declaration. Pinned
        `moneyline-v0-holdout-2026-05-03` declaration STAYS UNTOUCHED —
        do not read its rows, do not compute metrics on it, do not let
        any retrained candidate's weights be selected against it.
      trigger_to_revisit: n/a — this is the binding precondition, not
        a conditional.
      rationale: Reading 2 of invalidator #6. See main reasoning.
  - fresh_holdout_path_recommendation:
      action: Use option B-1 below as the default; B-2 and B-3 are
        fallbacks if B-1 fails its own pre-declaration discipline.
        B-1 (preferred — train-window carve-out). Re-partition the
        existing 2023-04-01 → 2024-07-15 training window into a NEW
        train + holdout split that has not been touched by any prior
        selection. Concretely: hold out 2024-04-01 → 2024-07-15
        (the most recent ~3.5 months of the existing training window,
        ~600-800 finals at expected drop-predicate coverage). Train
        on 2023-04-01 → 2024-03-31. The 2024-post-ASB slice stays
        pinned and unread. This costs ~3.5 months of training data but
        avoids any data backfill. Pre-declare the new split BEFORE
        running the xFIP backfill so the slice cannot be selected on
        feature coverage.
        B-2 (fallback if B-1 fails sample floor). Pull the 2025
        regular-season slice as a fresh post-2024-12-31 holdout. This
        requires the 2025 historical odds backfill the validation
        verdict roadmap-flagged. Schedule and cost route through COO
        if pursued; do not pursue without that approval.
        B-3 (NOT recommended). Sub-slicing the 2024-post-ASB pinned
        holdout into a "we touched the early part, the late part is
        fresh" split is rejected. Once a slice is declared, the whole
        slice is consumed for selection-discipline purposes; carving
        within it is exactly the move invalidator #6 is built to
        block.
      trigger_to_revisit: If B-1 yields <200 graded picks at the +3%
        EV floor (current production threshold), bootstrap variance
        will swamp the signal. In that case route to COO for B-2
        before retrying.
      rationale: B-1 keeps the chain unblocked (no new ingestion
        dependency), preserves the pinned holdout for a higher-leverage
        future call, and uses data already on disk. The cost is a
        smaller train set; that is the right cost to pay to keep the
        contract clean.
  - swap_diff_must_be_swap_only:
      action: scope-gate must verify the implementer's diff touches
        ONLY the slot replacement and the supporting plumbing (xFIP
        formula module, fb column, ingester change, parity fixture
        regen, feature-spec doc update). NO other coefficient
        adjustments, hyperparameter changes, drop-predicate edits,
        anchor-coef constraint changes, or "while we're here" cleanups
        ride along. Any additional change converts this from a
        feature-swap proposal into a multi-change proposal and must
        re-circulate through scope-gate with the additional changes
        called out.
      trigger_to_revisit: n/a — binding gate condition.
      rationale: The whole point of the contract reading is preserving
        a 1:1 mapping between the proposal and the diff. Slop here
        re-opens the same judgment-call the strict reading was meant
        to close.
  - verification_gate_acceptance:
      action: The memo's 5-pitcher xFIP within ±0.20 of MLB Stats API
        sabermetrics endpoint full-season xfip is ACCEPTED as the
        formula-correctness bar. Two tightenings: (i) require ALL 5
        within ±0.20 (no "4 of 5"), and (ii) add one diversity check —
        at least one of the 5 must be a high-FB% pitcher (e.g., a
        flyball-leaning starter such as Wheeler 2024 already on the
        list qualifies; if substituting, ensure FB% > league average
        for at least one). xFIP's HR/FB term is the one most exposed
        to formula bugs; verifying on a flyball pitcher catches
        bugs that a groundballer would mask.
      trigger_to_revisit: If any spot-check misses by >0.40,
        mlb-data-engineer debugs constants/formula before chain
        advances. If 1 of 5 misses by 0.20-0.40, surface the
        diagnostic but allow chain advance only with a written
        rationale from mlb-feature-eng.
      rationale: ±0.20 on a 3.0-5.0 scale is ~5%, comparable to the
        wRC+ pause's ±3 on a 90-110 scale. Tight enough to catch
        formula+constants bugs; loose enough not to fail on legitimate
        rounding/window-edge differences between season-aggregate
        sabermetrics and our computed values.
  - schema_changes_routed_separately:
      action: The migration 0029 (ADD COLUMN fb) and the backfill
        re-run of 07-pitcher-game-log.mjs are pure infra/data work and
        can ship as a kind:infra precursor commit BEFORE the model
        retrain. They do not consume any holdout. Ship them on the
        normal system-improvement pipeline, not the pick-improvement
        pipeline.
      trigger_to_revisit: n/a.
      rationale: Decouples the reversible data plumbing from the
        irreversible-by-audit holdout consumption. If the model
        retrain later turns out to be CSO-deferred, the fb column
        and backfilled rows have other downstream uses and don't
        need to be rolled back.
  - cso_re_confirmation_on_xfip_as_stuff_plus_substitute:
      action: Memo section 8 surfaces the question of whether xFIP
        qualifies as the "Stuff+ direction" CSO greenlit. That is a
        CSO call, not mine. CEng approves the methodology of the
        swap conditional on CSO confirming xFIP is in scope. If CSO
        re-reads the verdict as "literal Stuff+ or escalate," this
        verdict's conditions don't fire — there's no proposal to
        condition on.
      trigger_to_revisit: After CSO verdict on the same proposal_id.
      rationale: CSO owns the substantive scope of the pivot; CEng
        owns the gates on the implementation path.
escalation_target: n/a
```

## Direct answers to the four questions

1. **Reading 1 or Reading 2?** Reading 1 (strict). Invalidator #6 reads literally; zero-coefficient slots are not carved out and I will not add the carve-out at the moment of consumption. The pragmatic reading is reasonable in the abstract but it converts a contract clause into a judgment call exactly when the contract is supposed to bind hardest.

2. **If Reading 1, what's the cleanest fresh-holdout path?** Train-window carve-out (B-1 in the conditions). Hold out 2024-04-01 → 2024-07-15 from the existing training window. No new backfill needed. The pinned 2024-post-ASB slice stays untouched for a higher-leverage future call (e.g., a LightGBM head-to-head). 2025 backfill (B-2) is the fallback only if B-1 doesn't clear the 200-pick floor at +3% EV.

3. **If Reading 2, what conditions apply?** N/A — I'm choosing Reading 1. But the swap-diff-must-be-swap-only condition still applies under either reading: scope-gate must verify the diff is ONLY the slot replacement plus supporting plumbing, no ride-along changes.

4. **Does the verification gate satisfy the formula-correctness bar?** Yes, with two tightenings: require all 5 of 5 (not 4 of 5) within ±0.20, and ensure at least one spot-check is a flyball-leaning starter. xFIP's HR/FB term is the one most exposed to formula or constants bugs and a groundballer-only spot-check set would mask them.

## What this changes for the chain

- The chain does NOT pause on infra. Migration 0029, the parser update, the backfill re-run, the formula module, the verification gate — all proceed as a kind:infra precursor and don't touch any holdout.
- The chain DOES pause on the retrain until the fresh-holdout declaration is written. mlb-feature-eng + mlb-model wait for `models/moneyline/holdout-declaration-stuffplus-2026-05-04.json` before they touch the train/holdout split.
- The pinned `moneyline-v0-holdout-2026-05-03` declaration is preserved unread for a future call where the expected delta justifies the consumption.
- If CSO defers the xFIP-as-Stuff-plus-substitute question, this verdict's conditions don't fire and we re-route per CSO's call.

## Audit trail

- This verdict: `docs/proposals/stuff-plus-ingestion-2026-05-04-verdict-ceng.md`
- Research memo: `docs/research/stuff-plus-ingestion-2026-05-04.md`
- Pinned holdout: `models/moneyline/holdout-declaration.json` (declaration_id `moneyline-v0-holdout-2026-05-03`)
- Prior CEng verdict context: `docs/proposals/moneyline-v0-validation-2026-05-04-verdict-ceng.md`
- New holdout declaration to be written before retrain: `models/moneyline/holdout-declaration-stuffplus-2026-05-04.json` (does not yet exist; condition `fresh_holdout_required_before_retrain` blocks the retrain until it does)
