```yaml
proposal_id: moneyline-v0-validation-2026-05-04
verdict: approve-with-conditions
lens: CSO
reasoning: >
  The MIXED result does NOT change the rev3 sign-off framing. Personal-tool /
  portfolio phase explicitly tolerates a thin, slice-variable edge so long as
  holdout discipline holds and the model is calibrated — both did. The honest
  read of the headline cells is reading 2: v0 is mostly a calibrated
  repackaging of the market anchor, with a residual stack that contributes a
  real-but-thin uplift one slice rewards and another doesn't (anchor coef
  identical at 0.977 / 0.979; residual shape stable; no sign flips). The
  product positioning at this phase is "calibrated, transparent, comparison-
  honest picks," not "we beat the market by 11pp" — that survives the result.
  What I am NOT willing to do is pivot methodology direction off two slices
  with overlapping wide CIs and an i.i.d-vs-block-bootstrap disagreement on
  the same data. Direction stays: keep v0 in production for evidence
  accumulation; let the live-slate 200-pick re-check be the binding signal,
  not in-sample debate. The block-bootstrap sign flip raises the importance
  of that re-check but does not invalidate v0's promotion. Research direction
  next: prioritize (a) wRC+ ingestion as the single highest-information
  feature gap (2 of 11 residuals zeroed = the residual stack we are
  evaluating is structurally incomplete; the pre-ASB miss may partly reflect
  that). Defer (b) richer pitcher/team residuals until wRC+ lands — adding
  more residuals on top of a known-incomplete stack confounds the diagnosis.
  Defer (c) LightGBM fallback until live evidence either confirms thin-edge
  reading or contradicts it; switching model class on in-sample slice noise
  is the exact methodology drift the locked stance forbids.
conditions:
  - direction_unchanged: rev3 framing holds (personal-tool/portfolio phase, no aggressive paid-SaaS positioning that depends on a fat edge). Update product copy to lean on "calibrated + transparent + comparison-honest" rather than any specific ROI number until 200-pick live evidence lands.
  - methodology_direction: keep v0 in production. Do NOT pivot to LightGBM fallback or re-tune EV threshold on in-sample slice variance. Treat v0 as "calibrated market repackaging with a thin residual edge" until live evidence says otherwise.
  - research_priority_next: wRC+ ingestion is the next research unit. Frame as `kind: feature-change` proposal with its own coverage audit + holdout pre-declaration; do NOT bundle it with a model-class change. CEng's prior follow-up on this stands and is now the highest-priority research item.
  - defer_richer_residuals: defer (b) starter-FIP-diff / bullpen-quality-diff / lineup-handedness residuals until wRC+ lands and we can re-validate the residual stack with a complete feature set. Adding residuals on a structurally incomplete stack confounds the marginal-residual question.
  - defer_lightgbm: defer (c) LightGBM fallback evaluation until 200-pick live re-check produces a verdict. If live evidence confirms thin-edge reading and a richer linear stack still doesn't pull weight, LightGBM becomes the natural next test. Triggering it now is methodology-direction drift on slice noise.
  - live_evidence_pace: the ~3-8 picks/night rate (200-pick threshold ~30-60 days out) is acceptable for the personal-tool phase. Do NOT accelerate via paper-trade backfill on the existing window — that re-uses already-touched data and gives no new signal. The 2025 historical backfill (research memo option H, ~5-10K credits, well within the upgraded $119/5M tier) is a legitimate accelerator IF the live pace falls below 3 picks/night for 2 consecutive weeks. Route as a separate proposal at that point; not authorized pre-emptively.
  - block_bootstrap_reporting: adopt 7-day-block bootstrap as the default reporting CI going forward (not just i.i.d.). The sign-flip evidence shows i.i.d. was over-confident on slate-correlated outcomes. This is a reporting-honesty change, not a methodology change. CEng owns the implementation call; CSO direction is "report the more honest CI from now on, and update the v0 sign-off documentation to cite block-bootstrap CI alongside i.i.d."
  - roadmap_flag: log "thin-edge reading" as the working hypothesis in project state. If 200-pick live re-check confirms it (live ROI in the +3 to +6% range rather than the +11% post-ASB headline), product positioning and pricing strategy for the eventual paid-SaaS reopen need to plan around that, not around the headline number.
escalation_target: n/a
```

## Direction implications (one paragraph)

The result moves the working hypothesis from "v0 has a meaningful residual edge" to "v0 is calibrated market repackaging with a thin residual uplift of uncertain magnitude." That is a smaller claim, but it is still a complete product surface for the personal-tool / portfolio phase — a calibrated probability + a tier label + transparent comparison against named baselines is honest and defensible even if the residual stack turns out to contribute ~2-4pp rather than ~11pp. The product copy and any future paid-SaaS positioning should plan around the smaller number, not the post-ASB headline. Research direction tightens rather than widens: fix the known structural gap (wRC+) before adding more residuals or switching model class. Live evidence at 200 picks resolves the in-sample debate; nothing we can do this week beats waiting for that signal, except filling the wRC+ gap so the eventual re-validation is on a complete feature set.
