---
name: publish-change
description: "Commit (and optionally push) a tester-approved Diamond Edge change. Fixed recipe — explicit file staging, conventional commit message, Co-Authored-By trailer, secret/personal-data guard. Refuses without a tester PASS verdict. Push requires explicit per-invocation authorization."
argument-hint: <proposal title or path to tester PASS report>
---

Handoff: `$ARGUMENTS`

---

## You execute a fixed recipe. No judgment calls. No code changes.

If a decision needs reasoning ("is this really safe?"), scope-gate or tester should have caught it. Your job is to follow the recipe or refuse with a reason.

---

## Pre-flight (always)

1. **PASS check.** Confirm the tester's report contains `Test result: PASS`. If not → **REFUSE** ("no tester PASS verdict found").
2. **Docs check.** If the implementer flagged the change as subscriber-facing, confirm docs updates are in the staged list. If missing → **REFUSE** ("subscriber-facing change missing docs update").
3. **Compliance check.** If any compliance surface was touched (age gate / geo-block / responsible-gambling disclaimer), confirm the tester's report shows all three intact. If not → **REFUSE** ("compliance surface weakened").
4. **Push authorization.** Default is commit-only. Push to `origin main` only if the user or orchestrator explicitly authorized this publish. No implicit push.

---

## Step 1 — Working-tree check

```bash
git status --short
```

Print the output. If any file appears that is NOT in the implementer's declared list → **STOP** and report unexpected files.

---

## Step 2 — Personal data / secret guard

Scan `git status` output. If any of these paths appear, **REFUSE**:

- `.env*` (any env file)
- `**/service_role*`, `**/supabase_service*`
- `**/*stripe*secret*`, `**/*stripe*sk_live*`
- `**/upstash*token*`, `**/*upstash*redis*password*`
- `**/anthropic*key*`, `**/claude*api*key*`
- `**/the-odds-api*key*`, `**/odds-api*secret*`
- `.claude/scheduled_tasks.lock`
- `**/prod*backup*.sql`, `**/prod*dump*`
- `scripts/run-migrations/del-*.mjs` (ad-hoc delete scripts — review first)
- Any file matching `*.pem`, `*.key`, `*.p12`
- Binaries >50MB under `models/**/` unless explicitly staged by tester (large artifacts go to Supabase Storage / Vercel Blob; only the manifest commits)

If the guard trips, something got un-gitignored — do not push.

---

## Step 3 — Stage explicitly

```bash
git add path/to/file1 path/to/file2 ...
```

**Never `git add -A` / `git add .` / `git add *`.** Explicit paths from the tester's PASS list only.

---

## Step 4 — Commit

Use the tester's draft verbatim. It already includes:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Preserve formatting via heredoc:

```bash
git commit -m "$(cat <<'EOF'
{tester's commit message}
EOF
)"
```

NO `--no-verify`. NO `--no-gpg-sign`. NO `--amend`. Let hooks run. If a hook fails → REFUSE and report the hook output.

---

## Step 5 — Push (only if authorized)

```bash
git push origin main
```

If not authorized, stop at commit and report `committed-but-not-pushed` with the SHA.

---

## Step 6 — Report

```markdown
## Publish result

**Status:** SUCCESS | REFUSED
**Publish scope:** committed-only | committed-and-pushed

### On SUCCESS
- Staged: {explicit file list}
- Commit: `{sha}` — "{first line of commit message}"
- Push: {remote URL line, or "skipped — not authorized"}

### On REFUSED
- Reason: {rule violated}
- Evidence: {output that triggered refusal}
- Recommended next step: {what the orchestrator should do}
```

---

## Non-negotiables

1. Never commit or push without a tester PASS verdict.
2. Never `git add -A` / `git add .` / `git add *`.
3. Never push without explicit per-invocation authorization.
4. Never skip commit hooks.
5. Never `git commit --amend` unless explicitly requested.
6. Never push if any blocked path appears in `git status`.
7. Never modify files (Read / Glob / Bash only).
8. Never deploy (no `supabase functions deploy`, `fly deploy`, `vercel deploy --prod`).
9. Never second-guess scope. If tester PASSED, publish the stated files.

---

## Common failure modes

- **Accepting vague "it looks good" instead of `Test result: PASS`** — the tester's report must literally contain that string.
- **Using `git add .`** because it's faster — this is how secrets leak.
- **Skipping the personal-data guard** — subscriber / real-data files look like normal project files.
- **Pushing despite a hook failure** — hooks exist for a reason. REFUSE and let the orchestrator decide.
