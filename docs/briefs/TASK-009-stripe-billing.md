# TASK-009 — Stripe Billing: Checkout, Portal, Products

**Agent:** mlb-backend
**Phase:** 2
**Date issued:** 2026-04-22
**Status:** Ready to start

---

## Objective

Complete the Stripe billing integration: create the Diamond Edge Pro ($19/mo) and Elite ($39/mo) Stripe products/prices, implement the checkout session creation route, implement the customer portal redirect route, and update the secrets manifest — all backfill-safe against the Stripe webhook already wired in TASK-003.

---

## Context

- **Stripe webhook is already implemented** in `apps/web/app/api/webhooks/stripe/route.ts`. It handles `customer.subscription.created`, `.updated`, `.deleted`, and `invoice.payment_failed`. Your work must be additive — do not touch the webhook handler.
- **`tierFromPriceId` in `apps/web/lib/stripe/client.ts`** maps `STRIPE_PRICE_PRO` and `STRIPE_PRICE_ELITE` env vars to subscription tiers. Your Stripe products must use price IDs stored in these env vars. The env var names are already defined in `docs/infra/secrets-manifest.md` (they are NOT yet listed there — you must add them).
- **Pricing (locked):** Free (no Stripe product needed), Pro $19.00/mo USD recurring, Elite $39.00/mo USD recurring. Do not change these amounts.
- **Products to create (in code, not just the Stripe dashboard):** Use the Stripe API to create products and prices programmatically in a seeding script, OR document the exact dashboard steps precisely. Either way, the price IDs must end up in Vercel env vars as `STRIPE_PRICE_PRO` and `STRIPE_PRICE_ELITE`.
- **Customer creation:** When a user initiates checkout, look up `profiles.stripe_customer_id`. If null, create a Stripe customer first (email from Supabase auth), persist `stripe_customer_id` to `profiles`, then create the checkout session. This prevents duplicate customers.
- **Checkout session:** Stripe-hosted checkout (not custom payment form). Return the session URL for the frontend to redirect to. After successful payment, Stripe webhook fires `customer.subscription.created` which updates the DB. No additional post-checkout handling needed beyond the webhook.
- **Customer portal:** Stripe Billing Portal (hosted). Return the portal URL for the frontend to redirect to. The portal handles plan changes, cancellations, and payment method updates — these all come back through webhooks.
- **Auth on routes:** Both `/api/billing/checkout` and `/api/billing/portal` require authentication (Supabase session JWT). Return 401 if unauthenticated. Return 403 if the user's profile is geo-blocked.
- **Idempotency:** `POST /api/billing/checkout` may be called multiple times if the user navigates away from checkout. Use Stripe's `idempotency_key` header (keyed on `user_id + target_tier + date`) to prevent duplicate sessions.
- **Success/cancel URLs:**
  - `success_url`: `{NEXT_PUBLIC_APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`
  - `cancel_url`: `{NEXT_PUBLIC_APP_URL}/pricing`
- **`/billing/success` page:** Not in scope for TASK-009 — TASK-008 (Frontend) handles it. You just need the route to exist as a redirect target. Coordinate with TASK-008 to ensure the page renders "Subscription activated!" and routes the user to `/picks/today`.

---

## Inputs

- `apps/web/app/api/webhooks/stripe/route.ts` — existing webhook (read-only, do not modify)
- `apps/web/lib/stripe/client.ts` — existing Stripe client and `tierFromPriceId` function
- `apps/web/lib/types/database.ts` — profile and subscription types
- `apps/web/lib/supabase/server.ts` — server-side Supabase client
- `docs/infra/secrets-manifest.md` — add new env vars here
- `docs/api/api-contracts-v1.md` — see existing pattern for auth and error shapes
- `CLAUDE.md` — locked constraints

---

## Deliverable Format

### 1. `apps/web/app/api/billing/checkout/route.ts`

`POST /api/billing/checkout`

**Auth:** Required (Supabase session JWT)

**Request body:**
```typescript
{
  tier: 'pro' | 'elite';
}
```

**Behavior:**
1. Validate auth and geo-block status.
2. Validate `tier` is `'pro'` or `'elite'`.
3. Look up `profiles.stripe_customer_id` for the authenticated user.
4. If `stripe_customer_id` is null: create Stripe customer with user's email, persist to `profiles`.
5. Resolve the correct `stripe_price_id` from env (`STRIPE_PRICE_PRO` or `STRIPE_PRICE_ELITE`).
6. Create Stripe checkout session (mode: `'subscription'`).
7. Return `{ url: string }` — the Stripe-hosted checkout URL.

**Error responses** (use standard error envelope from `docs/api/api-contracts-v1.md`):
- 401: not authenticated
- 403: geo-blocked
- 422: invalid tier value
- 500: Stripe API error (log, return generic message)

