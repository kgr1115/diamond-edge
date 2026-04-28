import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { createServerClient } from '@supabase/ssr';
import {
  ResponsibleGamblingBanner,
  resolveHelpline,
} from '@/components/picks/responsible-gambling-banner';
import { ConfidenceBadge } from '@/components/picks/confidence-badge';
import { UpgradeCta } from '@/components/billing/upgrade-cta';
import { PickJournal } from '@/components/picks/pick-journal';
import { PickOutcomePanel } from '@/components/picks/pick-outcome-panel';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/types/database';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

interface BookLine {
  price: number | null;
  book: string;
}

interface PickDetailResponse {
  pick: {
    id: string;
    game: {
      id: string;
      home_team: { id: string; name: string; abbreviation: string };
      away_team: { id: string; name: string; abbreviation: string };
      game_time_utc: string;
      status: string;
      probable_home_pitcher: { id: string; full_name: string } | null;
      probable_away_pitcher: { id: string; full_name: string } | null;
      weather: { condition: string; temp_f: number; wind_mph: number; wind_dir: string } | null;
    };
    market: string;
    pick_side: string;
    confidence_tier: number;
    required_tier: string;
    result: string;
    generated_at: string;
    best_line_price?: number;
    best_line_book?: string;
    dk_line?: BookLine;
    fd_line?: BookLine;
    model_probability?: number;
    expected_value?: number;
    rationale?: string;
    shap_attributions?: Array<{
      feature: string;
      value: number;
      direction: 'positive' | 'negative';
    }>;
    outcome?: {
      result: 'win' | 'loss' | 'push' | 'void';
      home_score: number;
      away_score: number;
      graded_at: string;
    };
  };
}

function formatOdds(price: number) {
  return price >= 0 ? `+${price}` : `${price}`;
}

