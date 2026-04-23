import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type CheckoutBody = {
  tier: 'pro' | 'elite';
};

/** Resolve the Stripe price ID for a given tier from env vars. */
function priceIdForTier(tier: 'pro' | 'elite'): string | undefined {
  return tier === 'pro'
    ? process.env.STRIPE_PRICE_PRO
    : process.env.STRIPE_PRICE_ELITE;
}

/** Build an idempotency key scoped to user + tier + UTC date. Prevents duplicate sessions
 *  when users navigate away from Stripe checkout and try again the same day. */
function idempotencyKey(userId: string, tier: string): string {
  const date = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  return `checkout:${userId}:${tier}:${date}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate via Supabase session JWT
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } },
      { status: 401 }
    );
  }

  // 2. Parse and validate request body
  let body: CheckoutBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } },
      { status: 400 }
    );
  }

  if (body.tier !== 'pro' && body.tier !== 'elite') {
    return NextResponse.json(
      { error: { code: 'UNPROCESSABLE_ENTITY', message: 'tier must be "pro" or "elite".' } },
      { status: 422 }
    );
  }

  // 3. Check geo-block via profiles table (secondary enforcement after middleware)
  const serviceClient = createServiceRoleClient();
  const { data: profile, error: profileError } = await serviceClient
    .from('profiles')
    .select('id, email, geo_blocked, stripe_customer_id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    console.error({ event: 'checkout_profile_fetch_failed', user_id: user.id, error: profileError });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Unable to load user profile.' } },
      { status: 500 }
    );
  }

  if (profile.geo_blocked) {
    return NextResponse.json(
      { error: { code: 'GEO_BLOCKED', message: 'Diamond Edge is not available in your location.' } },
      { status: 403 }
    );
  }

  // 4. Resolve Stripe price ID
  const priceId = priceIdForTier(body.tier);
  if (!priceId) {
    console.error({ event: 'checkout_price_id_missing', tier: body.tier });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Pricing configuration error.' } },
      { status: 500 }
    );
  }

  const stripe = getStripe();
  let stripeCustomerId = profile.stripe_customer_id;

  // 5. Create Stripe customer if this user doesn't have one yet
  if (!stripeCustomerId) {
    try {
      const customer = await stripe.customers.create({
        email: profile.email,
        metadata: { supabase_user_id: user.id },
      });
      stripeCustomerId = customer.id;

      // Persist the new stripe_customer_id to the profile immediately
      const { error: updateError } = await serviceClient
        .from('profiles')
        .update({ stripe_customer_id: stripeCustomerId, updated_at: new Date().toISOString() })
        .eq('id', user.id);

      if (updateError) {
        console.error({ event: 'checkout_customer_persist_failed', user_id: user.id, error: updateError });
        // Non-fatal: checkout will still work — customer ID persists via webhook
      } else {
        console.info({ event: 'stripe_customer_created', user_id: user.id, stripe_customer_id: stripeCustomerId });
      }
    } catch (err) {
      console.error({ event: 'stripe_customer_create_failed', user_id: user.id, err });
      return NextResponse.json(
        { error: { code: 'STRIPE_ERROR', message: 'Unable to initialize billing.' } },
        { status: 500 }
      );
    }
  }

  // 6. Create Stripe Checkout session (hosted, subscription mode)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/pricing`,
        // Allow promotion codes for future discount campaigns
        allow_promotion_codes: true,
        metadata: {
          supabase_user_id: user.id,
          tier: body.tier,
        },
      },
      {
        // Idempotency key: same user + tier + day → same session (prevents duplicates)
        idempotencyKey: idempotencyKey(user.id, body.tier),
      }
    );

    if (!session.url) {
      throw new Error('Stripe returned a session without a URL.');
    }

    console.info({ event: 'checkout_session_created', user_id: user.id, tier: body.tier, session_id: session.id });

    return NextResponse.json({ url: session.url }, { status: 200 });
  } catch (err) {
    console.error({ event: 'stripe_checkout_create_failed', user_id: user.id, tier: body.tier, err });
    return NextResponse.json(
      { error: { code: 'STRIPE_ERROR', message: 'Unable to create checkout session.' } },
      { status: 500 }
    );
  }
}
