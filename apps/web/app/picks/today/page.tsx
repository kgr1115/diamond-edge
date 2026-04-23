import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { RefreshOddsButton } from '@/components/picks/refresh-odds-button';
import { ResponsibleGamblingBanner } from '@/components/picks/responsible-gambling-banner';
import { SlatePicksGrid } from '@/components/picks/slate-picks-grid';
import type { Database } from '@/lib/types/database';
import { loadPicksSlate, todayInET, type UserTier } from '@/lib/picks/load-slate';

export const dynamic = 'force-dynamic';

async function getUserTierAndState(): Promise<{ tier: UserTier; geoState: string | null }> {
  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() { /* read-only in Server Component */ },
      },
    }
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { tier: 'anon', geoState: null };

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, geo_state')
    .eq('id', user.id)
    .single();

  return {
    tier: (profile?.subscription_tier as UserTier) ?? 'free',
    geoState: profile?.geo_state ?? null,
  };
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    anon: 'bg-gray-800 text-gray-400',
    free: 'bg-gray-800 text-gray-400',
    pro: 'bg-blue-900/60 text-blue-300',
    elite: 'bg-amber-900/60 text-amber-300',
  };
  const labels: Record<string, string> = {
    anon: 'Free',
    free: 'Free',
    pro: 'Pro',
    elite: 'Elite',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${styles[tier] ?? styles['free']}`}>
      {labels[tier] ?? 'Free'}
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse">
      <div className="flex justify-between mb-3">
        <div className="space-y-2">
          <div className="h-4 bg-gray-700 rounded w-24" />
          <div className="h-3 bg-gray-800 rounded w-16" />
        </div>
        <div className="h-5 bg-gray-800 rounded w-16" />
      </div>
      <div className="flex gap-3 mb-3">
        <div className="h-4 bg-gray-700 rounded w-8" />
        <div className="h-4 bg-gray-700 rounded w-20" />
      </div>
      <div className="h-3 bg-gray-800 rounded w-32" />
    </div>
  );
}

async function PicksContent() {
  const { tier, geoState } = await getUserTierAndState();

  // Pro+ load ALL picks (live + shadow) so the client-side visibility filter can
  // widen the slate beyond the Strong-only publish gate. Free/anon stay on live.
  const canSeeShadow = tier === 'pro' || tier === 'elite';

  let data: Awaited<ReturnType<typeof loadPicksSlate>> | null = null;
  try {
    data = await loadPicksSlate({
      userTier: tier,
      pickDate: todayInET(),
      visibility: canSeeShadow ? 'all' : 'live',
    });
  } catch {
    data = null;
  }

  if (!data) {
    return (
      <div className="text-center py-16 text-gray-400">
        Unable to load picks. Please refresh.
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Today&apos;s Picks</h1>
          <p className="text-sm text-gray-400 mt-1">{today}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <TierBadge tier={data.user_tier} />
            <span className="text-sm text-gray-500">
              {data.total} {data.total === 1 ? 'pick' : 'picks'}
            </span>
          </div>
          <RefreshOddsButton userTier={data.user_tier} />
        </div>
      </div>

      <div className="mb-6">
        <ResponsibleGamblingBanner surface="banner" geoState={geoState} />
      </div>

      <SlatePicksGrid picks={data.picks} userTier={tier} meta={data.meta} />

      <div className="mt-6">
        <ResponsibleGamblingBanner surface="footer" geoState={geoState} />
      </div>
    </>
  );
}

export default function PicksTodayPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Suspense
        fallback={
          <div className="space-y-4">
            <div className="flex justify-between mb-6">
              <div className="space-y-2">
                <div className="h-8 bg-gray-800 rounded w-40 animate-pulse" />
                <div className="h-4 bg-gray-800 rounded w-28 animate-pulse" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((i) => <SkeletonCard key={i} />)}
            </div>
          </div>
        }
      >
        <PicksContent />
      </Suspense>
    </div>
  );
}
