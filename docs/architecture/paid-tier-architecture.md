# Paid-tier architecture (preserved at `v0.1-paid-tiers`)

The portfolio cut of this repo (the current `main` branch) runs Diamond Edge as a free, no-auth, no-billing informational service. Earlier in the build, Diamond Edge was scoped as a paid SaaS with three subscription tiers (Free / Pro / Elite), Supabase Auth-backed sign-up, Stripe-managed billing, RLS-enforced tier gating, a 21+ age gate, and US-state-level geo-blocking. That work is preserved at git tag [`v0.1-paid-tiers`](https://github.com/kgr1115/diamond-edge/releases/tag/v0.1-paid-tiers); this document explains what it looks like for portfolio viewers who don't want to clone the tag.

The decision to drop the paid-tier surfaces from `main` is documented in [the README](../../README.md#why-the-paid-tier-ui-got-dropped-from-the-portfolio-cut). Briefly: legal posture is meaningfully simpler for a free informational service vs. a paid tout, and the model architecture / agent scaffolding / calibration / snapshot-pinning work demonstrates engineering judgment more clearly than a Stripe webhook handler does.

This document is a tour, not a reference. Files referenced are at the tag, not necessarily on `main`.

---

## Tier structure

Three subscription tiers, each unlocking a defined slice of pick-detail content:

| Tier | $/mo | Sees | Doesn't see |
|---|---|---|---|
| Free / Anon | $0 | Pick side, confidence tier, game time, line-locked banner | Best-line price + book, EV, model probability, AI rationale, SHAP attributions, line-movement sparkline, line-snapshot history |
| Pro | $15 | Free + best-line price + book + EV + model probability + Haiku-authored 3–5-sentence rationale citing 2–3 SHAP features | Sonnet rationale, full SHAP attribution table, line-movement sparkline, line-snapshot history |
| Elite | $40 | Pro + Sonnet-authored paragraph rationale citing ≥5 SHAP features + full SHAP attribution table + line-movement sparkline + line-snapshot history | (full slate visible) |

The tier model was deliberately minimal. Two paid tiers (Pro + Elite); no add-ons; no per-pick pricing; no consumable units. Pricing-page copy lived in `apps/web/app/pricing/`.

The pick-pipeline was scoped at design time to never emit `required_tier='free'` picks — Free-tier subscribers see the same set of LIVE picks as Pro/Elite subscribers, with tier-gated fields masked out by the slate loader (`apps/web/lib/picks/load-slate.ts::maskPick`) and a per-pick "Unlock full analysis" upsell rendered in place of the locked content (`apps/web/components/picks/pick-card.tsx::PickCard` paywall branch). This keeps the slate visually consistent across tiers and makes the value proposition for upgrade obvious in-context, instead of behind an empty state.

The decision rationale is in [`docs/briefs/TASK-010-pre-pick-pipeline.md`](../briefs/TASK-010-pre-pick-pipeline.md): "There are no free-tier published picks from the pipeline. Free and anon users see the same live picks on the slate with tier-gated fields (price, rationale, EV, SHAP, line snapshots) masked by `maskPick` and the `PickCard` paywall teaser rendered in place of the locked content."

---

## Sign-up + auth

**Sign-up flow:**

1. User lands on `/auth/signup` (or the modal version that opens from any pick-detail paywall click)
2. Email + password (Supabase Auth's email-OTP variant — no password reset hell)
3. **21+ age confirmation step** — checkbox + date-of-birth picker; validated client + server (server-side enforcement is the source of truth, client is a UX courtesy)
4. **Geo-block check** — IP-derived state from Vercel headers (`x-vercel-ip-country-region`); if state is not in the DK + FanDuel-legal overlap list, sign-up returns a friendly "we're not available in your state yet" page rather than letting the user pay for a service they can't legally access
5. Sign-up completes → user lands on the slate at Free tier; pricing page is the upsell path

**Auth flow:**

- Supabase Auth handles JWT issuance + refresh
- Server components read the session via the Supabase server client; client components via the browser client
- RLS policies on every user-scoped table enforce read/write authorization at the database level (defense-in-depth — the API route can have a bug and the database still enforces ownership)
- Middleware (`apps/web/middleware.ts`) handles geo-block + 21+ gate enforcement at the edge for unauthenticated visitors trying to access pick surfaces directly

**Files at the tag:**

- `apps/web/app/auth/signup/page.tsx`, `apps/web/app/auth/login/page.tsx`, `apps/web/app/auth/callback/route.ts`
- `apps/web/lib/auth/server.ts`, `apps/web/lib/auth/client.ts`
- `apps/web/middleware.ts` (geo-block + age-gate enforcement)
- `apps/web/app/age-gate/page.tsx`, `apps/web/app/geo-blocked/page.tsx`

---

## Stripe + billing

**Subscription provisioning:**

1. User clicks "Upgrade to Pro" or "Upgrade to Elite" on `/pricing` or in any pick-detail paywall
2. POST to `/api/billing/checkout` creates a Stripe Checkout Session pinned to the selected price ID; user is redirected to Stripe's hosted checkout
3. On successful payment, Stripe fires `checkout.session.completed` to the webhook
4. Webhook validates the `Stripe-Signature` header against the webhook secret (the FIRST thing the handler does, before any body parsing)
5. Webhook idempotent-upserts the subscription state into the `subscriptions` table and updates `profiles.subscription_tier` for the user
6. Next render of any pick surface reflects the new tier

**Webhook events handled:**

- `checkout.session.completed` — initial subscription
- `customer.subscription.updated` — tier changes (Pro ↔ Elite, paused/resumed)
- `customer.subscription.deleted` — cancellation; flips `profiles.subscription_tier` back to `free` at the period-end
- `invoice.payment_failed` — soft-warn the user; don't immediately downgrade (Stripe's retry path handles dunning)

**What the audit caught (queued for cycle 3 if the paid tiers ever come back):**

The Stripe webhook audit at [`docs/audits/stripe-webhook-audit-2026-04-24.md`](../audits/stripe-webhook-audit-2026-04-24.md) flagged that there's no event-id idempotency ledger. Out-of-order replays of `subscription.updated` after `subscription.deleted` could re-activate a canceled subscription. Fix shape (queued for cycle 3): a `stripe_events` ledger table keyed on `event.id` with a `processed_at` column; webhook checks the ledger before processing, no-ops on duplicate.

**Files at the tag:**

- `apps/web/app/api/billing/checkout/route.ts`
- `apps/web/app/api/webhooks/stripe/route.ts`
- `apps/web/lib/stripe/server.ts`, `apps/web/lib/stripe/client.ts`
- `apps/web/app/pricing/page.tsx`

---

## Tier gating (RLS + masking)

Tier gating happens at three layers, defense-in-depth:

1. **Database (RLS policies on `picks`, `pick_outcomes`, `pick_clv`):** the `anon` role and the `authenticated` role have different `SELECT` policies. The `anon` policy allows reading the rows but not the columns themselves — column masking happens in application code. (RLS in Postgres can do row-level filtering well; column-level masking is awkward, so it's done at the loader level.)
2. **Loader (`apps/web/lib/picks/load-slate.ts::maskPick`):** for each pick the loader fetched, it checks the requesting user's tier and zeros out (or replaces with `null`) the fields they don't have access to. The pick row leaves the loader with only the fields the user is entitled to see.
3. **Component (`apps/web/components/picks/pick-card.tsx`):** the PickCard reads the (already-masked) pick row. If `pick.best_line_price === undefined`, the card knows the user isn't entitled and renders the upgrade-CTA paywall in place of the locked content.

**Why three layers:**

- A bug at the loader (e.g., forgets to mask a field) is caught by the component (paywall renders even though the field is set, because the tier check fails). Defense in depth.
- A bug at the component (e.g., renders a field even when masked) is caught by the loader (the field is `undefined`, nothing to render). Same shape, opposite direction.
- A bug at both is caught by RLS at the database (anon can't read the row at all under a deny-by-default policy).

The full RLS policy state was audited in [`docs/audits/rls-audit-2026-04-24.md`](../audits/rls-audit-2026-04-24.md). Two P0 findings: (a) the `profiles` GRANT UPDATE allowed authenticated users to PATCH their own `subscription_tier` to `elite`, bypassing Stripe entirely (the tier column should be service-role-only writable); (b) the picks-journal PATCH route wrote to a shared row with no per-user ownership check. Both were queued for fix-in-place if the paid tiers were going to ship.

---

## 21+ age gate

The age gate was implemented as middleware (`apps/web/middleware.ts`) that runs on every pick-surface route and redirects to `/age-gate` if the user's age has not been confirmed in the current session.

**Confirmation flow:**

1. First visit to a pick surface → middleware redirects to `/age-gate`
2. User enters DOB (or just confirms 21+ checkbox); server validates DOB ≥ 21 years ago
3. Confirmation persists via a `age_confirmed_at` column on the user's profile (or, for anon users, a session cookie with a 30-day expiry)
4. Subsequent visits skip the redirect

**Compliance audit caught a real bug:** the privacy policy page told users "we store the date you verified, not your raw DOB" — but the actual age-gate spec stored the full DOB. Direct legal disclosure contradiction. Fix-in-place would be either (a) update the spec to match the policy (don't store DOB, only the verification date), or (b) update the policy to match the spec (disclose DOB storage). Documented in [`docs/audits/compliance-copy-audit-2026-04-24.md`](../audits/compliance-copy-audit-2026-04-24.md).

For the portfolio cut, the age gate was dropped because (a) it's not strictly required for a free informational service and (b) it's a friction layer that doesn't add portfolio-review value — the interesting engineering is elsewhere. The age-gate middleware is preserved at the tag.

---

## Geo-block

The geo-block was middleware-enforced (`apps/web/middleware.ts`) and read the user's state from Vercel's `x-vercel-ip-country-region` header. Allowed states were configured via the `GEO_ALLOW_STATES` env var (a comma-separated list, defaulted to the DK + FanDuel-legal overlap).

**Allowed-state list logic:**

- DraftKings is legal in ~25 US states (the list shifts as states pass / repeal sports betting laws)
- FanDuel is legal in ~22 US states (similar shift)
- The intersection is ~20 states; that intersection was the v1 launch geography
- States outside the intersection redirect to `/geo-blocked` with copy explaining the situation

**The audit caught a real bug here too:** the `/geo-blocked` page listed Tennessee as a supported state, but the middleware's `DEFAULT_ALLOW_STATES` constant was missing TN. A Tennessee user would see "your state is supported" while being blocked. Documented + queued for fix in [`docs/audits/compliance-copy-audit-2026-04-24.md`](../audits/compliance-copy-audit-2026-04-24.md).

For the portfolio cut, the geo-block was dropped because it's based on DraftKings/FanDuel partnership norms, not Diamond Edge's legal need as a free informational service. Pick recommendations don't fall under per-state sports betting jurisdiction the same way bet placement does.

---

## Bankroll tracking

The bankroll was a per-user feature: subscribers entered their starting bankroll, logged bets they placed (against picks they'd seen), and the dashboard tracked their personal ROI over time. Required auth because each user's bankroll is private state.

**Schema:**

- `bankrolls` table: `user_id`, `starting_units`, `current_units`, `created_at`, `updated_at`
- `bets` table: `user_id`, `pick_id` (FK), `units_staked`, `result` ('pending' | 'win' | 'loss' | 'push' | 'void'), `pnl_units`, `placed_at`

**UI:**

- `/bankroll` page — server-rendered dashboard with current units, lifetime ROI, last 30 days delta, list of recent bets with W/L/P chips
- "Track this bet" CTA on every pick card (Pro+ only) — opens a modal with units-staked input, defaults to a Kelly-fraction recommendation based on EV
- Delete-bet flow with confirmation and undo

**Decision (queued for cycle 3 if paid tiers come back):** the bankroll feature was useful but inseparable from auth. Two options for a portfolio cut:

- **(a) Drop bankroll entirely** — what the portfolio cut does. Cleanest demo.
- **(b) Move bankroll to localStorage** — anyone can use it; per-device persistence. Useful for showing the feature without requiring auth.

Option (a) was chosen for tightest scope; option (b) is queued for the next polish pass if the bankroll feature would meaningfully strengthen the portfolio.

---

## What the portfolio cut keeps from this work

Even with the paid-tier UI dropped from `main`, much of the work above is still useful in the portfolio cut:

- **`maskPick` logic** still exists — it just always passes through (every viewer is treated as anon-equivalent or Pro-equivalent, depending on the flag). Code is still readable as a reference for how column-masking-on-top-of-RLS works.
- **The slate loader's snapshot-pinning** is unchanged — that was a correctness fix, not a tier-gating fix.
- **The pick-detail page** still renders rationale + SHAP + line-movement sparkline; it just renders them for everyone instead of paywalling them.
- **The line-locked treatment** is unchanged — it's UX, not auth.
- **The compliance copy** (responsible-gambling footer, "informational only" framing) is unchanged.

The dropped surfaces are: `/auth/*`, `/age-gate`, `/geo-blocked`, `/pricing`, `/bankroll`, `/api/billing/*`, `/api/webhooks/stripe`. The middleware that enforced age + geo gating is no-op'd in the portfolio cut.

---

## How to browse the paid-tier code

```bash
git fetch --tags
git checkout v0.1-paid-tiers
```

That checks out the snapshot of the repo with all paid-tier surfaces intact. You can also browse it on GitHub: https://github.com/kgr1115/diamond-edge/tree/v0.1-paid-tiers (replace with the actual repo URL if it's different).

If you want to actually run the paid-tier version locally, you'll need to set up:

- Stripe test-mode API keys + a webhook secret
- Supabase Auth configured (the migrations create the `auth` schema state Supabase needs)
- A Vercel project with the `x-vercel-ip-country-region` header populated (or stub the geo middleware to allow your dev state)
- The `ADMIN_USER_IDS` env var set to your local user UUID (for `/admin/pipelines` access)

The full setup instructions for the paid-tier version are in [`docs/infra/secrets-manifest.md`](../infra/secrets-manifest.md) at the tag.

---

## Why this document exists

For a portfolio viewer evaluating my engineering: yes, I built the auth / Stripe / tier-gate / geo-block / age-gate stack. The reason it isn't on `main` isn't that I didn't get to it — it's that I made an explicit call (documented above + in the README) to ship the version of the product that demonstrates the most interesting engineering judgment. The auth + billing wiring is competent but unsurprising; the model architecture, the calibration pipeline, the snapshot-pinning, the agent-pipeline scaffolding, the latent-bug debugging cascade — those are the bits I'd want a hiring reviewer to spend time on.

If you want to talk through any of the above, [my email + LinkedIn are at the top of the README](../../README.md).
