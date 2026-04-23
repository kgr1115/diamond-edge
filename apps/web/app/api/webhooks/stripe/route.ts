import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { stripe, tierFromPriceId } from '@/lib/stripe/client';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { SubscriptionTier } from '@/lib/types/database';

// Stripe sends the raw body for signature verification — disable body parsing
export const runtime = 'nodejs';

/**
 * Idempotent upsert of a subscription row + profile tier update.
 * Called for both `customer.subscription.created` and `.updated`.
 */
async function handleSubscriptionUpsert(sub: Stripe.Subscription): Promise<void> {
  const serviceClient = createServiceRoleClient();

  // Resolve user by stripe_customer_id
  const customerId = sub.customer as string;
  const { data: profile, error: profileError } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (profileError || !profile) {
    console.error({
      event: 'stripe_webhook_user_not_found',
      stripe_customer_id: customerId,
      stripe_sub_id: sub.id,
    });
    // Return without throwing — 200 to Stripe to stop retries on an unfixable error
    return;
  }

  const priceId = sub.items.data[0]?.price.id ?? '';
  const resolvedTier: SubscriptionTier = tierFromPriceId(priceId) ?? 'free';

  const now = new Date().toISOString();

  // Upsert subscriptions row — idempotent on stripe_sub_id
  const { error: subError } = await serviceClient
    .from('subscriptions')
    .upsert(
      {
        user_id: profile.id,
        stripe_sub_id: sub.id,
        stripe_price_id: priceId,
        tier: resolvedTier,
        status: sub.status,
        current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
        current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        cancel_at_period_end: sub.cancel_at_period_end,
        canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
        updated_at: now,
      },
      { onConflict: 'stripe_sub_id' }
    );

  if (subError) {
    console.error({ event: 'stripe_webhook_sub_upsert_failed', stripe_sub_id: sub.id, error: subError });
    throw new Error('subscription upsert failed');
  }

  // Update profile tier — Stripe webhook is the source of truth
  const { error: tierError } = await serviceClient
    .from('profiles')
    .update({ subscription_tier: resolvedTier, updated_at: now })
    .eq('id', profile.id);

  if (tierError) {
    console.error({ event: 'stripe_webhook_tier_update_failed', user_id: profile.id, error: tierError });
    throw new Error('profile tier update failed');
  }

  console.info({
    event: 'stripe_subscription_synced',
    user_id: profile.id,
    stripe_sub_id: sub.id,
    tier: resolvedTier,
    status: sub.status,
  });
}

/**
 * Handle subscription deletion — downgrade to free tier.
 */
async function handleSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
  const serviceClient = createServiceRoleClient();
  const customerId = sub.customer as string;

  const { data: profile } = await serviceClient
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!profile) {
    console.warn({ event: 'stripe_webhook_delete_user_not_found', stripe_customer_id: customerId });
    return;
  }

  const now = new Date().toISOString();

  await serviceClient
    .from('subscriptions')
    .update({
      status: 'canceled',
      tier: 'free',
      canceled_at: now,
      updated_at: now,
    })
    .eq('stripe_sub_id', sub.id);

  await serviceClient
    .from('profiles')
    .update({ subscription_tier: 'free', updated_at: now })
    .eq('id', profile.id);

  console.info({ event: 'stripe_subscription_canceled', user_id: profile.id, stripe_sub_id: sub.id });
}

/**
 * Log payment failure. Do NOT immediately downgrade — Stripe handles retries and
 * will send `customer.subscription.updated` with status `past_due` / `canceled`
 * once the retry cycle is exhausted.
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  console.warn({
    event: 'stripe_invoice_payment_failed',
    stripe_customer_id: invoice.customer as string,
    invoice_id: invoice.id,
    amount_due: invoice.amount_due,
    attempt_count: invoice.attempt_count,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    console.warn({ event: 'stripe_webhook_missing_signature' });
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Missing Stripe-Signature header.' } },
      { status: 400 }
    );
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    console.error({ event: 'stripe_webhook_signature_failed', err });
    return NextResponse.json(
      { error: { code: 'SIGNATURE_INVALID', message: 'Webhook signature verification failed.' } },
      { status: 400 }
    );
  }

  console.info({ event: 'stripe_webhook_received', type: event.type, id: event.id });

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpsert(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      default:
        // Acknowledge unhandled events — do not return an error to Stripe
        console.info({ event: 'stripe_webhook_unhandled', type: event.type });
    }
  } catch (err) {
    // Internal processing error — return 500 so Stripe retries (all handlers are idempotent)
    console.error({ event: 'stripe_webhook_processing_error', type: event.type, err });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Webhook processing failed.' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
