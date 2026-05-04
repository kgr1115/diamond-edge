# TASK-006 â€” DevOps Provisioning

**Agent:** mlb-devops
**Phase:** 1
**Date issued:** 2026-04-22
**Status:** In progress

---

## Objective

Provision Vercel + Supabase + Upstash projects across dev/staging/prod environments, write the GitHub Actions CI skeleton, set up secrets management, and wire a cost dashboard â€” all within the $300/mo budget envelope ($79/mo already committed to The Odds API, leaving ~$221/mo for everything else).

---

## Context

- Domain: `diamond-edge.co` purchased 2026-04-23 (supersedes the earlier `diamondedge.ai` plan). DNS + Vercel wiring tracked in `docs/runbooks/domain-migration-diamond-edge-co.md`. USPTO trademark clearance remains the pre-launch gate.
- Repo root: `C:\AI\Public\diamond-edge`. No GitHub repo exists yet â€” you may need to create it or assume it exists. If GitHub repo needs to be created, flag to orchestrator.
- Three environments: dev (local Supabase), staging (Supabase project + Vercel preview), prod (Supabase project + Vercel production). Each gets its own Supabase project and its own set of secrets.
- Secrets philosophy: Vercel env vars for app secrets (SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, ODDS_API_KEY, etc.). Supabase Vault for any secrets the Edge Functions need at runtime. Nothing in code, nothing in client bundle.
- Upstash: one Redis instance shared across environments is acceptable for dev/staging. Prod gets its own instance. Configure max monthly budget alert at $20/mo.
- Fly.io: provision a minimal `fly.toml` skeleton for the ML/LLM inference worker â€” even if TASK-005 hasn't confirmed the runtime yet, scaffold it so it's ready. Use the smallest viable instance (1 shared CPU, 256MB RAM as starting point). If TASK-005 confirms Edge Function is sufficient, Fly.io skeleton stays but isn't deployed.
- Vercel plan: start with Hobby tier to confirm whether 10s function timeout is sufficient. Flag to orchestrator if any route from api-contracts-v1.md exceeds 10s (particularly the pick pipeline trigger and LLM rationale generation). If Pro is needed, cost delta is ~$20/mo â€” document and flag.
- Budget remaining after The Odds API ($79/mo): ~$221/mo. Your spend must keep total < $300/mo.

---

## Inputs

- `CLAUDE.md` â€” locked stack, budget envelope
- `docs/adr/ADR-001-repo-structure.md` â€” folder layout to wire CI against
- `docs/schema/caching-strategy.md` â€” Upstash usage patterns (informs Redis tier selection)
- `docs/api/api-contracts-v1.md` â€” cron routes to register in `vercel.json`

---

## Deliverable Format

Config files and documentation committed to `C:\AI\Public\diamond-edge`:

1. **`vercel.json`** â€” Vercel project config:
   - Cron job definitions: `/api/cron/odds-refresh` (every 30 min, 8amâ€“11pm ET), `/api/cron/schedule-sync` (2x/day: 6am and 1pm ET), `/api/cron/pick-pipeline` (1x/day: 8am ET), `/api/cron/outcome-grader` (1x/day: 4am ET)
   - Function timeout overrides if any route needs >10s
   - TODO comment for custom domain wiring (diamond-edge.co â€” purchased 2026-04-23, DNS pending)

2. **`.github/workflows/ci.yml`** â€” GitHub Actions CI:
   - Triggers: push to `main`, pull request to `main`
   - Jobs: `lint` (ESLint), `type-check` (tsc --noEmit), `test` (Vitest or Jest, if tests exist), `build` (next build)
   - Node version: 20 LTS
   - Run jobs in parallel where possible
   - On merge to main: trigger Vercel deploy (via Vercel GitHub integration, not a manual curl â€” just document that the integration must be set up)

3. **`.github/workflows/migrations.yml`** â€” Supabase migration safety:
   - On PR: validate migration files with `supabase db diff` (dry run check)
   - On merge to main: apply migrations to staging automatically
   - Prod migrations: manual trigger only (safety gate) â€” document the command in the workflow as a commented-out step

