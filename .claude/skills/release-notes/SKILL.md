---
name: release-notes
description: Summarize recent Diamond Edge commits into human-readable release notes. Use after a sprint or when Kyle asks "what shipped since yesterday?", "what's changed this week?", /release-notes [since-date-or-commit].
---

# Release Notes

Scans recent commits + grouped changes, produces a changelog-style summary Kyle can skim without reading 30 commit messages.

## Instructions

### Step 1 — Determine the window

If Kyle passes a date or commit ref (e.g. `/release-notes 2026-04-20` or `/release-notes since ebb0c49`), use that as the lower bound. Otherwise default to "last 7 days" or "last 20 commits", whichever is shorter.

### Step 2 — Pull commits

```bash
git log --oneline --since="7 days ago" main
```

Or for a specific commit range:

```bash
git log --oneline <start-hash>..HEAD
```

### Step 3 — Group by conventional-commit type

Every commit uses `type(scope): summary` style. Parse and group:

- **feat**: new features → "Added"
- **fix**: bug fixes → "Fixed"
- **chore**: maintenance, memory, config → "Chores"
- **docs**: docs changes → "Docs"
- **research**: research docs → "Research"
- **test**: test changes → "Tests"
- **refactor**: refactors → "Refactors"

Within each group, cluster by scope (e.g. all `feat(frontend)` together).

### Step 4 — Identify themes

Look for runs of commits that together accomplish a bigger thing. Examples from this project:

- Multiple `feat(worker): ...` commits in the same day = "ML pipeline overhaul"
- `fix(mlb-stats)` + `fix(next)` + `fix(stats)` = "production stability sprint"

Promote these to theme headings above the raw commit list.

### Step 5 — Flag risk + attention

Call out anything that warrants Kyle's eyes:

- Migrations applied (list number + effect)
- Destructive operations (DELETE/DROP patterns)
- Deployments (worker, edge function)
- Config changes (pg_cron job adds/modifications)
- Dependency additions (new npm / pip packages)

## Output format

```markdown
# Release Notes — {date range}

{N commits, M authors}

## Themes
- <theme 1 in 1-2 lines>
- <theme 2 in 1-2 lines>

## Added
- feat(frontend): bankroll dashboard (`33e21ff`)
- feat(ai): news extraction pipeline (`0f5e8b9`→`b617663`)
- ...

## Fixed
- fix(pipeline): dedupe picks (`ed80889`)
- fix(mlb-stats): use startDate/endDate (`790e433`)
- ...

## Migrations
- 0008 news_events/news_signals/market_priors (applied)
- 0012 stats tables (applied)
- 0014 pick journal + bankroll settings (applied)

## Deploys
- Vercel production: {N builds}
- Vercel preview: {N builds}

## Needs attention
- <e.g. "Supabase types codegen is pending post-migrations 0012/0013/0014">
- <e.g. "Auto-promote threshold was triggered on 2 of 3 models">
```

## Constraints

- Don't include merge commits or empty "chore: force rebuild" commits in the Added/Fixed/etc. lists
- Limit to 50 commits max in the window — if more, ask Kyle for a narrower range
- Link every commit by short hash (first 7 chars) for easy lookup
