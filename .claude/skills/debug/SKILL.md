---
name: debug
description: "Diagnose broken or unexpected Diamond Edge behavior — Vercel Function failures, partial pick runs, webhook misfires, RLS denials, LLM failures, odds-API rate-limits, UI regressions. Invoked by the debugger agent on FAIL or directly. Maps symptoms to evidence sources, encodes known failure modes, defines when to fork sub-debuggers."
argument-hint: <symptom description>
---

Symptom: `$ARGUMENTS`

---

## Step 0 — State the symptom precisely

Rephrase as one sentence of observable behavior before touching any files.

- Bad: "the pipeline seems broken"
- Good: "the `/api/cron/pick-pipeline` Vercel Function logs 3 game inserts then a 502; no picks inserted for today"

---

## Step 1 — Map symptom to evidence source

| Symptom class | Go-to evidence |
|---|---|
| No picks for today | `picks` table in Supabase; Vercel function logs for the pick-pipeline route; Upstash cache key for today's slate; MLB Stats API response for today's games |
| Pipeline partially ran | `pipeline_runs` / run-state table in Supabase; Vercel function logs for the pick-pipeline route; compare expected stage count vs last-complete-stage |
| Pick rationale missing or weird | Anthropic API call logs; pick row rationale fields; prompt-cache hit rate; rationale-generation route logs |
| Odds data stale / missing | Upstash key for odds snapshot; The Odds API credit usage in provider dashboard; ingester log; last-fetch timestamp |
| ML prediction looks off | `models/*/current/` artifact + `architecture.md` + `metrics.json`; feature-population report (when `/check-feature-gap` skill exists); recent backtest report |
| Stripe webhook failed | Stripe dashboard → Webhooks → recent events; signature-check log in API route; DB idempotency key table |
| Supabase RLS denial | Supabase logs; `select * from pg_policies where tablename = '<table>';`; auth-user's JWT claims |
| UI regression | Browser devtools console; Next.js dev-server log; recent commits to affected route; Vercel build log |
| Auth / sign-in broken | Supabase Auth logs; Next.js middleware log; cookies in browser; RLS policy test |
| Geo-block misfire | Middleware logs; IP-to-state mapping source; state-availability list in compliance doc |
| Vercel Function timeout / cold-start spike | Vercel function logs; the route's `maxDuration` export; Fluid Compute reuse metrics |
| Runaway token cost | Anthropic dashboard; prompt-cache hit rate; per-pick token budget; recent model-routing changes (Haiku ↔ Sonnet by accident?) |

---

## Step 2 — Known failure modes (F-table)

### F1. Odds-API credit burn from cold fetch in render path

**Symptom:** The Odds API monthly credit drops unusually fast.
**Cause:** A code path hits The Odds API without the Upstash cache wrapper — often a new render path or cron forgot the cache layer.
**Check:** Grep for direct `the-odds-api.com` calls or odds-provider client instantiations outside `lib/odds/`.
**Fix:** Route through the cache wrapper. TTL ≥5 min pre-game, 30–60s live. Confirm no `bypassCache: true` flag slipped in.

### F2. Vercel Function timeout from default `maxDuration`

**Symptom:** API route returns 504 or truncated response; the same work completes when run locally.
**Cause:** Route is using the default `maxDuration` when the workload genuinely needs longer. Fluid Compute supports up to 300s but the route has to opt in.
**Check:** Look at the route's `maxDuration` export. Time the operation.
**Fix:** Set `export const maxDuration = <seconds>` on the route up to 300. If genuinely >300s needed, that's a `kind: infra` proposal — not a tweak.

### F3. Supabase RLS blocking legit query after schema change

**Symptom:** Query returns empty in prod but works for service role.
**Cause:** Migration added a column/table but RLS policy wasn't updated.
**Check:** `select * from pg_policies where tablename = '<table>';`. Diff against migration.
**Fix:** Update policy in a follow-up migration. Never disable RLS as a fix.

### F4, F5, ... add as incidents happen.

---

## Step 3 — Gather evidence before forming hypotheses

1. **Logs first.** Tail Vercel function logs (`vercel logs` or dashboard), Next.js dev log. Look for `ERROR`, `FAILED`, `crashed`, timestamps that stop too early.
2. **DB state.** Open Supabase, query the relevant tables directly. Read-only.
3. **Cache state.** Read Upstash keys for today's slate / odds / tier cache.
4. **Function metrics.** For runaway loops or cold-start spikes — Vercel function metrics dashboard.
5. **Return codes / exit status.** If a script or function ran, find its exit code. Non-zero → read stderr.
6. **External dashboards.** The Odds API credit, Anthropic token usage, Stripe events, Supabase project metrics.

---

## Step 4 — Decision tree for spawning sub-debuggers

```
Single component (one route, one function)?
  YES → investigate directly. No sub-debugger.
  NO  → does it split into independent sub-investigations?
          YES → each needs different evidence sources?
                  YES → spawn one sub-debugger per investigation
                  NO  → investigate shared evidence first, then spawn for remaining unknowns
          NO  → investigate sequentially (one root cause often explains multiple symptoms)
```

**Real decomposition example:** "today's picks have no rationale AND odds are stale AND the pick-pipeline route times out" could be three threads (LLM misconfig / odds cache miss / route maxDuration) OR one root cause (one Function instance hits resource limit and bails). Gather initial evidence before forking.

**Do NOT spawn sub-debuggers** for 5-minute tasks (grep a log, check a known failure mode).

Cap parallel sub-debuggers at 3. Recursive depth 2.

---

## Step 5 — Safety rails

- **Do NOT mutate production Supabase rows.** Read only. If a fix requires `update` / `insert` / `delete` against prod → "Needs user's approval."
- **Do NOT deploy.** No `vercel deploy --prod`, no prod promotion.
- **Do NOT run ingesters against live odds** for "testing." Use cached fixtures. Live odds burn credits.
- **Do NOT kill a shared process** (e.g., the user's local dev server) without flagging.
- **Do NOT touch compliance surfaces as a "fix."** Age gate / geo-block / disclaimer changes need legal review → "Needs user's approval."
- **Do NOT edit production-applied migrations** — they're immutable. Fix-forward with a new migration.

---

## Step 6 — Output format

```markdown
## Root cause
{One paragraph. Name the mechanism, not just the symptom.}

## Evidence
- {file path / line / log timestamp / row state / command output}
- ...

## Recommended fix
{Concrete change. Name the files. Note trade-offs.}

## Safety assessment
Safe to apply | Needs review | Needs user's approval — and why.

## Open questions
{Anything you couldn't fully answer. Empty is fine.}
```

---

## Non-negotiables

- Never invent a root cause without evidence. "I couldn't isolate this with available evidence; recommend instrumenting X and retrying after next repro" is valid.
- Never push to git.
- Never apply fixes that touch real subscriber data, prod migrations, or compliance surfaces without user approval.
- Never deploy.
