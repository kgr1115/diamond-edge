---
name: test-change
description: Verify an implementer's diff for Diamond Edge before it ships — static checks (tsc, lint, Python syntax, migration SQL parse, frontmatter), scenario-based dynamic tests with fixtures (never production data), and every edge case scope-gate required. Invoked after implement-change produces a handoff report. Returns PASS (hands to publisher) or FAIL (hands to debugger, then retests). Lightweight gate; for heavyweight E2E/staging validation, escalate to mlb-qa.
argument-hint: <proposal title or path to implementer handoff report>
---

Handoff: `$ARGUMENTS`

---

## Inputs required before starting

1. Implementer's handoff report (what changed, how to test, known risks, compliance surfaces).
2. Scope-gate's APPROVED verdict, including required edge cases.
3. Actual changed files on disk — read them yourself; don't rely on the implementer's description.

---

## Phase 1 — Static checks (always run first)

Any failure → **FAIL immediately**. Don't proceed to dynamic tests.

| Check | Command |
|---|---|
| TypeScript | `npx tsc --noEmit` in project root. Any error → FAIL. |
| ESLint / Biome | Project lint config. Error-level rule → FAIL. Warnings flagged but non-blocking unless scope-gate said so. |
| Python worker syntax | `python -m py_compile <file>` or `ruff check <file>`. Any error → FAIL. |
| JSON / YAML validity | Parse with appropriate loader. |
| Supabase migration SQL | Parse with `psql --dry-run` against local/dev DB, or manual syntax read. NEVER against prod. |
| Agent/skill frontmatter | `name` matches file/dir; description ≤3 sentences, ≤500 chars; body free of `{{...}}` placeholders. |

---

## Phase 2 — Dynamic checks (scenario-based)

**Never use production Supabase rows, real subscriber bet data, or live-odds pulls against the $100/mo-capped API as test payloads.**

| Change type | How to test |
|---|---|
| Next.js page/component | `npm run dev`, open the page, exercise the user flow. Check 0/1/many states per scope-gate edge cases. |
| API route | `curl` / `fetch` with fixture payload. Auth + validation + happy + error paths. |
| Supabase Edge Function | `supabase functions serve`, POST fixture, confirm expected writes in a dev project. |
| Supabase migration | Apply to throwaway branch/project; confirm schema + backfill; roll back; verify idempotency. |
| Fly.io worker | Local `uv run`, hit `/health` + changed endpoint with fixture. Confirm response shape. |
| Odds / Stats / Savant ingester | Cached fixture payload (never re-fetch live); run handler; confirm Upstash or Supabase state. |
| ML model code | Frozen dataset slice, run inference, diff output vs expected. Don't retrain unless proposal explicitly does. |
| Stripe webhook handler | `stripe listen` with fixture event; verify signature check, idempotency, DB state. |
| Agent profile / skill | Load frontmatter; confirm required fields; read body and confirm steps are actionable and placeholder-free. |
| Compliance surface | Confirm 21+ gate, geo-block, responsible-gambling disclaimer still render on affected page. |

---

## Phase 3 — Scope-gate-required edge cases

Scope-gate lists specific edge cases in its approval. Hit every one. Common Diamond Edge edge cases:

- **Pick slate:** 0 games, 1 game, many games; tier-gated subscriber; non-subscriber hitting locked pick; pipeline-in-progress; pipeline-failed state.
- **Pick detail:** game completed, cancelled, graded win/loss/push, ungraded; CLV present, CLV missing.
- **Bankroll:** 0 bets, 1 bet, many bets, delete-bet undo; ROI edge cases (all losses, all wins, single bet).
- **Subscription:** trial→paid, paid→cancelled, failed payment, re-subscribe, tier up/down.
- **Geo/age:** unauthorized state, age-check failure.

---

## Phase 4 — Regression probe

Scan changed files for adjacent behaviors that could have broken. Spot-check likely neighbors. For heavyweight regression coverage, spawn `mlb-qa`.

---

## Phase 5 — Verdict

**PASS** requires ALL of:
- All static checks clean
- All dynamic checks match expected behavior
- All scope-gate-required edge cases pass
- No obvious regression in adjacent code
- No compliance surface weakened

**FAIL** otherwise. Uncertainty = FAIL.

---

## Output format

```markdown
## Test result: PASS | FAIL

### Static checks
- tsc: PASS | FAIL — {error if FAIL}
- lint: PASS | FAIL
- python syntax (if applicable): PASS | N/A
- migration SQL parse (if applicable): PASS | N/A
- agent/skill frontmatter (if applicable): PASS | N/A

### Dynamic checks
- {scenario 1}: PASS | FAIL — evidence
- ...

### Edge cases (per scope-gate)
- {edge case 1}: PASS | FAIL — evidence
- ...

### Regression probe
- {what you checked, what you saw}

### Compliance surfaces
- age gate intact: yes | no
- geo-block intact: yes | no
- responsible-gambling disclaimer intact: yes | no

### On PASS — publisher handoff
Files to stage: {explicit list}
Commit message draft:
```
{type}({scope}): {subject}

{body — why, subscriber-facing impact}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

### On FAIL — debugger handoff
Failing check: {which}
Exact error: {output}
Expected vs got: {delta}
Scope-gate's original approval: {attached}
Fix safety request: "Apply ONLY if trivially safe. Otherwise return recommendation."
```

---

## The fail → debug → retest loop

1. First test → FAIL → spawn `debugger` via Task tool with failure evidence.
2. Debugger investigates, applies fix if safe, returns fixed diff.
3. **Re-run the FULL battery** (not just the failed check).
4. Second test → PASS → proceed to publisher.
5. Second test → FAIL → escalate to mlb-picks-orchestrator. Cap at two attempts. Never loop.

---

## Non-negotiables

- Never modify code yourself. If broken, hand to debugger.
- Never use production data. Fixtures or dev projects only.
- Never commit or push. PASS authorizes the publisher.
- Never lie or hedge. Binary pass/fail. Uncertainty = FAIL.
- Never skip compliance-surface verification on a subscriber-facing change.

---

## Common failure modes

- **Testing only happy path** — scope-gate-required edge cases are there precisely because happy path isn't enough.
- **Trusting implementer's "verified" claim** — read changed files yourself.
- **Using production data** during dynamic tests — always copy to fixture. A test that mutates real state is a data incident.
- **PASS when uncertain** — dig more, or call FAIL and let debugger help.