function formatGameTime(utc: string) {
  return new Date(utc).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

async function fetchPickDetail(id: string): Promise<PickDetailResponse | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/picks/${id}`, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('fetch failed');
    return res.json();
  } catch {
    return null;
  }
}

interface JournalData {
  user_note: string | null;
  user_tags: string[];
}

interface JournalAndGeo {
  journal: JournalData | null;
  geoState: string | null;
}

interface BucketStats {
  picks: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate: number;
  roi_pct: number;
}

interface BucketBreakdown {
  market: BucketStats;
  tier: BucketStats;
}

const MARKET_LABELS: Record<string, string> = {
  moneyline: 'Moneyline',
  run_line: 'Run Line',
  total: 'Totals',
  prop: 'Props',
  parlay: 'Parlay',
  future: 'Futures',
};

function unitProfit(price: number | null): number {
  const p = price ?? -110;
  return p >= 100 ? p / 100 : 100 / Math.abs(p);
}

function summarize(rows: Array<{ result: string | null; best_line_price: number | null }>): BucketStats {
  let wins = 0, losses = 0, pushes = 0, returnUnits = 0, risked = 0;
  for (const r of rows) {
    if (r.result === 'win') {
      wins++;
      returnUnits += unitProfit(r.best_line_price);
      risked++;
    } else if (r.result === 'loss') {
      losses++;
      returnUnits -= 1;
      risked++;
    } else if (r.result === 'push') {
      pushes++;
    }
  }
  const graded = wins + losses;
  return {
    picks: rows.length,
    wins,
    losses,
    pushes,
    win_rate: graded > 0 ? wins / graded : 0,
    roi_pct: risked > 0 ? Math.round((returnUnits / risked) * 10000) / 100 : 0,
  };
}

async function fetchBucketBreakdown(
  pickId: string,
  market: string,
  tier: number,
): Promise<BucketBreakdown | null> {
  try {
    const service = createServiceRoleClient();
    const [{ data: marketRows }, { data: tierRows }] = await Promise.all([
      service
        .from('picks')
        .select('result, best_line_price')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .eq('market', market as any)
        .neq('id', pickId)
        .limit(5000),
      service
        .from('picks')
        .select('result, best_line_price')
        .eq('confidence_tier', tier)
        .neq('id', pickId)
        .limit(5000),
    ]);
    return {
      market: summarize((marketRows ?? []) as Array<{ result: string | null; best_line_price: number | null }>),
      tier: summarize((tierRows ?? []) as Array<{ result: string | null; best_line_price: number | null }>),
    };
  } catch {
    return null;
  }
}

async function fetchJournalData(pickId: string): Promise<JournalAndGeo> {
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
  if (!user) return { journal: null, geoState: null };

  const { data: profile } = await supabase
    .from('profiles')
    .select('geo_state')
    .eq('id', user.id)
    .single();
  const geoState = profile?.geo_state ?? null;

  // Read directly from service-role — picks has RLS for visibility=live, journal fields
  // are non-sensitive but we still go via anon key; no RLS issue since visibility=live
  // is already satisfied by the main pick fetch succeeding.
  const { data } = await supabase
    .from('picks')
    .select('user_note, user_tags')
    .eq('id', pickId)
    .single();

  if (!data) return { journal: null, geoState };
  const row = data as unknown as { user_note: string | null; user_tags: string[] | null };
  return {
    journal: {
      user_note: row.user_note,
      user_tags: row.user_tags ?? [],
    },
    geoState,
  };
}

export default async function PickDetailPage({ params }: PageProps) {
  const { id } = await params;
  const [data, journalAndGeo] = await Promise.all([
    fetchPickDetail(id),
    fetchJournalData(id),
  ]);

  if (!data) {
    notFound();
  }

  const { pick } = data;
  const bucket = await fetchBucketBreakdown(pick.id, pick.market, pick.confidence_tier);
  const { journal, geoState } = journalAndGeo;
  const sidebarHelpline = resolveHelpline(geoState);
  const isGraded = pick.result !== 'pending' && pick.outcome != null;
  const isGradedRacing = pick.result !== 'pending' && pick.outcome == null;
  const modelHeader = isGraded ? 'Model view at pick time' : 'Pick';
  const analysisHeader = isGraded ? 'Analysis at pick time' : 'Analysis';

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main content — 2/3 */}
        <div className="lg:col-span-2 space-y-6">
          {isGraded && pick.outcome && (
            <PickOutcomePanel
              result={pick.outcome.result}
              homeScore={pick.outcome.home_score}
              awayScore={pick.outcome.away_score}
              homeAbbr={pick.game.home_team.abbreviation}
              awayAbbr={pick.game.away_team.abbreviation}
              gradedAt={pick.outcome.graded_at}
              bestLinePrice={pick.best_line_price ?? null}
            />
          )}
          {isGradedRacing && (
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
              <p className="text-sm text-gray-400">
                Outcome pending — final score not yet recorded.
              </p>
            </div>
          )}

          {/* Matchup header */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-xl font-bold text-white">
                {pick.game.away_team.name} @ {pick.game.home_team.name}
              </h1>
              <span className="text-sm text-gray-400">{formatGameTime(pick.game.game_time_utc)}</span>
            </div>
            {pick.game.weather && (
              <p className="text-xs text-gray-500">
                {pick.game.weather.condition}, {pick.game.weather.temp_f}°F —{' '}
                {pick.game.weather.wind_mph} mph {pick.game.weather.wind_dir}
              </p>
            )}
            {(pick.game.probable_home_pitcher || pick.game.probable_away_pitcher) && (
              <div className="mt-2 text-xs text-gray-400 flex gap-4">
                {pick.game.probable_away_pitcher && (
                  <span>Away SP: {pick.game.probable_away_pitcher.full_name}</span>
                )}
                {pick.game.probable_home_pitcher && (
                  <span>Home SP: {pick.game.probable_home_pitcher.full_name}</span>
                )}
              </div>
            )}
          </div>

          {/* Pick summary */}
          <div className={`bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-3 ${isGraded ? 'opacity-75' : ''}`}>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">{modelHeader}</h2>
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-sm text-gray-500 uppercase">{pick.market}</span>
              <span className="text-2xl font-bold text-white">{pick.pick_side}</span>
              {pick.best_line_price !== undefined && (
                <span className="text-lg font-mono text-emerald-400">
                  {formatOdds(pick.best_line_price)}
                </span>
              )}
              {pick.best_line_book && (
                <span className="text-sm text-gray-500">@ {pick.best_line_book}</span>
              )}
            </div>

            {/* DK + FD line shopping — required on every pick */}
            {(pick.dk_line || pick.fd_line) && (
              <div className="flex gap-4 pt-1">
                {pick.dk_line && (
                  <div className="flex items-center gap-1.5 bg-gray-800 rounded px-3 py-1.5">
                    <span className="text-xs font-semibold text-gray-400">DK</span>
                    <span className="text-sm font-mono text-white">
                      {pick.dk_line.price != null ? formatOdds(pick.dk_line.price) : 'N/A'}
                    </span>
                  </div>
                )}
                {pick.fd_line && (
                  <div className="flex items-center gap-1.5 bg-gray-800 rounded px-3 py-1.5">
                    <span className="text-xs font-semibold text-gray-400">FD</span>
                    <span className="text-sm font-mono text-white">
                      {pick.fd_line.price != null ? formatOdds(pick.fd_line.price) : 'N/A'}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-4">
              <ConfidenceBadge tier={pick.confidence_tier} showLabel />
              {pick.model_probability !== undefined && (
                <span className="text-sm text-gray-400">
                  Model: {(pick.model_probability * 100).toFixed(1)}%
                </span>
              )}
              {pick.expected_value !== undefined && (
                <span className="text-sm text-emerald-400">
                  EV: {pick.expected_value >= 0 ? '+' : ''}{(pick.expected_value * 100).toFixed(1)}%
                </span>
              )}
            </div>
            <p className="text-xs text-gray-600">
              Generated {new Date(pick.generated_at).toLocaleString()}
            </p>
          </div>

          {/* Bucket performance — how the rest of this market/tier has done */}
          {bucket && (bucket.market.picks > 0 || bucket.tier.picks > 0) && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Historical performance — same market &amp; tier
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-500 uppercase mb-1">
                    {MARKET_LABELS[pick.market] ?? pick.market}{' '}
                    <Link
                      href={`/history?market=${encodeURIComponent(pick.market)}`}
                      className="text-blue-400 hover:underline normal-case"
                    >
                      view
                    </Link>
                  </p>
                  <p className="text-sm text-gray-200">
                    {bucket.market.picks} picks · {bucket.market.wins}–{bucket.market.losses}
                    {bucket.market.pushes > 0 ? `–${bucket.market.pushes}` : ''} ·{' '}
                    {(bucket.market.win_rate * 100).toFixed(0)}% W ·{' '}
                    <span className={bucket.market.roi_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {bucket.market.roi_pct >= 0 ? '+' : ''}{bucket.market.roi_pct.toFixed(1)}% ROI
                    </span>
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500 uppercase mb-1">
                    Tier {pick.confidence_tier}
                  </p>
                  <p className="text-sm text-gray-200">
                    {bucket.tier.picks} picks · {bucket.tier.wins}–{bucket.tier.losses}
                    {bucket.tier.pushes > 0 ? `–${bucket.tier.pushes}` : ''} ·{' '}
                    {(bucket.tier.win_rate * 100).toFixed(0)}% W ·{' '}
                    <span className={bucket.tier.roi_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {bucket.tier.roi_pct >= 0 ? '+' : ''}{bucket.tier.roi_pct.toFixed(1)}% ROI
                    </span>
                  </p>
                </div>
              </div>
              <p className="text-xs text-gray-600 mt-3">
                Excludes this pick. Past performance does not predict future results.
              </p>
            </div>
          )}

          {/* AI Rationale */}
          <div className={`bg-gray-900 border border-gray-800 rounded-lg p-5 ${isGraded ? 'opacity-75' : ''}`}>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
              {analysisHeader}
            </h2>
            {pick.rationale ? (
              <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                {pick.rationale}
              </div>
            ) : (
              <div className="text-center py-8 space-y-3">
                <p className="text-sm text-gray-400">
                  Upgrade to Pro to see the full statistical analysis and AI rationale.
                </p>
                <UpgradeCta tier="pro" />
              </div>
            )}
          </div>

          {/* SHAP attributions — Elite only */}
          {pick.shap_attributions && pick.shap_attributions.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Model Feature Drivers
              </h2>
              <div className="space-y-2">
                {pick.shap_attributions.map((attr, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-gray-300">{attr.feature}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">{attr.value}</span>
                      <span
                        className={attr.direction === 'positive' ? 'text-emerald-400' : 'text-red-400'}
                      >
                        {attr.direction === 'positive' ? '▲' : '▼'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Journal — authenticated users only */}
          {journal !== null && (
            <PickJournal
              pickId={pick.id}
              initialNote={journal.user_note}
              initialTags={journal.user_tags}
            />
          )}
        </div>

        {/* Sidebar — 1/3 */}
        <div className="space-y-4">
          {/* Surface 5 — "A note on risk" — dimmed for graded picks (warning is retroactive)
              but never removed; compliance invariant per scope-gate 2026-04-25. */}
          <div className={`bg-gray-900 border border-amber-900/40 rounded-lg p-4 space-y-2 ${isGraded ? 'opacity-60' : ''}`}>
            <h3 className="text-sm font-semibold text-amber-400">A note on risk</h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              This pick is based on a statistical model and AI analysis. The model identified an edge
              at the time of generation. Edges erode, lines move, and results vary.
            </p>
            <ul className="text-xs text-gray-500 space-y-1">
              <li>• Past performance does not predict future results.</li>
              <li>• This is analysis, not a guarantee.</li>
              <li>• Never bet more than your stated bankroll limit.</li>
            </ul>
            <p className="text-xs text-gray-600">
              Struggling?{' '}
              <a href={sidebarHelpline.tel} className="text-amber-600 hover:underline">
                {sidebarHelpline.display}
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Surface 1 footer disclaimer */}
      <div className="mt-8">
        <ResponsibleGamblingBanner surface="footer" geoState={geoState} />
      </div>
    </div>
  );
}
