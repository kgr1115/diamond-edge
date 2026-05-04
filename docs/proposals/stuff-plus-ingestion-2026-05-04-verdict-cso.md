```yaml
proposal_id: stuff-plus-ingestion-2026-05-04
verdict: approve-with-conditions
lens: CSO
decision:
  q1: (a) — xFIP satisfies the Stuff+ direction
  q2: (b) — ship xFIP as infra; defer holdout-consuming retrain
reasoning: >
  Q1 is straightforward. The strategic intent of the prior pivot was activating
  pitcher-quality residual signal beyond what raw FIP captures, not the
  trademark of any specific metric. xFIP is in-class (process-quality decoupled
  from outcome luck), free, FG-parity verifiable, and computable from data we
  already store. True Stuff+ via per-pitch movement is a multi-week engineering
  project and was explicitly carved out of the one-holdout-consumption cap; it
  remains a future research lane. Q2 is the load-bearing call. The honest
  expected band is +0 to +2 pp ROI@+2% with mass at the lower end, and the
  pinned holdout is the only artifact that distinguishes signal from variance
  on the next CEng v0 decision. Personal-tool / portfolio phase has no clock
  pressure; live picks accumulate at 3-8/night and the 200-pick re-check is
  the binding evidence for v0. Burning the holdout on a low-mass-at-ceiling
  candidate when (i) the ingester delivers the column for $0 either way, (ii)
  the 2025 backfill is roadmap-flagged as the natural fresh-holdout source,
  and (iii) live evidence may sharpen the priors before retrain — that's
  asymmetric downside. Ship the plumbing now; spend the holdout on a
  higher-confidence candidate later.
conditions:
  - Ship xFIP ingester + serving + training-side feature module as PURE
    INFRASTRUCTURE. Migration 0029 lands; backfill runs; verification gate
    runs (5 pitchers, ±0.20 xFIP units vs sabermetrics endpoint). Train/serve
    parity fixture regenerated. Look-ahead audit re-run. NO retrain against
    `models/moneyline/holdout-declaration.json` on this work.
  - Production v0 in `models/moneyline/current/` stays unchanged. Feature
    payload to the SERVED model unchanged for now — `team_wrcplus_l30_*`
    slots remain (still zeroed) until the retrain actually happens. The new
    `starter_xfip_l30_*` lives in the feature module and the training-side
    parquet builder, ready for consumption, but is NOT wired into the live
    serving payload until the retrain ships.
  - The one-holdout-consumption hard cap is PRESERVED, not spent. It carries
    forward to whichever candidate retrain we authorize next.
  - Retrain trigger is one of: (a) 2025 backfill lands and a fresh holdout
    slice is pre-declared, or (b) live-pick evidence at the 200-pick re-check
    surfaces pitcher-quality residual as the binding constraint and CSO +
    CEng agree the xFIP candidate has higher prior than alternatives, or
    (c) live pace falls below 3 picks/night for 2 weeks per the validation
    verdict's fallback authorization, in which case 2025 backfill triggers
    and the xFIP retrain rides on the fresh holdout.
  - The CEng holdout-contract reading question (section 4 of the memo:
    Reading 1 vs Reading 2 on invalidator #6) is DEFERRED, not answered. We
    don't need to litigate "is replacement structurally a swap" until we're
    actually consuming the holdout. When the retrain trigger fires, that
    question routes to CEng as the first gate.
  - Per-pitch movement / true Stuff+ via neural-net stays on the future
    research lane list. If the xFIP retrain (when it happens) shows
    pitcher-quality residual is still the binding gap, a dedicated
    multi-week pitch-by-pitch ingestion proposal is the next escalation
    path, not a third feature pivot on the same holdout.
escalation_target: n/a
```

## Plain-English summary

**Q1 answer: (a)** — xFIP is the right substitute. Same destination (pitcher-quality residual beyond raw FIP), different vehicle. The naming change is honest; the methodology direction is preserved. Don't escalate on the literal-Stuff+-or-bust reading.

**Q2 answer: (b)** — ship as infra, defer the retrain. The +0 to +2 pp band with mass at the floor doesn't justify burning the only pinned holdout we have, especially when the ingester costs $0 either way and the 2025 backfill is the natural source for a fresh holdout. We get the column populated, the parity fixture regenerated, the verification gate proven — all the work that's hard to redo later — and we keep the holdout as a sharper instrument for whichever candidate has the strongest prior when we next retrain.

## Routing implication

Your conditional outcome of "(1a) AND (2a) → CEng consult on holdout-contract → pick-implementer" does NOT fire. Instead:

- Chain proceeds to scope-gate with the proposal RESHAPED as `kind: infra` (ingester + serving + training module, no retrain). The contract-interpretation question is not on the table this cycle.
- COO consult on rate envelope (~6-8h backfill at 2 req/sec on existing 07-script — should be a clean approve given prior FIP backfill set the precedent).
- CEng consult on the verification gate threshold (±0.20 xFIP units) and look-ahead audit completeness — NOT on holdout-contract reading.
- pick-implementer triggers `mlb-data-engineer` (migration 0029, parser update, constants module, backfill) → `mlb-feature-eng` (verification gate, serving + training mirror, parity fixture, look-ahead re-run) → STOP. No `mlb-model` retrain. No `pick-tester` consumption of the holdout.
- Future trigger conditions for the actual retrain are listed in the conditions block above.
