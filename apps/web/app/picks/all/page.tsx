import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { ResponsibleGamblingBanner } from '@/components/picks/responsible-gambling-banner';
import { AllPicksGrid } from '@/components/picks/all-picks-grid';
import type { Database } from '@/lib/types/database';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserTier = 'anon' | 'free' | 'pro' | 'elite';

interface ShapAttribution {
  feature: string;
  value: number;
  direction: 'positive' | 'negative';
}

interface OddsSnapshot {
  label: string;
  price: number;
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
  visibility: 'live' | 'shadow';
  result: string;
  best_line_price?: number;
  best_line_book?: string;
  model_probability?: number;
  expected_value?: number;
  rationale_preview?: string;
  shap_attributions?: ShapAttribution[];
  line_snapshots?: OddsSnapshot[];
}

interface PicksApiResponse {
  date: string;
  picks: PickData[];
  total: number;
  user_tier: UserTier;
}

// ---------------------------------------------------------------------------
// Server-side data helpers
// ---------------------------------------------------------------------------

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

async function fetchAllPicks(tier: UserTier): Promise<PicksApiResponse | null> {
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

    // Pro+ users see all visibility; free/anon fall back to live-only
    const visibilityParam = tier === 'pro' || tier === 'elite' ? 'all' : 'live';

    const res = await fetch(
      `${baseUrl}/api/picks/today?visibility=${visibilityParam}`,
      {
        cache: 'no-store',
        headers: { cookie: (await cookies()).toString() },
      }
    );
    if (!res.ok) return null;
    return res.json() as Promise<PicksApiResponse>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Page content (async Server Component)
// ---------------------------------------------------------------------------

async function AllPicksContent() {
  const { tier, geoState } = await getUserTierAndState();

  // Free/anon — redirect to upgrade prompt instead of showing empty shadow state
  if (tier === 'anon') {
    return (
      <div className="text-center py-16 space-y-4 max-w-md mx-auto">
        <p className="text-gray-300 font-semibold text-lg">Sign in to view all picks.</p>
        <p className="text-sm text-gray-500">
          Create an account to access today&apos;s picks and shadow picks (Pro+).
        </p>
        <a
          href="/signup"
          className="inline-block text-sm bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded transition-colors"
        >
          Get started
        </a>
      </div>
    );
  }

  const data = await fetchAllPicks(tier);

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

  const canSeeShadow = tier === 'pro' || tier === 'elite';
  const shadowCount = data.picks.filter((p) => p.visibility === 'shadow').length;
  const liveCount = data.picks.filter((p) => p.visibility === 'live').length;

  return (
    <>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">All Picks</h1>
        <p className="text-sm text-gray-400 mt-1">{today}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
          <span>
            <span className="text-white font-semibold">{liveCount}</span> published
          </span>
          {canSeeShadow && (
            <span>
              <span className="text-amber-400 font-semibold">{shadowCount}</span> shadow
            </span>
          )}
          <span className="text-gray-600">Total: {data.total}</span>
        </div>
      </div>

      {/* Responsible gambling */}
      <div className="mb-6">
        <ResponsibleGamblingBanner surface="banner" geoState={geoState} />
      </div>

      {/* Shadow pick context — helps paying users understand what they're seeing */}
      {canSeeShadow && shadowCount > 0 && (
        <div className="mb-4 bg-amber-950/30 border border-amber-900/50 rounded-lg px-4 py-3 text-xs text-amber-300/80">
          <span className="font-semibold text-amber-300">Shadow picks</span> met our minimum EV
          threshold but didn&apos;t clear the publish bar (EV &ge; 8%, Confidence: Strong). They&apos;re
          shown here for context and CLV tracking — treat them as lower-conviction signals.
        </div>
      )}

      {/* Grid with filters */}
      <AllPicksGrid picks={data.picks} userTier={tier} />

      {/* Footer disclaimer */}
      <div className="mt-6">
        <ResponsibleGamblingBanner surface="footer" geoState={geoState} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AllPicksPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Suspense
        fallback={
          <div className="space-y-4">
            <div className="space-y-2 mb-6">
              <div className="h-8 bg-gray-800 rounded w-40 animate-pulse" />
              <div className="h-4 bg-gray-800 rounded w-28 animate-pulse" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((i) => <SkeletonCard key={i} />)}
            </div>
          </div>
        }
      >
        <AllPicksContent />
      </Suspense>
    </div>
  );
}
