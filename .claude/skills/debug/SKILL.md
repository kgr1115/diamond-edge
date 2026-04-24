---
name: debug
description: "Diagnose broken or unexpected Diamond Edge behavior — worker crashes, partial pick runs, Edge Function timeouts, webhook misfires, RLS denials, LLM failures, odds-API rate-limits, UI regressions. Invoked by the debugger agent on FAIL or directly. Maps symptoms to evidence sources, encodes known failure modes, defines when to fork sub-debuggers."
argument-hint: <symptom description>
---

Symptom: `$ARGUMENTS`

---

## Step 0 — State the symptom precisely

Rephrase as one sentence of observable behavior before touching any files.

- Bad: "the pipeline seems broken"
- Good: "Edge Function `pick-pipeline` logs 3 game inserts then a 502; no picks inserted for today"

---

## Step 1 — Map symptom to evidence source

| Symptom class | Go-to evidence |
|---|---|
| No picks for today | `picks` table in Supabase; Edge Function logs for `pick-pipeline`; Fly.io worker `/health`; Upstash cache key for today's slate; MLB Stats API response for today's games |
| Pipeline partially ran | `pipeline_runs` / run-state table in Supabase; Edge Function logs; Fly.io worker logs; compare expected stage count vs last-complete-stage |
| Pick rationale missing or weird | Anthropic API call logs in Fly.io worker; pick row rationale fields; prompt-cache hit rate; rationale-generation code path |
| Odds data stale / missing | Upstash key for odds snapshot; The Odds API credit usage in provider dashboard; ingester log; last-fetch timestamp |
| ML prediction looks off | `worker/models/*/artifacts/` for deployed model version; run `/check-feature-gap`; recent backtest report |
| Stripe webhook failed | Stripe dashboard → Webhooks → recent events; signature-check log in API route; DB idempotency key table |
| Supabase RLS denial | Supabase logs; `select * from pg_policies where tablename = '<table>';`; auth-user's JWT claims |
| UI regression | Browser devtools console; Next.js dev-server log; recent commits to affected route; Vercel build log |
| Auth / sign-in broken | Supabase Auth logs; Next.js middleware log; cookies in browser; RLS policy test |
| Geo-block misfire | Middleware logs; IP-to-state mapping source; state-availability list in compliance doc |
| Stuck Fly.io worker | `fly logs`, `fly status`; machine resource graph; process list inside VM |
| Runaway token cost | Anthropic dashboard; prompt-cache hit rate; per-pick token budget; recent model-routing changes (Haiku ↔ Sonnet by accident?) |

---

## Step 2 — Known failure modes (F-table)

### F1. Odds-API credit burn from cold fetch in render path

**Symptom:** The Odds API monthly credit drops unusually fast.
**Cause:** A code path hits The Odds API without the Upstash cache wrapper — often a new render path or cron forgot the cache layer.
**Check:** Grep for direct `the-odds-api.com` calls or odds-provider client instantiations outside `lib/odds/`.
**Fix:** Route through the cache wrapper. TTL ≥5 min pre-game, 30–60s live. Confirm no `bypassCache: true` flag slipped in.

### F2. Vercel function timeout on Edge Function work

**Symptom:** API route returns 504 or truncated response; the same work completes when run directly against the Supabase Edge Function.
**Cause:** Work longer than 10s default / 60s configured is in a Vercel API route.
**Check:** Time the operation; compare against function-timeout config.
**Fix:** Move heavy work to Supabase Edge Function (<~150s) or Fly.io worker (no cap).

### F3. Supabase RLS blocking legit query after schema change

**Symptom:** Query returns empty in prod but works for service role.
**Cause:** Migration added a column/table but RLS policy wasn't updated.
**Check:** `select * from pg_policies where tablename = '<table>';`. Diff against migration.
**Fix:** Update policy in a follow-up migration. Never disable RLS as a fix.

### F4, F5, ... add as incidents happen.

---

## Step 3 — Gather evidence before forming hypotheses

1. **Logs first.** Tail Edge Function logs, Fly.io worker logs, Next.js dev log, Vercel function logs. Look for `ERROR`, `FAILED`, `crashed`, timestamps that stop too early.
2. **DB state.** Open Supabase, query the relevant tables directly. Read-only.
3. **Cache state.** Read Upstash keys for today's slate / odds / tier cache.
4. **Process list.** For stuck workers or runaway loops — `fly status`, Vercel function metrics.
5. **Return codes / exit status.** If a script or function ran, find its exit code. Non-zero → read stderr.
6. **External dashboards.** The Odds API credit, Anthropic token usage, Stripe events, Supabase project metrics.

---

## Step 4 — Decision tree for spawning sub-debuggers

```
Single component (one route, one function, one worker endpoint)?
  YES → investigate directly. No sub-debugger.
  NO  → does it split into independent sub-investigations?
          YES → each needs different evidence sources?
                  YES → spawn one sub-debugger per investigation
                  NO  → investigate shared evidence first, then spawn for remaining unknowns
          NO  → investigate sequentially (one root cause often explains multiple symptoms)
```

**Real decomposition example:** "today's picks have no rationale AND odds are stale AND worker keeps restarting" could be three threads (LLM misconfig / odds cache miss / Fly.io resource limit) OR one root cause (worker OOM killing everything mid-pipeline). Gather initial evidence before forking.

**Do NOT spawn sub-debuggers** for 5-minute tasks (grep a log, check a known failure mode).

Cap parallel sub-debuggers at 3. Recursive depth 2.

---

## Step 5 — Safety rails

- **Do NOT mutate production Supabase rows.** Read only. If a fix requires `update` / `insert` / `delete` against prod → "Needs user's approval."
- **Do NOT deploy.** No `supabase functions deploy`, no `fly deploy`, no prod promotion.
- **Do NOT run ingesters against live odds** for "testing." Use cached fixtures. Live odds burn credits.
- **Do NOT kill a shared process** (e.g., the user's local dev server) without flagging.
- **Do NOT kill a Fly.io worker** unless it's visibly stuck (age > 30 min with no output change). Document PID and age first.
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
