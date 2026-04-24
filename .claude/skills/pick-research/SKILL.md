---
name: pick-research
description: "Audit Diamond Edge pick quality + ROI end-to-end and produce a prioritized list of improvement proposals. Invoked at the start of a pick-improvement cycle, before pick-scope-gate-review. Returns ≤10 evidence-backed proposals ready for gating. Distinct from research-improvement (codebase) — this one audits model, features, calibration, rationale."
argument-hint: [focus area — "calibration" | "rationale" | "thresholds" | "features" | "rotate full audit" or omit for full]
---

Focus area (if any): `$ARGUMENTS`

---

## Phase 0 — Read the scope gate's rules BEFORE researching

Read `.claude/agents/pick-scope-gate.md`. Every proposal that violates a locked rule will be auto-denied. Save round trips by filtering upfront. Key rules to memorize:

- EV filter ≥ 4% (publication), ≥ 8% (LIVE visibility). Lowering needs user approval.
- Confidence tier 1–5; publication ≥ 3; Elite ≥ 5.
- Auto-promote: CLV delta > +0.1% AND log-loss non-regression.
- No post-game data in features (leakage).
- ≥30 graded picks for threshold changes; ≥100 for feature engineering.
- Rationale must cite only `feature_attributions` / `game_context`; RG hedge required; no architecture keywords.
- Anthropic-only LLM. CPU-only models. <$300/mo total; ≤$100/mo odds API.

---

## Phase 1 — Baseline state audit

Read the current performance baseline before proposing anything.

| Question | Command / evidence |
|---|---|
| How are picks doing right now? | `/daily-digest` |
| What does the current model look like on the holdout? | `/backtest` |
| Which features are actually populating? | `/check-feature-gap` |
| Is the model still calibrated? | `/calibration-check` |
| Are rationales well-grounded? | `/rationale-eval` on last 5–10 LIVE picks |
| Where is today's EV distribution sitting? | SQL aggregate on `picks` for today — `SELECT market, min/max/avg(expected_value), count(*)` |
| How is CLV trending? | `pick_clv` last 30–60 days — running mean, stddev |

Record the baseline. Every proposal later will reference this.

---

## Phase 2 — Drill by surface

### 2a. Threshold surface (EV / tier)

- Run `/tune-thresholds` over the last 60 days. Read the projected-ROI × volume trade-off table.
- Are current gates (4% / 8% EV; tier 3 / tier 5) at a local optimum? If a +1% / +2% EV bump would net positive ROI with meaningful volume remaining, that's a proposal.
- Sample-size guard: never propose a threshold change with <30 graded picks in the affected regime. `/tune-thresholds` enforces this.

### 2b. Feature surface

- Read `/check-feature-gap` output. Which features default to league-average?
- For each gap: is it a data-source issue (ingester broken), a spec issue (feature declared but not assembled), or a cold-start issue (new feature, sparse data)?
- Recent retrain summary (`worker/models/retrain/reports/<latest>/summary.json`) — does feature-importance rank the gap-features as zero? If so, zero-impact features are candidates for removal; high-impact-but-defaulted features are candidates for ingester work.

### 2c. Calibration surface

- Read `/calibration-check` output. Per-tier actual win rate vs calibrated midpoint.
- ECE > 0.05 → calibration drift. Could be (a) retrain needed, (b) isotonic/beta recalibration, (c) tier-mapping re-drawing.
- Does any single tier have <10 graded picks? If so, the reading is underpowered — flag as "insufficient sample," not a proposal.

### 2d. Rationale surface

- Run `/rationale-eval` on a 10-pick sample. What's the hit rate on factuality / disclaimer / architecture-free / tier-depth?
- 100% required on factuality, disclaimer, architecture-free. Any miss → P0 proposal.
- ≥80% on tier-depth is acceptable; below is P1–P2 depending on severity.
- Check Anthropic cost / cache hit rate. If cache is < 80%, that's a proposal (restructure prompt for better caching).

### 2e. Model surface

- Read `worker/models/retrain/reports/<latest>/summary.json`. Did the last retrain promote a marginally-passing candidate? Marginal promotions compound over time; worth a proposal to tighten the auto-promote threshold.
- Check `worker/models/<market>/feature-spec.md` against the ingester / feature-assembly code. Spec drift → proposal.
- Check that training-time and serving-time feature assemblers agree. Training-serving skew is PF1 on the pick-debugger's failure-mode table.

### 2f. Pipeline surface

- Run `/run-pipeline` dry-run. Are there anomalies? Degenerate probabilities, EV > 25%, all picks at one tier, missing feature_attributions?
- Any anomaly hints at an upstream issue — flag.

---

## Phase 3 — External research (optional, targeted)

Use WebSearch/WebFetch when an internal finding suggests an unfamiliar technique:

- Calibration methods for boosted-tree sports models.
- Closing-line-weighted training objectives.
- Feature importance stability across retrains.
- Prompt-caching patterns for structured LLM outputs.
- Responsible-gambling disclaimer compliance benchmarks.

Filter against the locked scope. No paid services. No non-Anthropic LLM. No GPU requirement.

---

## Phase 4 — Synthesize into proposals

Max 10 per cycle. One finding → one proposal. Specific: file, behavior change, expected ROI/CLV/ECE delta, sample size.

### Output format

Write the full proposal doc to `docs/improvement-pipeline/pick-research-{YYYY-MM-DD}.md`. Return a summary (≤250 words) with the file path, counts by priority, and top-3 titles.

```markdown
# Pick Research — {YYYY-MM-DD}

## Baseline recorded
- Today's pick volume: N
- Last 60d ROI: X% (n=M)
- Last 60d CLV mean: Y%
- ECE (live): Z
- Feature coverage: K%
- Rationale factuality / disclaimer / architecture-free hit rate: {percentages}

## Proposal N: {short title}
**Category:** calibration | feature-engineering | EV-threshold | tier-mapping | rationale-quality | feature-coverage | model-architecture | cost-optimization | other
**Why it matters for ROI / confidence:** {paragraph}
**Concrete change:** {files + behavior}
**Evidence:** {metric / reading / sample}
**Expected ROI delta:** {+X% or unknown with stated sample}
**Sample size:** {N graded picks / N games / holdout size}
**Risk:** {what could degrade}
**Cost impact:** {$/mo}
**Priority:** P0 ROI-negative | P1 material | P2 polish | P3 nice-to-have
```

---

## Common failure modes for this role

- **Proposing threshold changes on tiny samples.** <30 graded picks in the affected regime is noise.
- **Proposing feature additions without leakage check.** Every new feature must be available at bet time.
- **Proposing rationale wording without measuring rationale-eval baseline.** You need a before number.
- **Ignoring cost impact.** Every proposal states $/mo, even if zero.
- **Confusing backtest metrics with live metrics.** Backtest ROI says the model can do X on 2024 holdout; live CLV says it IS doing Y this month. They differ.
- **Touching compliance surfaces** — RG hedge, age gate, geo-block. These are not proposable here; flag to `mlb-compliance` instead.

---

## When you find nothing high-leverage

"Baseline within holdout expectation. ECE stable. Feature coverage N%. Rationale factuality 100%. No high-leverage improvements this cycle. Recommend next audit in M days or after next retrain."
