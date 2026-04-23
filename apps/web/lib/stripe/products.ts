/**
 * Stripe product/price setup utility for Diamond Edge.
 *
 * Run once per environment to create the Pro and Elite products in Stripe:
 *   npx ts-node --project tsconfig.json apps/web/lib/stripe/products.ts
 *
 * Or, for local dev without ts-node:
 *   npx tsx apps/web/lib/stripe/products.ts
 *
 * Requires STRIPE_SECRET_KEY in your environment. Use the test key for staging.
 *
 * After running, copy the printed price IDs into Vercel env vars:
 *   STRIPE_PRICE_PRO=price_XXXXXXXXXX
 *   STRIPE_PRICE_ELITE=price_XXXXXXXXXX
 *
 * ──────────────────────────────────────────────────────────────────────────
 * EQUIVALENT STRIPE DASHBOARD STEPS (if you prefer manual setup):
 * ──────────────────────────────────────────────────────────────────────────
 * 1. Go to Stripe Dashboard → Products → Add product
 * 2. Product 1 — Diamond Edge Pro
 *    - Name: "Diamond Edge Pro"
 *    - Pricing: Recurring, $19.00 USD, Monthly
 *    - Save the price ID (starts with price_) → set as STRIPE_PRICE_PRO
 * 3. Product 2 — Diamond Edge Elite
 *    - Name: "Diamond Edge Elite"
 *    - Pricing: Recurring, $39.00 USD, Monthly
 *    - Save the price ID → set as STRIPE_PRICE_ELITE
 * 4. Set both price IDs in Vercel:
 *    Vercel Dashboard → Project → Settings → Environment Variables
 * ──────────────────────────────────────────────────────────────────────────
 */

import Stripe from 'stripe';

const PRODUCTS = [
  {
    name: 'Diamond Edge Pro',
    description: 'Full pick analysis, line shopping, and AI rationale for every pick.',
    metadataKey: 'diamond_edge_tier',
    metadataValue: 'pro',
    unitAmountCents: 1900, // $19.00
    envVar: 'STRIPE_PRICE_PRO',
  },
  {
    name: 'Diamond Edge Elite',
    description: 'Everything in Pro plus SHAP attribution, Sonnet-powered rationale, and unlimited bankroll tracking.',
    metadataKey: 'diamond_edge_tier',
    metadataValue: 'elite',
    unitAmountCents: 3900, // $39.00
    envVar: 'STRIPE_PRICE_ELITE',
  },
] as const;

/**
 * Create Diamond Edge Pro and Elite Stripe products and prices.
 *
 * Idempotent: if a product with the same metadata key/value already exists,
 * the existing price ID is returned instead of creating a duplicate.
 *
 * Returns the price IDs to set as STRIPE_PRICE_PRO and STRIPE_PRICE_ELITE.
 */
export async function createStripeProducts(): Promise<{
  proPrice: string;
  elitePrice: string;
}> {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-02-24.acacia',
    typescript: true,
  });

  const results: Record<string, string> = {};

  for (const product of PRODUCTS) {
    // Check if a product with this tier metadata already exists
    const existingProducts = await stripe.products.search({
      query: `metadata["diamond_edge_tier"]:"${product.metadataValue}"`,
    });

    let stripeProductId: string;

    if (existingProducts.data.length > 0) {
      stripeProductId = existingProducts.data[0].id;
      console.log(`[idempotent] Product "${product.name}" already exists: ${stripeProductId}`);
    } else {
      const created = await stripe.products.create({
        name: product.name,
        description: product.description,
        metadata: {
          [product.metadataKey]: product.metadataValue,
          environment: process.env.NODE_ENV ?? 'development',
        },
      });
      stripeProductId = created.id;
      console.log(`[created] Product "${product.name}": ${stripeProductId}`);
    }

    // Check if an active recurring monthly price already exists for this product
    const existingPrices = await stripe.prices.list({
      product: stripeProductId,
      active: true,
      type: 'recurring',
    });

    const matchingPrice = existingPrices.data.find(
      (p) =>
        p.unit_amount === product.unitAmountCents &&
        p.currency === 'usd' &&
        p.recurring?.interval === 'month'
    );

    let priceId: string;

    if (matchingPrice) {
      priceId = matchingPrice.id;
      console.log(`[idempotent] Price for "${product.name}" already exists: ${priceId}`);
    } else {
      const price = await stripe.prices.create({
        product: stripeProductId,
        unit_amount: product.unitAmountCents,
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: { diamond_edge_tier: product.metadataValue },
      });
      priceId = price.id;
      console.log(`[created] Price for "${product.name}": ${priceId}`);
    }

    results[product.envVar] = priceId;
    console.log(`\nSet in Vercel env vars:\n  ${product.envVar}=${priceId}\n`);
  }

  return {
    proPrice: results['STRIPE_PRICE_PRO'],
    elitePrice: results['STRIPE_PRICE_ELITE'],
  };
}

// Allow direct execution: npx tsx apps/web/lib/stripe/products.ts
if (require.main === module) {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('Error: STRIPE_SECRET_KEY env var is required.');
    process.exit(1);
  }

  createStripeProducts()
    .then(({ proPrice, elitePrice }) => {
      console.log('\n=== DONE ===');
      console.log('Copy these into your Vercel environment variables:');
      console.log(`STRIPE_PRICE_PRO=${proPrice}`);
      console.log(`STRIPE_PRICE_ELITE=${elitePrice}`);
    })
    .catch((err) => {
      console.error('Failed to create Stripe products:', err);
      process.exit(1);
    });
}
