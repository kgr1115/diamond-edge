```yaml
proposal_id: moneyline-v0-2026-04-30-rev3
verdict: approve-with-conditions
lens: CEng
reasoning: >
  Reverting to DK+FD direct collapses the proxy-mismatch class by construction —
  train source = serve source = CLV-grading source. The rev2 strengthening I
  layered on top of the proxy (per-cluster shade audit, p95 ≤ 4% per cluster,
  recurring Pinnacle-vs-DK/FD residual metric, training-source-vs-serving-source
  statement) was scaffolding around a risk that no longer exists; it goes with
  the proxy. Dropping rationale-eval from v0's gate stack is strictly
  subtractive — `pick-tester`'s empirical bar (ROI, CLV, ECE, log-loss-vs-prior,
  sample-size, look-ahead canary, variance-collapse, bootstrap CIs) is
  unchanged. Rationale-eval guarded a different class of failure (factuality /
  banned keywords / disclaimer drift); with no LLM call path in v0 there is no
  surface to guard. The bundled report items I required at rev1 plus rev2's
  bootstrap CIs and sub-300 variance-aware ship rule remain the complete v0
  sign-off package. The deliberate-leakage canary carries forward — its job is
  to prove the look-ahead audit is alive, and that obligation is independent of
  data path or rationale.
conditions:
  - rev2_proxy_audit_voided: Per-cluster shade audit, p95 ≤ 4% threshold, post-launch Pinnacle-vs-DK/FD residual metric, training-source-vs-serving-source statement — all VOIDED. Architecture.md still records "training = serving = DK+FD via The Odds API" as a one-liner for audit traceability.
  - rationale_gate_dropped: `/rationale-eval` removed from v0 `pick-tester` gate stack. Reactivates only when `mlb-rationale` is unarchived. No other gate weakened.
  - sample_size_handling_preserved: Bootstrap CIs (1000-iter on ROI, CLV, log-loss-vs-prior, ECE) and the sub-300 variance-aware ship rule (lower CI bound on ROI AND CLV ≥ −1%) carry forward verbatim.
  - leakage_canary_preserved: Deliberate-leakage canary feature must FAIL the look-ahead audit. Carries forward from rev1 unchanged.
  - bundled_report_complete: Holdout pre-declaration timestamp, look-ahead audit + canary outcome, anchor coefficient + 95% CI, residual-loading sum, picks-per-day distribution, ECE + max-cal-dev + reliability bins, ROI/CLV at +1/+2/+3% EV, log-loss-vs-prior delta, train/serve parity test, bootstrap CIs on all four metrics, Odds API backfill credit reconciliation. Any missing item = automatic send-back.
escalation_target: n/a
```

## Per-decision summary

1. **DK+FD direct.** Confirmed. rev2 proxy-audit conditions (per-cluster shade, p95 ≤ 4%, recurring train-vs-serve residual metric) are VOIDED — they guarded a risk that no longer exists.
2. **Rationale-eval gate.** Strictly subtractive. The gate guarded factuality / keyword / disclaimer surfaces that v0 doesn't have. Empirical bar (ROI, CLV, ECE, log-loss-vs-prior, sample-size, leakage canary, variance-collapse, bootstrap CIs) unchanged.
3. **Sample-size handling.** Confirmed preserved. Bootstrap CIs + sub-300 lower-CI ≥ −1% rule + the full bundled-report item list as written.
4. **Deliberate-leakage canary.** Confirmed carries forward. Audit-that-catches-nothing-proves-nothing — independent of data path.
