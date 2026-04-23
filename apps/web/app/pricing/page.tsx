import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';
import { UpgradeCta } from '@/components/billing/upgrade-cta';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

async function getCurrentTier(): Promise<string | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, stripe_customer_id')
    .eq('id', user.id)
    .single();
  return profile?.subscription_tier ?? null;
}

const TIERS = [
  {
    key: 'free',
    name: 'Free',
    price: '$0',
    period: 'no card required',
    description: 'Get a feel for Diamond Edge with limited daily picks.',
    features: [
      { label: 'Pick side + confidence tier', included: true },
      { label: 'Daily picks (limited)', included: true },
      { label: 'Public pick history', included: true },
      { label: 'Best line + sportsbook', included: false },
      { label: 'Model probability', included: false },
      { label: 'AI rationale (Haiku)', included: false },
      { label: 'Expected value', included: false },
      { label: 'SHAP attributions', included: false },
      { label: 'Bankroll tracker', included: false },
    ],
  },
  {
    key: 'pro',
    name: 'Pro',
    price: '$19',
    period: '/month',
    description: 'Full access to picks with line shopping and AI analysis.',
    highlighted: true,
    features: [
      { label: 'Pick side + confidence tier', included: true },
      { label: 'All qualifying picks daily', included: true },
      { label: 'Public pick history', included: true },
      { label: 'Best line + sportsbook', included: true },
      { label: 'Model probability', included: true },
      { label: 'AI rationale (Haiku)', included: true },
      { label: 'Expected value', included: false },
      { label: 'SHAP attributions', included: false },
      { label: 'Bankroll tracker', included: true },
    ],
  },
  {
    key: 'elite',
    name: 'Elite',
    price: '$39',
    period: '/month',
    description: 'Everything in Pro plus deep model transparency.',
    features: [
      { label: 'Pick side + confidence tier', included: true },
      { label: 'All qualifying picks daily', included: true },
      { label: 'Public pick history', included: true },
      { label: 'Best line + sportsbook', included: true },
      { label: 'Model probability', included: true },
      { label: 'AI rationale (Sonnet)', included: true },
      { label: 'Expected value', included: true },
      { label: 'SHAP attributions', included: true },
      { label: 'Bankroll tracker', included: true },
    ],
  },
] as const;

function Check({ included }: { included: boolean }) {
  return (
    <span className={included ? 'text-emerald-400' : 'text-gray-700'}>
      {included ? '✓' : '—'}
    </span>
  );
}

export default async function PricingPage() {
  const currentTier = await getCurrentTier();

  return (
    <div className="max-w-5xl mx-auto px-4 py-12">
      <div className="text-center mb-12 space-y-3">
        <h1 className="text-3xl font-bold text-white">Plans &amp; Pricing</h1>
        <p className="text-gray-400 max-w-xl mx-auto">
          Statistically-grounded, AI-explained MLB picks. Cancel anytime.
        </p>
      </div>

      {/* Responsible gambling — Surface 2, above CTAs */}
      <div className="mb-8 bg-gray-900 border border-amber-900/40 rounded-lg p-4 text-xs text-gray-400 leading-relaxed">
        <strong className="text-amber-400 block mb-1">Before you subscribe</strong>
        Diamond Edge provides statistical analysis and AI-generated rationale. We do not guarantee
        wins, profits, or any specific outcome. Sports betting is inherently uncertain — even
        high-confidence picks lose. A subscription is an investment in information, not in returns.
        Never bet more than you can afford to lose. Problem gambling?{' '}
        <a href="tel:18005224700" className="underline">1-800-522-4700</a> (24/7, free).
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {TIERS.map((tier) => {
          const isCurrent = currentTier === tier.key;
          const highlighted = 'highlighted' in tier && tier.highlighted;

          return (
            <div
              key={tier.key}
              className={`bg-gray-900 rounded-xl p-6 flex flex-col border ${
                highlighted ? 'border-blue-600' : 'border-gray-800'
              }`}
            >
              {highlighted && (
                <div className="text-xs font-semibold text-blue-400 mb-3 uppercase tracking-wide">
                  Most Popular
                </div>
              )}
              <div className="mb-4">
                <h2 className="text-xl font-bold text-white">{tier.name}</h2>
                <div className="flex items-baseline gap-1 mt-1">
                  <span className="text-3xl font-bold text-white">{tier.price}</span>
                  <span className="text-sm text-gray-500">{tier.period}</span>
                </div>
                <p className="text-sm text-gray-400 mt-2">{tier.description}</p>
              </div>

              <ul className="space-y-2 flex-1 mb-6">
                {tier.features.map((f) => (
                  <li key={f.label} className="flex items-center gap-2 text-sm text-gray-300">
                    <Check included={f.included} />
                    <span className={f.included ? '' : 'text-gray-600'}>{f.label}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto">
                {isCurrent ? (
                  <div className="text-center">
                    <span className="inline-block bg-gray-800 text-gray-300 text-sm px-4 py-2 rounded font-medium w-full text-center">
                      Current plan
                    </span>
                    {tier.key !== 'free' && (
                      <ManageSubscriptionButton />
                    )}
                  </div>
                ) : tier.key === 'free' ? (
                  <Link
                    href="/signup"
                    className="block w-full text-center bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium py-2 rounded transition-colors"
                  >
                    Get Started Free
                  </Link>
                ) : (
                  <div className="w-full">
                    <UpgradeCta tier={tier.key as 'pro' | 'elite'} size="md" label={tier.key === 'pro' ? 'Upgrade to Pro' : 'Go Elite'} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ManageSubscriptionButton() {
  return <ManageSubscriptionClient />;
}

// Thin Client Component wrapper for the portal button
import { ManageSubscriptionClient } from './manage-subscription-client';
