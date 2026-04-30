---
name: rationale-eval
description: Diagnostic skill — audits LIVE pick rationales for factuality (cites only attribution payload + pre-game context), RG disclaimer presence, banned-keyword absence, and tier-appropriate depth. Delegates to the `mlb-rationale` agent. Used as a gate inside `pick-test` and ad-hoc by `pick-research`.
argument-hint: [sample size — defaults to last 50 LIVE rationales | --verbose for per-rationale detail]
---

Sample: `$ARGUMENTS` (default: last 50 LIVE)

---

## Inputs

- Recent LIVE pick rationales with the original attribution payload + game context that was passed to the LLM.
- Current banned-phrase list (`docs/compliance/banned-phrases.md`).
- Tier depth contract (per-tier word-count and detail-level expectations).

## What to check

For each rationale in the sample:

1. **Factuality.** Every stat cited in the rationale appears in the attribution payload OR in the game context. Stats not in either → factuality FAIL.
2. **RG disclaimer presence.** The standard RG line appears in the output. Programmatic, not template-relied. Absence → FAIL.
3. **Banned-keyword absence.** Architecture keywords (SHAP, LightGBM, gradient, etc.) and compliance-banned phrases (lock, guaranteed, expert handicapper, etc.) absent. Presence → FAIL.
4. **Tier-appropriate depth.** Pro tier within Pro depth contract; Elite within Elite. Bleed-through → FAIL.

## Pass/fail

- All four checks pass on ≥95% of the sample → PASS overall
- Any check fails on >5% → FAIL with the specific check named
- Any single rationale with a banned keyword → FAIL regardless of overall rate (banned keywords are zero-tolerance)

## Output

Write `docs/audits/rationale-eval-<timestamp>.md` with:
- Per-check pass-rate table.
- Banned-keyword incidents (full list, zero-tolerance).
- Factuality violations (rationale ID + the un-grounded stat).
- Verdict (PASS / FAIL).

## Anti-patterns

- Skipping the banned-keyword check because the rate is "low."
- Treating tier-depth bleed as cosmetic. It isn't — it's a tier-gate breach.
- Auditing without the original attribution payload (you can't check factuality from output alone).

## Return

≤150 words: per-check pass-rate + banned-keyword incident count + verdict.