4. **`worker/fly.toml`** â€” Fly.io ML worker skeleton (per ADR-001, worker config lives in `worker/`):
   - App name: `diamond-edge-worker` (or equivalent)
   - 1 shared CPU, 256MB RAM (smallest viable; ML agent may upsize)
   - Health check endpoint: `GET /health`
   - Scale to zero when not in use (important for cost control â€” document how)

5. **`docs/runbooks/`** â€” Three runbooks:
   - `odds-ingestion-lag.md` â€” what to do if odds haven't refreshed in >1 hour
   - `pick-pipeline-failure.md` â€” what to do if no picks appear by 10am ET
   - `cost-spike.md` â€” what to do if Vercel/Supabase/Upstash spend spikes unexpectedly

6. **`docs/infra/cost-projection.md`** â€” Cost breakdown:
   - Per service: Vercel, Supabase, Upstash, Fly.io, Anthropic (LLM estimate), The Odds API
   - At <100 users, <500 users
   - Total vs. $300/mo envelope
   - Which services have hard caps or overage risk

7. **`docs/infra/secrets-manifest.md`** â€” Complete list of all env vars:
   - Variable name, purpose, which service holds it (Vercel env / Supabase Vault / both), which environments it applies to
   - Populated with known vars from TASK-003 + TASK-004 + anticipated Stripe + Anthropic vars
   - Template: other agents add their required vars as they produce them

8. **`supabase/config.toml`** (if not already written by TASK-003 â€” coordinate):
   - Dev project config with auth settings, storage settings

---

## Definition of Done

- [ ] `vercel.json` exists with all four cron jobs scheduled at the specified cadences.
- [ ] `.github/workflows/ci.yml` runs lint + type-check + build in CI.
- [ ] `.github/workflows/migrations.yml` has dry-run check on PR and auto-apply on merge to staging.
- [ ] `worker/fly.toml` skeleton committed (deploy not required â€” just the config file).
- [ ] Three runbooks exist in `docs/runbooks/`.
- [ ] `docs/infra/cost-projection.md` shows total projected spend at <500 users < $300/mo.
- [ ] `docs/infra/secrets-manifest.md` lists all known env vars with their home (Vercel env vs. Supabase Vault) and which environments they apply to.
- [ ] Upstash $20/mo budget alert configured (document the step to do this in the Upstash console â€” you may not be able to automate it via config).
- [ ] Vercel plan decision documented: Hobby sufficient, OR Pro required with cost delta.
- [ ] Domain purchase explicitly flagged as deferred in `vercel.json` comment and `cost-projection.md`.
- [ ] No secrets committed to the repo in any file.

---

## Dependencies

**Requires (before starting):**
- `docs/adr/ADR-001-repo-structure.md` â€” DONE (TASK-001): folder structure known
- `docs/api/api-contracts-v1.md` â€” DONE (TASK-001): cron routes defined

**Partial dependency (can start without, update when available):**
- TASK-005 runtime decision (Fly.io vs. Edge) â€” scaffold both; update fly.toml when TASK-005 resolves

**This task unblocks:**
- All agents: once secrets-manifest.md exists, other agents know what env vars to expect
- TASK-003 (backend): staging Supabase project needed to validate migrations against a real instance
- TASK-007 (AI Reasoning): Anthropic API key must be in secrets manifest
- Launch: prod infrastructure must be provisioned before QA can run E2E tests

**New env vars you own / introduce:**
- `CRON_SECRET` â€” shared secret for all Vercel Cron route handlers
- `NEXT_PUBLIC_SUPABASE_URL` â€” Supabase project URL (public, safe in client bundle)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` â€” Supabase anon key (public, safe in client bundle)
- `SUPABASE_SERVICE_ROLE_KEY` â€” server-only, never in client bundle
- `GEO_ALLOW_STATES` â€” comma-separated state codes: AZ,AR,CO,CT,DC,IL,IN,IA,KS,KY,LA,MD,MA,MI,MO,NJ,NY,NC,OH,PA,TN,VT,VA,WV,WY
- `STRIPE_PUBLISHABLE_KEY` â€” public
- `STRIPE_SECRET_KEY` â€” server-only
- `STRIPE_WEBHOOK_SECRET` â€” server-only
- `ODDS_API_KEY` â€” server-only
- `ANTHROPIC_API_KEY` â€” server-only
- `UPSTASH_REDIS_REST_URL` â€” server-only
- `UPSTASH_REDIS_REST_TOKEN` â€” server-only