**Response 200:**
```typescript
{ url: string }
```

### 2. `apps/web/app/api/billing/portal/route.ts`

`POST /api/billing/portal`

**Auth:** Required

**Request body:** (none required — user identified by session)

**Behavior:**
1. Validate auth.
2. Look up `profiles.stripe_customer_id`. If null → 400 (no subscription exists; user should go through checkout first).
3. Create Stripe Billing Portal session.
4. Return `{ url: string }`.

**Response 200:**
```typescript
{ url: string }
```

**Error responses:**
- 401: not authenticated
- 400: no stripe_customer_id on profile (not yet a customer)
- 500: Stripe API error

### 3. `apps/web/lib/stripe/products.ts`

A seeding/setup utility (not a route):

```typescript
// Stripe product/price setup utility
// Run once per environment: npx ts-node apps/web/lib/stripe/products.ts
// Or run manually via Stripe Dashboard — see comments for equivalent dashboard steps

export async function createStripeProducts(): Promise<{ proPrice: string; elitePrice: string }>
```

- Creates products "Diamond Edge Pro" and "Diamond Edge Elite" in Stripe.
- Creates prices: $19.00/mo and $39.00/mo, USD, recurring monthly.
- Prints the price IDs to stdout so they can be set as env vars.
- Idempotent: if products/prices already exist (by metadata lookup), prints existing IDs instead.
- Include a comment block documenting the equivalent Stripe Dashboard steps for manual setup.

### 4. Secrets manifest update (`docs/infra/secrets-manifest.md`)

Add these entries to the Application Secrets table:

| Variable | Purpose | Client bundle safe? | Environments | Owner |
|---|---|---|---|---|
| `STRIPE_PRICE_PRO` | Stripe price ID for Diamond Edge Pro ($19/mo). Set after running product seeding script. | No (server-only) | staging, prod | mlb-backend |
| `STRIPE_PRICE_ELITE` | Stripe price ID for Diamond Edge Elite ($39/mo). Set after running product seeding script. | No (server-only) | staging, prod | mlb-backend |

Also add a Fly.io secrets section note: these vars are not needed in Fly.io worker (worker does not call Stripe).

### 5. Integration notes document (`docs/briefs/TASK-009-integration-notes.md`)

A short (1–2 page) document covering:
- How to run the product seeding script (dev vs. staging vs. prod)
- How to configure the Stripe Billing Portal in the dashboard (which features to enable: plan switching on/off, cancellation, payment method update)
- Stripe webhook endpoint registration steps (staging and prod)
- The test card numbers to use in local/staging (`4242 4242 4242 4242`)
- How to trigger webhook events locally with the Stripe CLI (`stripe trigger customer.subscription.created`)

---

## Definition of Done

- [ ] `POST /api/billing/checkout` creates a Stripe checkout session and returns a redirect URL.
- [ ] `POST /api/billing/portal` creates a portal session and returns a redirect URL.
- [ ] Both routes require auth and return 401 for unauthenticated requests.
- [ ] Customer creation is idempotent: calling checkout twice for the same user does not create duplicate Stripe customers.
- [ ] `tierFromPriceId` in `apps/web/lib/stripe/client.ts` resolves Pro and Elite correctly (may require adding the price IDs to test env; document this).
- [ ] `STRIPE_PRICE_PRO` and `STRIPE_PRICE_ELITE` are added to `docs/infra/secrets-manifest.md`.
- [ ] Product seeding script or dashboard documentation is present and accurate.
- [ ] No TypeScript errors (`tsc --noEmit`).
- [ ] Webhook handler in `apps/web/app/api/webhooks/stripe/route.ts` is NOT modified.
- [ ] Integration notes document covers local testing with Stripe CLI.
- [ ] Routes follow the error envelope pattern from `docs/api/api-contracts-v1.md`.

---

## Dependencies

**Requires:**
- `apps/web/lib/stripe/client.ts` — DONE (TASK-003)
- `apps/web/app/api/webhooks/stripe/route.ts` — DONE (TASK-003): must not be modified
- `apps/web/lib/types/database.ts` — DONE (TASK-003)
- `apps/web/lib/supabase/server.ts` — DONE (TASK-003)
- `docs/infra/secrets-manifest.md` — DONE (TASK-006): update it, do not rewrite it

**Does NOT require:**
- TASK-008 (Frontend) — frontend wires the CTA; you just need to deliver the API routes
- TASK-007 or TASK-010 — no dependency

**This task unblocks:**
- TASK-008 Frontend: upgrade CTA can call `/api/billing/checkout` once this route exists

**Coordination:**
- After this is complete, notify orchestrator so TASK-008 can enable the upgrade CTA (currently stubbed with a TODO comment per TASK-008 brief).
