# TASK-009 Integration Notes — Stripe Billing

**Author:** mlb-backend
**Date:** 2026-04-22

---

## 1. Product Seeding

Run once per environment (dev, staging, prod) to create the Pro and Elite products and prices in Stripe. Never run this against prod until staging is verified.

### Prerequisites

- `STRIPE_SECRET_KEY` set in your shell (test key for dev/staging, live key for prod).
- Node 18+ (ships with `npx`).

### Command

```bash
# From repo root
cd apps/web
STRIPE_SECRET_KEY=sk_test_... npx tsx lib/stripe/products.ts
```

The script is idempotent: running it twice does not create duplicate products. It searches for existing products by the `diamond_edge_tier` metadata key and reuses them.

### After running

Copy the printed price IDs into Vercel Environment Variables:

```
STRIPE_PRICE_PRO=price_XXXXXXXXXX
STRIPE_PRICE_ELITE=price_XXXXXXXXXX
```

Set them per environment (staging, prod) in Vercel Dashboard → Project → Settings → Environment Variables.

---

## 2. Stripe Billing Portal Configuration

Before going live, configure the Stripe Billing Portal in the dashboard so users get the right options when they click "Manage subscription".

Steps:
1. Go to Stripe Dashboard → Settings → Billing → Customer portal.
2. Under **Functionality**, enable:
   - **Payment method update**: Yes — users should be able to update their card.
   - **Subscription cancellation**: Yes — users can cancel. Set cancellation to "At end of period" (not immediately).
   - **Plan switching**: Optional for v1. If enabled, limit to Pro ↔ Elite only (not to Free — downgrading to Free is handled by cancellation + webhook).
3. Under **Business information**, fill in your business name and support email.
4. Save. The portal session URL is generated dynamically at runtime via `POST /api/billing/portal`.

---

## 3. Webhook Endpoint Registration

The webhook handler lives at `POST /api/webhooks/stripe`. Register it in the Stripe Dashboard.

### Staging

1. Stripe Dashboard → Developers → Webhooks → Add endpoint.
2. URL: `https://<staging-vercel-url>/api/webhooks/stripe`
3. Events to listen for:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Copy the signing secret (`whsec_...`) → set as `STRIPE_WEBHOOK_SECRET` in Vercel staging env vars.

### Production

Same steps, use the production Vercel URL. Use a separate webhook signing secret.

---

## 4. Local Testing with Stripe CLI

Use the Stripe CLI to forward webhook events to your local dev server and to trigger test events.

### Install the Stripe CLI

```bash
# macOS
brew install stripe/stripe-cli/stripe

# Windows (winget)
winget install Stripe.StripeCLI
```

### Forward webhooks to local dev

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

This prints a local webhook signing secret (`whsec_...`). Set it as `STRIPE_WEBHOOK_SECRET` in your `.env.local`.

### Trigger test events

```bash
# Simulate a new subscription (e.g., user subscribes to Pro)
stripe trigger customer.subscription.created

# Simulate a subscription update (e.g., plan change)
stripe trigger customer.subscription.updated

# Simulate cancellation
stripe trigger customer.subscription.deleted

# Simulate payment failure
stripe trigger invoice.payment_failed
```

### Test card numbers

Use these in Stripe-hosted checkout (test mode only):

| Card | Scenario |
|---|---|
| `4242 4242 4242 4242` | Successful payment |
| `4000 0000 0000 0002` | Card declined |
| `4000 0025 0000 3155` | 3D Secure authentication required |

Expiry: any future date. CVC: any 3 digits. ZIP: any 5 digits.

---

## 5. Integration Points for TASK-008 (Frontend)

The frontend (TASK-008) wires up to these routes:

| Action | Frontend Component | API Route |
|---|---|---|
| User clicks "Upgrade to Pro" | `upgrade-cta.tsx` | `POST /api/billing/checkout` with `{ tier: "pro" }` |
| User clicks "Go Elite" | `upgrade-cta.tsx` | `POST /api/billing/checkout` with `{ tier: "elite" }` |
| User clicks "Manage subscription" | Link/button on `/pricing` | `POST /api/billing/portal` → redirect to returned `url` |
| After successful checkout | `/billing/success` page | Reads `session_id` query param; displays "Subscription activated!" |

The checkout route returns `{ url: string }`. The frontend should `window.location.href = url` to redirect to the Stripe-hosted checkout page.

The portal route also returns `{ url: string }`. Same redirect pattern.

---

## 6. Auth Flow Notes

Both `/api/billing/checkout` and `/api/billing/portal` require a valid Supabase session JWT. The frontend must call these routes with the session active (e.g., after the user is signed in). If the session has expired, the routes return `401` and the frontend should redirect to `/login`.

The geo-block check in the checkout route reads `profiles.geo_blocked`. If the user was geo-blocked at middleware level, they should never see the pricing page — but the API enforces it as a secondary layer.
