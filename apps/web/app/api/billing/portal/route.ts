import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe/client';
import { paidTiersEnabled } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Suppress unused warning — request is required by Next.js route signature
  void request;

  // Portfolio mode: 404 — same opacity as a non-existent route.
  if (!paidTiersEnabled()) {
    return new NextResponse(null, { status: 404 });
  }

  // 1. Authenticate via Supabase session JWT
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } },
      { status: 401 }
    );
  }

  // 2. Fetch the user's stripe_customer_id
  const serviceClient = createServiceRoleClient();
  const { data: profile, error: profileError } = await serviceClient
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    console.error({ event: 'portal_profile_fetch_failed', user_id: user.id, error: profileError });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Unable to load user profile.' } },
      { status: 500 }
    );
  }

  // 3. Guard: user must have an existing Stripe customer to open the portal
  if (!profile.stripe_customer_id) {
    return NextResponse.json(
      {
        error: {
          code: 'NO_SUBSCRIPTION',
          message: 'No active subscription found. Please subscribe first.',
        },
      },
      { status: 400 }
    );
  }

  // 4. Create a Stripe Billing Portal session
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  try {
    const portalSession = await getStripe().billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      // After the user finishes in the portal, redirect them back to the pricing page
      return_url: `${appUrl}/pricing`,
    });

    console.info({
      event: 'billing_portal_session_created',
      user_id: user.id,
      stripe_customer_id: profile.stripe_customer_id,
    });

    return NextResponse.json({ url: portalSession.url }, { status: 200 });
  } catch (err) {
    console.error({ event: 'stripe_portal_create_failed', user_id: user.id, err });
    return NextResponse.json(
      { error: { code: 'STRIPE_ERROR', message: 'Unable to open billing portal.' } },
      { status: 500 }
    );
  }
}
