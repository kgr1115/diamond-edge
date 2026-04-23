# Vercel Project Setup Notes

**Updated:** 2026-04-22
**Author:** mlb-devops

---

## Custom Domain — diamond-edge.co

`diamond-edge.co` is the primary domain (purchased 2026-04-23 via Cloudflare registrar).

**Status: PURCHASED. DNS / Vercel wiring pending — see `docs/runbooks/domain-migration-diamond-edge-co.md` for the operational checklist.**

Summary of remaining wiring (full steps in runbook):

1. Vercel dashboard: Project → Settings → Domains → Add `diamond-edge.co` and `www.diamond-edge.co`.
2. Cloudflare DNS: A record `@ → 76.76.21.21`, CNAME `www → cname.vercel-dns.com` (both DNS-only / gray cloud).
3. Add to `supabase/config.toml` → `additional_redirect_urls` (already in the file comments; Supabase dashboard must mirror).
4. Update `NEXT_PUBLIC_APP_URL` in Vercel env vars to `https://diamond-edge.co`.
5. Stripe webhook endpoint + Customer Portal return URL updated in dashboard.
6. Verify SSL auto-provisions (Vercel handles this via Let's Encrypt).

---

## Vercel Plan — Pro Required

**Decision: Vercel Pro ($20/mo) is required from day 1.**

**Reasons:**
1. **Cron jobs:** Hobby tier limits to 2 cron jobs maximum. Diamond Edge requires 6 cron schedule entries (4 routes, some with split UTC schedules). Hobby cannot support this.
2. **Function timeout:** Pro allows up to 60s function execution. Hobby is 10s. While cron route handlers themselves are designed to complete in <10s (they trigger async Supabase Edge Functions), having the 60s headroom is insurance for outcome-grader and odds-refresh on high-game-count days.

**Cost impact:** +$20/mo vs Hobby. Documented in `docs/infra/cost-projection.md`.

---

## Vercel GitHub Integration Setup (required manual step)

The Vercel GitHub integration handles deploy-on-push. There is no deploy step in CI — Vercel does it automatically.

**One-time setup (done by Kyle in Vercel dashboard):**

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import the `Baseball_Edge` GitHub repository.
3. Configure project settings:
   - **Framework Preset:** Next.js
   - **Root Directory:** `apps/web`
   - **Build Command:** `next build` (or leave as detected)
   - **Install Command:** `npm install`
4. Set all environment variables per `docs/infra/secrets-manifest.md`.
5. Enable "Deploy on push to main" (default behavior).
6. Vercel will also create Preview Deployments for every PR — useful for QA.

---

## Cron Schedule Reference (all times UTC, tuned for EDT = UTC-4)

| Route | Schedule(s) | ET equivalent | Purpose |
|---|---|---|---|
| `/api/cron/odds-refresh` | `0,30 12-23 * * *` | 8am–7:30pm EDT every 30 min | Odds pull, daytime window |
| `/api/cron/odds-refresh` | `0,30 0-3 * * *` | 8pm–11:30pm EDT every 30 min | Odds pull, evening window |
| `/api/cron/schedule-sync` | `0 10 * * *` | 6am EDT | Morning schedule sync |
| `/api/cron/schedule-sync` | `0 17 * * *` | 1pm EDT | Afternoon schedule sync |
| `/api/cron/pick-pipeline` | `0 12 * * *` | 8am EDT | Daily pick generation |
| `/api/cron/outcome-grader` | `0 8 * * *` | 4am EDT | Grade overnight results |

**Note:** Schedules are tuned for EDT (UTC-4), active during baseball season (April–October). In EST (November–March), these shift 1 hour. Since there is no MLB activity in the off-season, this is acceptable.

**Note:** The `odds-refresh` route handler must short-circuit immediately (return 200 with no API call) outside active game hours. The two cron entries provide full coverage of the 8am–11pm ET window with no off-hours API calls.

---

## Vercel Environment Variable Setup

Environment variables must be set for three Vercel environments:
- **Production** — live site, real API keys
- **Preview** — used for PR preview deployments
- **Development** — used when running `vercel dev` locally

For most secrets, use:
- Production: real prod values (Stripe live key, prod Supabase project)
- Preview: staging/test values (Stripe test key, staging Supabase project)
- Development: local values (local Supabase, Stripe test key)

See `docs/infra/secrets-manifest.md` for the full variable list.
