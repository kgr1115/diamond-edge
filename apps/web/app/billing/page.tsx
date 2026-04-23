import { redirect } from 'next/navigation';

/**
 * /billing redirects to /pricing, which is the canonical subscription management surface.
 * The Stripe billing portal link lives on /pricing for authenticated users on paid tiers.
 */
export default function BillingPage() {
  redirect('/pricing');
}
