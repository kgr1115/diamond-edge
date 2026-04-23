import Stripe from 'stripe';

// Lazy singleton — Stripe constructor requires STRIPE_SECRET_KEY which is only
// available at request time in Vercel's environment. Do not initialize at module
// load time (breaks `next build`'s static analysis phase).
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2025-02-24.acacia',
      typescript: true,
    });
  }
  return _stripe;
}

/**
 * Map a Stripe price ID to a subscription tier.
 * Price IDs come from env vars so they can differ across environments.
 * Unknown price IDs return null — callers should handle this defensively.
 */
export function tierFromPriceId(priceId: string): 'pro' | 'elite' | null {
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId === process.env.STRIPE_PRICE_ELITE) return 'elite';
  return null;
}
