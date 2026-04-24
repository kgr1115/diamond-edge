---
name: pick-publish
description: "Commit + push a pick-tester-approved pick-quality change. Fixed recipe with model-artifact size guard + Edge-Function/worker-deploy-flagging. Refuses without a literal `Pick-test result: PASS`. Push per Kyle's standing authorization (2026-04-24); deploys remain user-invoked (/deploy-edge, /deploy-worker)."
argument-hint: <proposal title or path to pick-tester PASS report>
---

Handoff: `$ARGUMENTS`

---

## Fixed recipe. No judgment. No code changes.

If a decision needs reasoning, it should have been caught upstream. Follow the recipe or refuse with a reason.

---

## Pre-flight

1. **PASS check.** `Pick-test result: PASS` must appear verbatim. If not → **REFUSE** ("no pick-tester PASS verdict").
2. **Docs check.** If pick-implementer flagged the change as subscriber-visible, confirm doc updates are staged. If missing → **REFUSE** ("subscriber-visible change missing docs").
3. **Compliance check.** Rationale-touching changes must show `Disclaimer present: 100%` and `Architecture-keyword-free: 100%`. Missing → **REFUSE** ("compliance surface weakened").
4. **Backtest-gate echo.** The commit message must include ROI / CLV / ECE deltas. Missing → ask pick-tester for a revised draft.
5. **Push authorization.** Kyle's standing auth lives in `memory/feedback_push_authorization.md`. If present → commit + push. If not → commit-only.

---

## Step 1 — Working-tree check

```bash
git status --short
```

Any path outside pick-tester's declared list → STOP, report.

---

## Step 2 — Secret / personal-data guard

Refuse on any:
- `.env*`
- `**/service_role*`, `**/supabase_service*`
- `**/*stripe*secret*`, `**/*stripe*sk_live*`
- `**/upstash*token*`, `**/*upstash*redis*password*`
- `**/anthropic*key*`, `**/claude*api*key*`
- `**/the-odds-api*key*`, `**/odds-api*secret*`
- `.claude/scheduled_tasks.lock`
- `**/prod*backup*.sql`, `**/prod*dump*`
- `scripts/run-migrations/del-*.mjs`
- `*.pem`, `*.key`, `*.p12`

---

## Step 3 — Model-artifact size guard

- Any `worker/models/*/artifacts/v*` path NOT in pick-tester's staged list → **REFUSE** ("model artifact directory not explicitly staged").
- Staged artifacts: verify total size `du -sh` < 100 MB. Over → REFUSE.
- `current_version.json` pointer and `metrics.json` are small + fine.

---

## Step 4 — Stage explicitly

```bash
git add <path1> <path2> ...
```

Never `-A` / `.` / `*`.

---

## Step 5 — Commit

Use pick-tester's draft verbatim (heredoc). Body should contain:

```
ROI delta: +X.Y% vs 60d baseline (n=N)
CLV delta: +X.Y% vs 60d baseline
ECE: {before} → {after}

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

No `--no-verify`. No `--no-gpg-sign`. No `--amend`. Hooks run.

---

## Step 6 — Push (if authorized)

```bash
git push origin main
```

If auth revoked, report `committed-only` with SHA.

---

## Step 7 — Flag deploys (DO NOT deploy)

Report the deploy actions required. User invokes:

- Edge Function changed (`supabase/functions/pick-pipeline/**`) → `/deploy-edge`.
- Worker / model changed (`worker/**`) → `/deploy-worker`.
- Both → deploy worker FIRST, then Edge Function (Edge Function may call worker endpoints).
- Web-only (`apps/web/**`) → Vercel auto-deploys.

---

## Step 8 — Report

```markdown
## Pick-publish result

**Status:** SUCCESS | REFUSED
**Publish scope:** committed-and-pushed | committed-only | refused

### On SUCCESS
- Staged: {explicit list}
- Commit: `{sha}` — "{first line}"
- Push: {remote URL line, or "skipped"}

**Deploy actions required (USER INVOKES):**
- [ ] /deploy-worker
- [ ] /deploy-edge
- [ ] (neither)

**Cache implications:**
- Prompt cache bumped: yes | no  (expect brief cost spike until cache warms)
- Redis picks:today invalidation: handled by pipeline / manual flush required

### On REFUSED
- Reason: {rule violated}
- Evidence: {output}
- Recommended next step
```

---

## Non-negotiables

1. Never commit/push without pick-tester PASS.
2. Never `git add -A` / `.` / `*`.
3. Never auto-include `worker/models/*/artifacts/v*`.
4. Never skip hooks.
5. Never `--amend` unless explicitly asked.
6. Never deploy (`supabase functions deploy`, `fly deploy`, `vercel deploy --prod`).
7. Never bypass secret guard.
8. Never second-guess pick-tester's PASS.
9. Never auto-promote a retrain by flipping `current_version.json` outside an explicitly staged change.
