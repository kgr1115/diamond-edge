# Diamond Edge — Secrets Manifest

**Updated:** 2026-04-22
**Author:** mlb-devops

All secrets live in Vercel Environment Variables (server-side only) or Supabase Vault (Edge Function runtime).
**Nothing in code. Nothing in the client bundle. No exceptions.**

Other agents: add your required env vars as a PR to this file when you introduce them.

---

## Rules

- Variables prefixed `NEXT_PUBLIC_` are safe to expose to the browser — they appear in the client bundle. Use only for truly public values (Supabase anon key, Stripe publishable key, app URL).
- All other variables are server-only. Vercel will refuse to expose non-`NEXT_PUBLIC_` vars to the client bundle by default.
- `SUPABASE_SERVICE_ROLE_KEY` is god-mode access to the database. It bypasses RLS. Scope its use to server-side route handlers and Edge Functions only. Audit any PR that adds a new usage.
- Rotate all secrets annually and immediately on any suspected exposure.
- The Supabase anon key is NOT a secret (it enforces RLS, not authentication), but treat it as configuration, not a password.

---

## Variable Inventory

### Application Secrets (Vercel Environment Variables)

| Variable | Purpose | Client bundle safe? | Environments | Owner |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project REST endpoint. Used by browser Supabase client. | ✅ Yes | dev, staging, prod | mlb-devops |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key. Enforces RLS. Safe in browser. | ✅ Yes | dev, staging, prod | mlb-devops |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key. Bypasses RLS. Server-only. Never expose to browser. | ❌ Server-only | staging, prod | mlb-devops |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key. Used by Stripe.js in the browser. | ✅ Yes | staging, prod | mlb-devops |
| `STRIPE_SECRET_KEY` | Stripe secret key for server-side API calls (create sessions, webhooks). | ❌ Server-only | staging, prod | mlb-devops |
| `STRIPE_WEBHOOK_SECRET` | Verifies Stripe webhook signatures in `/api/webhooks/stripe`. | ❌ Server-only | staging, prod | mlb-devops |
| `ODDS_API_KEY` | The Odds API authentication key. | ❌ Server-only | staging, prod | mlb-devops |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key for LLM rationale generation. | ❌ Server-only | staging, prod | mlb-devops |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint URL. | ❌ Server-only | dev, staging, prod | mlb-devops |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST auth token. | ❌ Server-only | dev, staging, prod | mlb-devops |
| `CRON_SECRET` | Shared secret for all `/api/cron/*` route handlers. Prevents unauthorized cron triggers. Must be a cryptographically random string (min 32 chars). | ❌ Server-only | staging, prod | mlb-devops |
| `GEO_ALLOW_STATES` | Comma-separated list of allowed US state codes for geo-gate. | ❌ Server-only | staging, prod | mlb-devops |
| `NEXT_PUBLIC_APP_URL` | Canonical app URL (e.g., `https://diamondedge.ai`). Used for absolute URLs in emails and OG meta. | ✅ Yes | staging, prod | mlb-devops |

---

### CI/CD Secrets (GitHub Actions Secrets)

Set in: GitHub → Repository → Settings → Secrets and variables → Actions

