import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { PickCard } from '@/components/picks/pick-card';
import { RefreshOddsButton } from '@/components/picks/refresh-odds-button';
import { ResponsibleGamblingBanner } from '@/components/picks/responsible-gambling-banner';
import type { Database } from '@/lib/types/database';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type UserTier = 'anon' | 'free' | 'pro' | 'elite';

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

interface PicksApiResponse {
  date: string;
  picks: PickData[];
  total: number;
  user_tier: UserTier;
}

interface PickData {
  id: string;
  game: {
    id: string;
    home_team: { id: string; name: string; abbreviation: string };
    away_team: { id: string; name: string; abbreviation: string };
    game_time_utc: string | null;
    status: string;
  };
  market: string;
  pick_side: string;
  confidence_tier: number;
  required_tier: string;
  result: string;
  best_line_price?: number;
  best_line_book?: string;
  model_probability?: number;
  expected_value?: number;
  rationale_preview?: string;
}

async function fetchPicks(): Promise<PicksApiResponse | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/picks/today`, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
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
  const [data, { tier, geoState }] = await Promise.all([
    fetchPicks(),
    getUserTierAndState(),
  ]);

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
      {/* Header */}
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

      {/* Responsible gambling banner — Surface 1 */}
      <div className="mb-6">
        <ResponsibleGamblingBanner surface="banner" geoState={geoState} />
      </div>

      {/* Zero state */}
      {data.picks.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <p className="text-gray-300 font-medium">No qualifying picks today.</p>
          <p className="text-sm text-gray-500 max-w-md mx-auto">
            Our model requires EV &gt; 4% — on lighter slates, no picks qualify. Check back tomorrow.
          </p>
          <Link href="/history" className="text-sm text-blue-400 hover:underline">
            View pick history
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.picks.map((pick) => (
            <PickCard key={pick.id} pick={pick} userTier={data.user_tier} />
          ))}
        </div>
      )}

      {/* Surface 1 footer disclaimer */}
      <ResponsibleGamblingBanner surface="footer" geoState={geoState} />
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
