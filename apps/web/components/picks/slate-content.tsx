import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { RefreshOddsButton } from '@/components/picks/refresh-odds-button';
import { ResponsibleGamblingBanner } from '@/components/picks/responsible-gambling-banner';
import { SlatePicksGrid } from '@/components/picks/slate-picks-grid';
import { ConfidenceTierLegend } from '@/components/picks/confidence-tier-legend';
import { SlateDatePicker } from '@/components/picks/slate-date-picker';
import { SlateNav } from '@/components/picks/slate-nav';
import { paidTiersEnabled } from '@/lib/feature-flags';
import type { Database } from '@/lib/types/database';
import {
  loadPicksSlate,
  todayInET,
  ODDS_AMBER_MIN,
  ODDS_RED_MIN,
  type UserTier,
  type PicksMeta,
} from '@/lib/picks/load-slate';

/** Mirrors LOOKAHEAD_DAYS in supabase/functions/pick-pipeline/index.ts. */
export const LOOKAHEAD_DAYS = 7;

export function addDaysET(yyyymmdd: string, days: number): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function getUserTierAndState(): Promise<{ tier: UserTier; geoState: string | null }> {
  if (!paidTiersEnabled()) {
    return { tier: 'elite', geoState: null };
  }
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

function formatRelativeAge(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) {
    const h = Math.floor(hours);
    const m = Math.floor(minutes - h * 60);
    return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function FreshnessBadge({ meta }: { meta: PicksMeta }) {
  if (!meta.last_odds_snapshot_at) return null;
  const ageMs = Date.now() - new Date(meta.last_odds_snapshot_at).getTime();
  const ageMin = Math.max(0, ageMs / 60_000);
  const tone =
    ageMin >= ODDS_RED_MIN
      ? 'bg-red-950/60 border-red-900/70 text-red-300'
      : ageMin >= ODDS_AMBER_MIN
        ? 'bg-amber-950/60 border-amber-900/70 text-amber-300'
        : 'bg-gray-900 border-gray-800 text-gray-400';
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded border font-medium ${tone}`}
      title={`Odds last refreshed at ${new Date(meta.last_odds_snapshot_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' })} ET`}
    >
      Odds updated {formatRelativeAge(ageMin)}
    </span>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    anon: 'bg-gray-800 text-gray-400',
    free: 'bg-gray-800 text-gray-400',
    pro: 'bg-blue-900/60 text-blue-300',
    elite: 'bg-amber-900/60 text-amber-300',
  };
  const labels: Record<string, string> = {
    anon: 'Free', free: 'Free', pro: 'Pro', elite: 'Elite',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${styles[tier] ?? styles['free']}`}>
      {labels[tier] ?? 'Free'}
    </span>
  );
}

function formatDateLabel(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

export interface SlateContentProps {
  pickDate: string;
  mode: 'today' | 'upcoming';
}

/**
 * Shared Server Component for /picks/today and /picks/upcoming.
 * Mode controls header copy, date-picker presence, date-picker bounds.
 */
export async function SlateContent({ pickDate, mode }: SlateContentProps) {
  const { tier, geoState } = await getUserTierAndState();
  const canSeeShadow = tier === 'pro' || tier === 'elite';

  let data: Awaited<ReturnType<typeof loadPicksSlate>> | null = null;
  try {
    data = await loadPicksSlate({
      userTier: tier,
      pickDate,
      visibility: canSeeShadow ? 'all' : 'live',
    });
  } catch (err) {
    console.error(`[slate-content] loadPicksSlate threw (mode=${mode}, date=${pickDate}):`, err);
    data = null;
  }

  if (!data) {
    return (
      <div className="text-center py-16 text-gray-400">
        Unable to load picks. Please refresh.
      </div>
    );
  }

  const todayStr = todayInET();
  const dateLabel = formatDateLabel(pickDate);

  // Date-picker bounds depend on which tab is active.
  // /picks/today  → no picker rendered (locked to today)
  // /picks/upcoming → bounds [today+1, today+LOOKAHEAD_DAYS]
  const minDate = mode === 'upcoming' ? addDaysET(todayStr, 1) : todayStr;
  const maxDate = addDaysET(todayStr, LOOKAHEAD_DAYS);

  const headerTitle = mode === 'today' ? "Today's Picks" : 'Upcoming Picks';

  return (
    <>
      <SlateNav />

      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">{headerTitle}</h1>
          <p className="text-sm text-gray-400 mt-1">{dateLabel}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {mode === 'upcoming' && (
            <SlateDatePicker value={pickDate} min={minDate} max={maxDate} />
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <TierBadge tier={data.user_tier} />
            <span className="text-sm text-gray-500">
              {data.total} {data.total === 1 ? 'pick' : 'picks'}
            </span>
            {data.total > 0 && <FreshnessBadge meta={data.meta} />}
          </div>
          <RefreshOddsButton userTier={data.user_tier} />
        </div>
      </div>

      <div className="mb-6">
        <ResponsibleGamblingBanner surface="banner" geoState={geoState} />
      </div>

      <div className="mb-4">
        <ConfidenceTierLegend />
      </div>

      <SlatePicksGrid
        picks={data.picks}
        userTier={tier}
        meta={data.meta}
        pickDate={pickDate}
        mode={mode}
      />

      <div className="mt-6">
        <ResponsibleGamblingBanner surface="footer" geoState={geoState} />
      </div>
    </>
  );
}

export function SlateSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex justify-between mb-6">
        <div className="space-y-2">
          <div className="h-8 bg-gray-800 rounded w-40 animate-pulse" />
          <div className="h-4 bg-gray-800 rounded w-28 animate-pulse" />
        </div>
      </div>
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse h-32" />
        ))}
      </div>
    </div>
  );
}
