---
name: pick-publish
description: Stage 5b of the pick-improvement pipeline. Final stage on `pick-test` PASS. Commits + pushes per Kyle's standing authorization with model-artifact size guard. Invokes the `pick-publisher` agent. Deploy remains user-invoked (`vercel:deploy prod`).
argument-hint: [optional — change-set identifier]
---

Change-set: `$ARGUMENTS` (or auto-detect post-PASS state)

---

## Pre-flight checks (refuse if any fail)

- `pick-test` returned PASS on the change-set (or, for the v0 cold-start path, CEng signed off in writing per the Cold-Start Lane in CLAUDE.md).
- Diff does NOT include any binary >50MB under `models/*/` (size guard — large artifacts go to Supabase Storage / Vercel Blob; only the manifest commits).
- Diff does NOT include any `.env` / `*_KEY` / `*_SECRET` patterns.
- Diff does NOT weaken compliance copy (no "DO NOT BET" → "BET NOW", no removal of RG disclaimer).
- Current branch is intentional (do NOT push to `main` unless current branch IS main).

If any check fails → refuse, surface to user with the specific guard that fired.

## Stage

```bash
git add <changed files except gitignored artifacts and secrets>
```

## Compose commit

```
<one-line subject>

<one-paragraph why, referencing proposal IDs from docs/proposals/>

Co-Authored-By: Claude <noreply@anthropic.com>
```

Subject keeps under 70 chars. Body explains the *why* (not the *what* — diff has that).

## Commit + push

```bash
git commit -m "<message via heredoc>"
git push origin <current-branch>
```

Standing authorization per CLAUDE.md (2026-04-24).

## Stop

Do not deploy. Surface:

> Pushed `<hash>` to `<branch>`. Deploy is user-invoked: `vercel:deploy prod`.

## Hard refusals (full list)

- `pick-test` did NOT return PASS.
- Artifact size guard fires.
- Secret pattern detected in diff.
- Compliance weakening detected.
- Force-push or main-push without explicit user confirmation.

## Return

≤100 words: commit hash + subject + branch pushed to + artifacts skipped + deploy reminder.
