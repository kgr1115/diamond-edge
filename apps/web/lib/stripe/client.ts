import Stripe from 'stripe';

// Stripe client — server-only. Never import in client bundles.
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
  typescript: true,
});

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
