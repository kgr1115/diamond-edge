---
name: rationale-eval
description: "Audit LLM-generated pick rationales for factuality (every cited stat traces to feature_attributions or game_context), responsible-gambling hedge presence, architecture-keyword leakage (no 'SHAP'/'LightGBM'/'gradient'), and tier-appropriate depth (Pro 3–5 sentences + 2–3 citations; Elite paragraph + ≥5 citations). Pass a pick_id, a date range, or omit for last 10 LIVE picks. Read-only. Use as a gate inside /pick-test or as a periodic quality check."
argument-hint: [pick_id | YYYY-MM-DD range | omit for last 10 LIVE]
---

Subject: `$ARGUMENTS` (pick UUID, date range, or empty for last 10 LIVE picks)

---

## What this skill does

Evaluates rationale quality on real LIVE picks (or a sampled batch). Flags hallucinations, missing disclaimers, banned keywords, and tier-depth mismatches. Returns a per-rationale audit plus summary hit rates.

Read-only on `picks` / `rationale_cache`. Does not mutate anything.

---

## Phase 1 — Pull rationales to audit

Read-only SQL (or ad-hoc node script under `scripts/run-migrations/`):

```sql
SELECT
  p.id AS pick_id, p.market, p.pick_side, p.confidence_tier, p.required_tier,
  p.visibility, p.feature_attributions, p.created_at,
  g.id AS game_id, g.home_team, g.away_team, g.game_time_utc, g.venue,
  rc.id AS rationale_id, rc.prompt_hash, rc.rationale_text, rc.model, rc.cached_at
FROM picks p
JOIN games g ON g.id = p.game_id
LEFT JOIN rationale_cache rc ON rc.id = p.rationale_id
WHERE p.visibility = 'live' AND rc.rationale_text IS NOT NULL
  AND {subject-filter}
ORDER BY p.created_at DESC
LIMIT 10;
```

Skip picks with `rationale_text IS NULL` (no rationale means no audit).

---

## Phase 2 — Per-rationale checks

For each rationale, run 4 checks. Each is 0 or 1.

### Check A — Factuality

- Parse the rationale text for numeric stats, team names, player names, venue names.
- For each stat / named entity cited, attempt to trace it to one of:
  - `feature_attributions[].label` on this pick
  - `game_context.*` (home_team, away_team, starting_pitchers, venue, weather, umpire, game_time_utc)
- ANY uncited numeric stat → FAIL this check. One hallucinated ERA, one made-up stadium dimension, one fabricated streak → 0.
- Allowed unlabeled content: general baseball vocabulary ("the bullpen", "the lineup"), qualifiers ("often", "typically"), transitional phrases.

### Check B — Responsible-gambling hedge present

- Look for one of: "bet responsibly", "gamble responsibly", "not guaranteed", "past performance does not", "variance", "manage your bankroll", "responsible gambling", or the project's canonical hedge string (check `worker/app/prompts/`).
- 1 if present, 0 if absent.

### Check C — Architecture-keyword-free

- Reject if ANY of these appear in the subscriber-facing text:
  - "SHAP", "LightGBM", "gradient", "tree", "feature importance", "model", "algorithm", "training", "boosted", "ensemble"
- 1 if all clean, 0 if any present.

### Check D — Tier-appropriate depth

- For `required_tier = 'pro'`: 3–5 sentences AND 2–3 distinct feature citations.
- For `required_tier = 'elite'`: paragraph-length (≥6 sentences or ≥300 chars) AND ≥5 distinct feature citations.
- 1 if in spec; 0 otherwise.

### Optional Check E — Prompt cache alignment

- Group audited rationales by `prompt_hash`. If all recent LIVE rationales share ≥ 1 hash, caching is working as intended.
- If `prompt_hash` is unique per rationale (no caching), flag as a prompt-caching regression (doesn't fail the audit; reports separately).

---

## Phase 3 — Report

```markdown
## Rationale eval — {YYYY-MM-DD}

### Sample
- Picks audited: {N}
- Tier split: {pro: X, elite: Y}
- Date range: {earliest → latest}

### Per-rationale

| pick_id | tier | A factuality | B disclaimer | C kw-free | D depth | verdict |
|---------|------|-----|-----|-----|-----|---------|
| abc123  | elite | 1 | 1 | 1 | 1 | PASS |
| def456  | pro  | 0 | 1 | 1 | 1 | **FAIL — factuality** ("cites 2.34 ERA not in attributions") |
| ...     |      |   |   |   |   |         |

### Hit rates
- Factuality: {X/N} = {%}    — target 100%
- Disclaimer: {X/N} = {%}    — target 100%
- Architecture-keyword-free: {X/N} = {%}  — target 100%
- Tier-depth adherence: {X/N} = {%}  — target ≥80%

### Prompt caching
- Distinct prompt_hashes in sample: {K}
- Hit rate indicator: {healthy / check cache bump on recent deploy}

### Interpretation
- {Which checks are healthy, which are drifting}
- {Anything surprising — e.g., one tier is consistently worse than the other}

### Recommended action
- All 100% on required checks → no action
- Factuality < 100% → P0: re-audit prompt grounding, review /worker/app/prompts/*, propose to pick-researcher
- Disclaimer < 100% → P0: prompt file may be missing hedge rule, verify deploy state
- Architecture-keyword leak → P0: tighten system prompt
- Tier-depth < 80% → P1: prompt tier-routing may be slipping
```

Write the report to `worker/models/rationale-evals/{YYYY-MM-DD}.md` if historical tracking is desired.

---

## Non-negotiables

1. **Read-only.** Do not edit `rationale_cache`, `picks`, or any prompt file.
2. **Do not "fix" a rationale inline.** If hallucinating, that's a prompt/routing fix — route through `pick-researcher` → `pick-scope-gate` → `pick-implementer`.
3. **Never call Anthropic** to re-generate rationales as part of this eval. Evaluate what's already in `rationale_cache`.
4. **Respect sample minimums.** A sample of 2 picks is too small to declare a system-wide trend; flag sample size in the report.
5. **Never ship a pick-rationale change** that fails Check A / B / C at <100% on the audit — pick-tester will auto-fail the gate.

---

## When to call this

- Inside `/pick-test` when pick-scope-gate's approval requires rationale verification (mandatory for any rationale/prompt/routing change).
- Inside `/pick-research` Phase 2d (rationale-surface audit).
- When Kyle asks "are the rationales any good?" / "are we hallucinating?"
- Spot-check cadence — recommend weekly if no rationale/prompt changes shipped; after every rationale deploy.