| Secret | Purpose | Set in |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI personal access token for migrations CI. | GitHub Actions secrets |
| `STAGING_SUPABASE_PROJECT_REF` | Staging Supabase project reference ID (find in Supabase → Settings → General). | GitHub Actions secrets |
| `STAGING_SUPABASE_DB_PASSWORD` | Staging database password (set during project creation). | GitHub Actions secrets |
| `PROD_SUPABASE_PROJECT_REF` | Production Supabase project reference ID. | GitHub Actions secrets |
| `PROD_SUPABASE_DB_PASSWORD` | Production database password. | GitHub Actions secrets |
| `NEXT_PUBLIC_SUPABASE_URL_STAGING` | Used in CI build step to satisfy Next.js build-time env validation. | GitHub Actions secrets |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY_STAGING` | Same purpose — staging values used for build verification. | GitHub Actions secrets |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Used in CI build; staging/test publishable key is safe for CI. | GitHub Actions secrets |

---

### Supabase Vault (Edge Function Runtime Secrets)

Supabase Edge Functions cannot read Vercel env vars. They use Supabase Vault.
Set via: Supabase Dashboard → Edge Functions → Manage secrets (or `supabase secrets set`)

| Secret | Purpose | Edge Functions that use it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key for pick rationale generation inside Edge Functions. | `pick-pipeline` |
| `ODDS_API_KEY` | The Odds API key if odds-refresh moves to an Edge Function. | `odds-refresh` (if applicable) |
| `UPSTASH_REDIS_REST_URL` | Redis URL for cache invalidation after pipeline writes. | `pick-pipeline`, `outcome-grader` |
| `UPSTASH_REDIS_REST_TOKEN` | Redis token for the above. | `pick-pipeline`, `outcome-grader` |

Note: The Supabase service role key is NOT in Vault — Edge Functions have native Supabase access via `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` which is automatically injected by the Supabase runtime.

---

### Fly.io Secrets (Worker Runtime)

Set via: `fly secrets set KEY=VALUE -a diamond-edge-worker`
Never committed to fly.toml or any tracked file.

| Secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key for LLM rationale in the Fly.io worker (if deployed). |
| `SUPABASE_URL` | Supabase project URL for DB writes from the worker. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for DB access from the worker. |
| `UPSTASH_REDIS_REST_URL` | Redis URL for cache invalidation after worker completes. |
| `UPSTASH_REDIS_REST_TOKEN` | Redis token for the above. |

---

## Environment Values by Environment

| Variable | dev (local) | staging | prod |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `http://localhost:54321` | Staging Supabase URL | Prod Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Local anon key (in supabase/config.toml) | Staging anon key | Prod anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Local service role key | Staging service role key | Prod service role key |
| `STRIPE_SECRET_KEY` | Stripe test key (`sk_test_...`) | Stripe test key (`sk_test_...`) | Stripe live key (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Local (stripe CLI) `whsec_...` | Staging `whsec_...` | Prod `whsec_...` |
| `UPSTASH_REDIS_REST_URL` | Dev Upstash URL | Shared dev/staging Upstash URL | Prod Upstash URL |
| `CRON_SECRET` | Any string (local dev) | Random 32-char string | Random 32-char string (rotate annually) |
| `GEO_ALLOW_STATES` | All states (dev — disable geo-block) | AZ,AR,CO,CT,DC,IL,IN,IA,KS,KY,LA,MD,MA,MI,MO,NJ,NY,NC,OH,PA,TN,VT,VA,WV,WY | Same as staging |

---

## Secret Generation Commands

```bash
# Generate a secure CRON_SECRET
openssl rand -hex 32

# Generate a secure random string for any secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Rotation Schedule

| Secret | Rotation frequency | Rotation trigger |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Annually | Immediately on suspected exposure |
| `STRIPE_SECRET_KEY` | Annually | Immediately on suspected exposure |
| `STRIPE_WEBHOOK_SECRET` | When Stripe endpoint is recreated | — |
| `ODDS_API_KEY` | Annually | Immediately on suspected exposure |
| `ANTHROPIC_API_KEY` | Annually | Immediately on suspected exposure |
| `CRON_SECRET` | Annually | Immediately on suspected exposure |
| `UPSTASH_REDIS_REST_TOKEN` | Annually | — |

---

## Adding a New Variable (checklist for other agents)

1. Add the variable to this manifest with: name, purpose, client-safe flag, environments, owner.
2. Add it to Vercel env vars (for each environment it applies to).
3. If used in Edge Functions: add to Supabase Vault via `supabase secrets set`.
4. If used in Fly.io worker: add via `fly secrets set`.
5. If needed in CI: add to GitHub Actions secrets.
6. If needed at Next.js build time: add to the `build` job in `.github/workflows/ci.yml`.
7. PR the manifest change. Owner signs off.
