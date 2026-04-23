# Domain migration: → `diamond-edge.co`

**Purchased:** 2026-04-23 via Cloudflare registrar.
**Supersedes:** the earlier plan to use `diamondedge.ai`.

Code-side URLs in the repo have already been updated (see the commit that lands this runbook). The steps below are the manual console/registrar work that only Kyle can do.

---

## 1. Vercel — add the domain

Dashboard: https://vercel.com/kgr1115/diamond-edge/settings/domains

1. **Add Domain** → `diamond-edge.co` → Add
2. **Add Domain** → `www.diamond-edge.co` → Add (select "Redirect to `diamond-edge.co`")
3. Vercel will show DNS record requirements (for .co: A record on apex + CNAME on www). Note the target values.
4. Status will stay "Invalid Configuration" until Cloudflare DNS resolves (see step 2).

## 2. Cloudflare — DNS records

Dashboard: Cloudflare → `diamond-edge.co` → DNS → Records.

| Type | Name | Content | Proxy | TTL |
|------|------|---------|-------|-----|
| A | `@` | `76.76.21.21` | **DNS only (gray cloud)** | Auto |
| CNAME | `www` | `cname.vercel-dns.com` | **DNS only (gray cloud)** | Auto |

**Critical:** both records must be **DNS only**, not Proxied. Vercel handles SSL and apex/www redirects; Cloudflare's proxy in front causes redirect loops and SSL handshake failures.

Leave Cloudflare's Email Routing untouched if already set up — it doesn't conflict with DNS-only mode.

Propagation: usually 2–10 min on Cloudflare. Refresh the Vercel domain page; it should flip to "Valid Configuration" and auto-provision a Let's Encrypt cert.

## 3. Supabase — auth redirect URLs

Dashboard: https://supabase.com/dashboard → project → Authentication → URL Configuration.

1. **Site URL** → `https://diamond-edge.co`
2. **Redirect URLs** → add:
   - `https://diamond-edge.co/**`
   - `https://www.diamond-edge.co/**`
3. Keep `https://diamond-edge-beryl.vercel.app/**` for now so already-issued magic links still resolve; remove after 7 days.

## 4. Stripe — webhook + portal

Dashboard: https://dashboard.stripe.com/webhooks

1. Open the existing webhook endpoint (the one ending in `/api/stripe/webhook`) → Edit → URL → `https://diamond-edge.co/api/stripe/webhook`
2. Save. The signing secret does not change; no redeploy needed.

Customer Portal: https://dashboard.stripe.com/settings/billing/portal → **Business settings → Default return URL** → `https://diamond-edge.co/account`. Save.

## 5. Vercel env vars

Dashboard: https://vercel.com/kgr1115/diamond-edge/settings/environment-variables

1. Update **`NEXT_PUBLIC_APP_URL`** → `https://diamond-edge.co` (Production + Preview scopes).
2. Redeploy prod (push any commit or hit "Redeploy" on the latest deployment).

## 6. pg_cron — rewrite Supabase cron job bodies

From the repo root, with `.env` populated:

```bash
node scripts/run-migrations/setup-pg-cron-inline.mjs
```

This re-issues `cron.schedule(...)` calls with the new `https://diamond-edge.co` URL baked in. Idempotent — safe to re-run.

## 7. Smoke test

1. Open `https://diamond-edge.co` → should load the app, not Cloudflare "Invalid SSL" / Vercel 404.
2. Magic-link sign-in: request a code, click the email link → must land on `diamond-edge.co`, not `diamond-edge-beryl.vercel.app`.
3. `https://diamond-edge.co/api/picks/today` → returns JSON (403 if anon/geo-blocked, 200 if signed in — either is fine, confirms the route is live on the new hostname).
4. Stripe test webhook: `stripe listen --forward-to https://diamond-edge.co/api/stripe/webhook` → triggers should deliver 2xx.
5. Confirm any Supabase scheduled job has fired against the new URL (Cron → Job Runs in the Supabase dashboard).

## 8. Clean up (after 7+ days on the new domain)

- Remove `https://diamond-edge-beryl.vercel.app/**` from Supabase redirect URLs.
- Keep the `*.vercel.app` URL itself working (Vercel auto-assigns and can't be removed) — it's harmless once Supabase stops trusting it.
