import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';
import { ClvDashboardClient } from './clv-client';
import { UpgradeCta } from '@/components/billing/upgrade-cta';
import { ResponsibleGamblingBanner } from '@/components/picks/responsible-gambling-banner';

export const dynamic = 'force-dynamic';

async function getSession() {
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
  if (!user) return { user: null, tier: 'anon' as const };

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, geo_state')
    .eq('id', user.id)
    .single();

  return {
    user,
    tier: (profile?.subscription_tier ?? 'free') as 'free' | 'pro' | 'elite',
    geoState: profile?.geo_state ?? null,
  };
}

function EliteTeaser() {
  return (
    <div className="max-w-xl mx-auto text-center py-20 space-y-4">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-900/40 mb-2">
        <span className="text-2xl text-amber-400" aria-hidden="true">◇</span>
      </div>
      <h2 className="text-xl font-bold text-white">CLV Analytics — Elite Only</h2>
      <p className="text-sm text-gray-400 leading-relaxed">
        Closing Line Value (CLV) is the gold standard edge metric. Elite subscribers see whether
        the market consistently moved toward our picks after generation time — the sharpest signal
        that our model is finding real edge.
      </p>
      <ul className="text-sm text-gray-500 text-left max-w-sm mx-auto space-y-1">
        <li>• Mean CLV per market (moneyline / run line / totals)</li>
        <li>• CLV edge scatter chart over time</li>
        <li>• Market-by-market positive CLV rate</li>
      </ul>
      <div className="pt-2">
        <UpgradeCta tier="elite" size="md" label="Go Elite — Unlock CLV" />
      </div>
    </div>
  );
}

export default async function ClvPage() {
  const session = await getSession();

  if (!session.user) {
    redirect('/login?redirect=/clv');
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold text-white">CLV Dashboard</h1>
          <span className="text-xs px-2 py-0.5 rounded bg-amber-900/60 text-amber-300 font-medium">Elite</span>
        </div>
        <p className="text-sm text-gray-400">
          Closing Line Value — does the market agree with our picks after they go live?
        </p>
      </div>

      {session.tier !== 'elite' ? (
        <EliteTeaser />
      ) : (
        <Suspense fallback={<div className="text-gray-500 text-sm animate-pulse">Loading CLV data…</div>}>
          <ClvDashboardClient />
        </Suspense>
      )}

      <ResponsibleGamblingBanner surface="footer" geoState={'geoState' in session ? session.geoState : null} />
    </div>
  );
}
