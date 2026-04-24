---
name: pick-test
description: "Verify a pick-quality change empirically before ship — backtest gate (ROI/CLV/ECE deltas), feature coverage, pipeline anomaly scan, calibration check, rationale eval. Binary PASS (hands to pick-publisher) or FAIL (hands to pick-debugger). Distinct from test-change (codebase static+dynamic) — this one measures whether picks got better."
argument-hint: <proposal title or path to pick-implementer handoff>
---

Handoff: `$ARGUMENTS`

---

## Inputs

1. Pick-implementer's handoff report.
2. Pick-scope-gate's testing requirements (mandatory + change-specific gates).
3. Actual diff on disk.
4. Prior baseline: `worker/models/retrain/reports/<previous>/summary.json` or `worker/models/backtest/reports/`.

---

## Phase 1 — Static checks

Any failure → **FAIL immediately**.

| Check | Command |
|---|---|
| TypeScript | `cd apps/web && npx tsc --noEmit --skipLibCheck` |
| Python worker | `python -m py_compile <changed_file>` or `ruff check <file>` |
| Edge Function (Deno) | Read-check only; no local Deno. |
| JSON/YAML parse | All config files changed. |
| Feature spec integrity | If `feature-spec.md` changed, every feature has a matching entry in the ingester and worker feature assembly. |
| Calibration spec | If `calibration-spec.md` changed, `worker/app/predict.py` calibration wrapper matches. |

## Phase 2 — Feature coverage gate

`/check-feature-gap`. PASS if coverage ≥ pre-change baseline. FAIL if >5% drop.

## Phase 3 — Pipeline anomaly scan

`/run-pipeline` (against a past date or test project). Invariants (fail any → FAIL):

- ≥3 distinct model probabilities per market.
- Every pick `0.04 ≤ expected_value ≤ 0.25`. EV > 25% rejected as odds artifact.
- No single tier dominates (not 100% tier-3 or 100% tier-5).
- Mix of SHADOW + LIVE is plausible.
- No duplicate (game_id, market).
- `required_tier ∈ {'pro','elite'}`.
- Every pick has non-empty `feature_attributions`.

## Phase 4 — Backtest gate (mandatory)

`/backtest`.

| Metric | Threshold |
|---|---|
| ROI delta vs prior baseline | ≥ −0.5% |
| CLV delta | ≥ −0.1% |
| ECE delta | ≤ +0.02 |
| Brier / log-loss | Non-regression (new ≤ old × 1.01) |
| Per-market win rate | Stable within 2 pp |

Any FAIL → route to pick-debugger.

- **Retrain changes:** read `worker/models/retrain/reports/<latest>/summary.json` AND re-run `/backtest` — the two must agree.
- **Threshold-only changes (no retrain):** run `/tune-thresholds` over 60 days, verify projected ROI matches proposal's claim. Discrepancy >0.3% → FAIL.

## Phase 5 — Calibration check

`/calibration-check` against last 30–60 days (or backtest holdout if live data thin).

- Per-tier reliability: actual win rate within 5 pp of calibrated midpoint.
- ECE ≤ 0.05.
- <10 picks per tier → note "insufficient sample" but don't fail; flag for pick-researcher.

## Phase 6 — Rationale eval (mandatory if rationale / prompt / routing changed)

`/rationale-eval` on ≥5 recent LIVE picks (or fixture picks if pre-deploy).

- Factuality: 100% (every cited stat traces to feature_attributions / game_context).
- Responsible-gambling hedge: 100%.
- No architecture keywords: 100%.
- Tier-appropriate depth: ≥80%.
- Prompt cache hit rate (if routing changed): ≥80%.

Any 100%-required check <100% → FAIL.

## Phase 7 — Regression probe

- Changed LIVE_EV_MIN? Confirm SHADOW volume moved in the expected direction.
- Changed tier mapping? Confirm `required_tier` still `pro`/`elite` only.
- Changed prompt? Confirm Pro < Elite rationale length distribution.
- Added feature? Confirm pre-change pick rows still deserialize (old rows missing the new field).

## Phase 8 — Verdict

**PASS** requires ALL of:
- Static clean
- Feature coverage non-regression
- Anomaly scan passes
- Backtest gate passes
- Calibration check passes
- Rationale eval passes (if applicable)
- No adjacent regression

**FAIL** otherwise. Uncertainty = FAIL.

---

## Output format

```markdown
## Pick-test result: PASS | FAIL

### Static checks
- tsc: PASS | FAIL
- python / ruff: PASS | FAIL | N/A
- feature-spec integrity: PASS | FAIL | N/A
- calibration-spec alignment: PASS | FAIL | N/A

### Feature coverage
- Before: N% (M/90 live)
- After:  N% (M/90 live)
- Verdict: PASS | FAIL

### Pipeline anomaly scan
- distinct probabilities per market: PASS | FAIL
- EV band: PASS | FAIL
- tier distribution: PASS | FAIL
- duplicate (game_id, market): PASS | FAIL
- required_tier invariant: PASS | FAIL
- feature_attributions non-empty: PASS | FAIL

### Backtest gate
- ROI delta: {value} — threshold ≥ -0.5% — PASS | FAIL
- CLV delta: {value} — threshold ≥ -0.1% — PASS | FAIL
- ECE delta: {value} — threshold ≤ +0.02 — PASS | FAIL
- Brier / log-loss: {new / old} — PASS | FAIL
- Per-market win rate: {stable / shifted} — PASS | FAIL

### Calibration check
- ECE: {value} — PASS | FAIL
- Per-tier reliability: {summary} — PASS | FAIL

### Rationale eval (if applicable)
- Factuality: {hit rate} — PASS | FAIL
- Disclaimer present: {hit rate} — PASS | FAIL
- Architecture-keyword-free: {hit rate} — PASS | FAIL
- Tier-depth adherence: {hit rate} — PASS | FAIL

### Regression probe
- {what / observed}

### On PASS — pick-publisher handoff
Files to stage: {explicit list; NEVER `worker/models/*/artifacts/v*` unless explicitly staged by this proposal}
Retrain-job artifacts to include: {list or N/A}
Deploy actions needed: /deploy-edge | /deploy-worker | both | neither
Commit message draft:
```
{type}({pick-scope}): {subject}

{body — why, ROI / CLV / ECE deltas measured}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### On FAIL — pick-debugger handoff
Failing gate: {which}
Exact metric and threshold: {e.g., ROI delta -0.8% vs -0.5%}
Expected vs got: {delta}
Pick-scope-gate's approval: {attached}
Fix safety request: "Apply ONLY if trivially safe. Otherwise return recommendation."
```

---

## The fail → debug → retest loop

1. Any gate FAIL → spawn `pick-debugger`.
2. Re-run the **FULL** battery after any fix (not just the failed gate — calibration fixes often break backtest metrics).
3. Second PASS → pick-publisher.
4. Second FAIL → escalate. Cap at two attempts.

---

## Non-negotiables

- Never modify code yourself.
- Never run backtest destructively; it's read-only.
- Never auto-promote a retrain.
- Never commit. Never push. Never deploy.
- Never use production writes as "tests."
- Never lie or hedge. Binary PASS/FAIL.
