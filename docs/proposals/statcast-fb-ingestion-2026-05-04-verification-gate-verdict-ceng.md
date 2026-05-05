```yaml
proposal_id: statcast-fb-ingestion-2026-05-04
verdict: approve-with-conditions
lens: CEng
reasoning: >
  Section 7f's soft-fail clause is satisfied by inspection — exactly one miss in the
  0.20-0.40 band (deGrom 2023, |Δ|=0.327), all four other pitchers strict PASS, no miss
  above 0.40, no same-direction systematic bias (deltas straddle zero in sign distribution
  across the set, and the v1→v2 aggregator change closed the prior 0.7-unit gap exactly
  as predicted). The submitted rationale is plausible: 29.4 IP is a structural outlier
  (next-smallest sample is 6× larger), constants-precision sensitivity scales inversely
  with IP, and on a sub-30-IP partial season a 0.3 xFIP-unit miss against an MLB API
  truth value that itself rounds to 5 decimals is within the noise floor of the truth
  source. One factual correction: the fixture shows deGrom at 6/6 statcast_v2 provenance
  (legacy=0), not the 5/6 v2 + 1/6 legacy framing in the request. That actually
  strengthens the verdict — the miss is NOT a mixed-source artifact, so the rationale
  narrows cleanly to small-sample + constants-precision rather than an unresolved
  ingestion concern. The xFIP infra chain is COMPLETE for the purposes of unblocking
  downstream work; the deGrom miss is logged, explained, and bounded.
conditions:
  - >
    Constants audit (one-shot, before any retrain consumes xFIP): hand-verify
    LG_HR_PER_FB and XFIP_CONST for 2021, 2022, 2023, 2024 against FanGraphs guts table
    to 4-decimal precision. If any constant is off by ≥0.005, re-run computeXfip on the
    fixture and update the fixture in place. This is cheap (5 numbers per year × 2 constants)
    and removes constants-precision from the candidate-cause list permanently. Owner:
    mlb-feature-eng. No retrain blocked on this — runs in parallel.
  - >
    Provenance correction for the audit trail: the rationale paragraph in this verdict
    cites the fixture's actual provenance (deGrom 6/6 v2). If the chain documentation
    elsewhere repeats the 5/6 + 1/6 framing, correct it to match the fixture. Trivial.
  - >
    The deGrom 2023 miss is logged and accepted. It does NOT need to be re-verified
    after the constants audit unless a constant moves materially. Section 7f does not
    require re-passing the strict gate after a soft-fail rationale lands — it requires
    CEng review, which is this verdict.
  - >
    Standing condition unchanged: retrain remains deferred per the prior xFIP infra
    scope-gate verdict's CSO/CEng conditions. This verdict does not green-light a model
    refit; it green-lights the infra chain as complete.
escalation_target: n/a
```

## Rationale (extended)

The verification gate is the bar. The bar reads "all 5 within ±0.20 OR exactly 1 miss
in 0.20-0.40 with written rationale + CEng review." The submitted state is the second
branch of that disjunction, exactly. Rejecting now would require adding a criterion that
wasn't in the proposal at scope-gate time — bad gate hygiene.

The empirical case for accepting:

1. **Direction of error has flipped from systematic to noise.** Pre-fix all 5 pitchers
   were biased the same direction at ~0.7 units (the signature of undercounted FB).
   Post-fix the deltas are mixed-sign-pattern noise centered near zero with one
   small-sample outlier. That's the shape of a corrected estimator, not a still-broken one.

2. **Sample-size bound on the outlier is tight.** Skubal (the next-smallest at 189.9 IP)
   is 6.4× deGrom's sample; constants-precision contribution to xFIP scales as
   ~(constant_error × FB) / IP, so a 30-IP season is ~6× more sensitive to the same
   constants miss. A 0.05 unit miss on a full-season pitcher would be a 0.3 unit miss
   on deGrom. The pattern fits.

3. **Provenance is clean.** All 6 deGrom rows are statcast_v2 (the fixture is the source
   of truth here, not the request's framing). The miss isn't an aggregator artifact and
   isn't a mixed-source artifact. That collapses the candidate-cause list to two
   things: small-sample noise floor and constants precision. The constants audit
   condition above closes one of those; the other is a known property of partial-season
   xFIP and doesn't need fixing.

4. **The truth source itself is finite-precision.** MLB API returns 2.31879 with 5
   decimals; FanGraphs publishes 2 decimals. Round-trip transcription error against a
   2-decimal published xFIP for a 6-game partial season is plausibly 0.05+ units before
   any computation error.

What I am NOT doing:

- I am not waving through a 0.327 miss as "close enough." I am acknowledging that
  section 7f explicitly defined this case as a CEng-review-not-block situation, and
  the submitted rationale meets the bar for that review.
- I am not approving any retrain. The CSO/CEng conditions on retrain from the prior
  infra verdict remain in force. xFIP infra being complete ≠ xFIP being consumed
  by a refit model.
- I am not waiving the constants audit. It's cheap and it permanently removes the
  largest residual unknown from the candidate-cause set. Conditioning on it is the
  cost of soft-fail acceptance.

## Files

- `C:\AI\Public\diamond-edge\docs\proposals\statcast-fb-ingestion-2026-05-04.yaml` (proposal; section 7f is the operative clause)
- `C:\AI\Public\diamond-edge\tests\fixtures\feature-parity\xfip-statcast-verification-2026-05-04.json` (verification fixture; binding evidence)
- `C:\AI\Public\diamond-edge\docs\proposals\stuff-plus-ingestion-2026-05-04-infra-scope-gate-verdict.md` (prior verdict; retrain conditions still binding)
- `C:\AI\Public\diamond-edge\scripts\lib\xfip-formula.ts` (formula module; constants audit target)
- `C:\AI\Public\diamond-edge\scripts\lib\xfip_formula.py` (Python parity; same audit target)
