import { Suspense } from 'react';
import Link from 'next/link';
import { HistoryFilters } from '@/components/history/history-filters';
import { LeadTimeGrid } from '@/components/history/lead-time-grid';
import { SlateNav } from '@/components/picks/slate-nav';

export const dynamic = 'force-dynamic';

interface HistoryResponse {
  stats: {
    total_picks: number;
    wins: number;
    losses: number;
    pushes: number;
    win_rate: number;
    roi_pct: number;
    by_market: Record<string, { picks: number; wins: number; win_rate: number; roi_pct: number }>;
    by_confidence: Record<string, { picks: number; wins: number; losses: number; pushes: number; win_rate: number; roi_pct: number }>;
    by_lead_time: Record<'same_day' | 'next_day' | 'multi_day', Record<string, {
      picks: number; wins: number; losses: number; pushes: number;
      win_rate: number; roi_pct: number; has_min_sample: boolean; graded: number;
    }>>;
    lead_time_meta: {
      sample_min: number;
      excluded_no_lead_time: number;
      bucket_definitions: Record<string, string>;
    };
  };
  picks: Array<{
    id: string;
    pick_date: string;
    game: { home_team: string; away_team: string };
    market: string;
    pick_side: string;
    confidence_tier: number;
    result: string;
    best_line_price: number | null;
    final_score: { home: number; away: number; total: number; runline: number } | null;
  }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

interface FilterState {
  market: string;
  result: string;
  date_from: string;
  date_to: string;
  page: number;
}

async function fetchHistory(filters: FilterState): Promise<HistoryResponse | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const params = new URLSearchParams();
    params.set('page', String(filters.page));
    params.set('per_page', '50');
    if (filters.market) params.set('market', filters.market);
    if (filters.result) params.set('result', filters.result);
    if (filters.date_from) params.set('date_from', filters.date_from);
    if (filters.date_to) params.set('date_to', filters.date_to);

    const res = await fetch(`${baseUrl}/api/history?${params.toString()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function ResultBadge({ result }: { result: string }) {
  const styles: Record<string, string> = {
    win: 'text-emerald-400',
    loss: 'text-red-400',
    push: 'text-yellow-400',
    void: 'text-gray-500',
    pending: 'text-gray-500',
  };
  return (
    <span className={`text-xs capitalize ${styles[result] ?? 'text-gray-400'}`}>{result}</span>
  );
}

async function HistoryContent({ filters }: { filters: FilterState }) {
  const data = await fetchHistory(filters);

  if (!data) {
    return <div className="text-gray-500 text-sm py-8 text-center">Unable to load pick history.</div>;
  }

  const { stats } = data;
  const hasFilter = filters.market || filters.result || filters.date_from || filters.date_to;

  return (
    <>
      {/* Aggregate stats for current filter */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: hasFilter ? 'Filtered Picks' : 'Total Picks', value: stats.total_picks },
          { label: 'Win Rate', value: `${(stats.win_rate * 100).toFixed(1)}%` },
          {
            label: 'Unit ROI',
            value: `${stats.roi_pct >= 0 ? '+' : ''}${stats.roi_pct.toFixed(1)}%`,
            highlight: stats.roi_pct >= 0 ? 'text-emerald-400' : 'text-red-400',
          },
          { label: 'W–L–P', value: `${stats.wins}–${stats.losses}–${stats.pushes}` },
        ].map((stat) => (
          <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
            <p className={`text-lg font-bold ${stat.highlight ?? 'text-white'}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Market breakdown — only when no market filter applied */}
      {!filters.market && Object.keys(stats.by_market).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">By Market</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(stats.by_market).map(([mkt, s]) => (
              <Link
                key={mkt}
                href={buildFilterHref(filters, { market: mkt })}
                className="block rounded border border-transparent hover:border-gray-700 hover:bg-gray-800/40 px-2 py-1 -mx-2 -my-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <p className="text-xs text-gray-500 uppercase">{marketLabel(mkt)}</p>
                <p className="text-sm text-gray-200">
                  {s.picks} picks · {(s.win_rate * 100).toFixed(0)}% W ·{' '}
                  <span className={s.roi_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {s.roi_pct >= 0 ? '+' : ''}{s.roi_pct.toFixed(1)}% ROI
                  </span>
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Confidence-tier breakdown */}
      {Object.keys(stats.by_confidence).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">By Confidence Tier</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(stats.by_confidence)
              .sort(([a], [b]) => Number(b) - Number(a))
              .map(([tier, s]) => (
                <div key={tier}>
                  <p className="text-xs text-gray-500 uppercase">Tier {tier}</p>
                  <p className="text-sm text-gray-200">
                    {s.picks} picks · {s.wins}–{s.losses}
                    {s.pushes > 0 ? `–${s.pushes}` : ''} · {(s.win_rate * 100).toFixed(0)}% W ·{' '}
                    <span className={s.roi_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {s.roi_pct >= 0 ? '+' : ''}{s.roi_pct.toFixed(1)}% ROI
                    </span>
                  </p>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Lead-time grid — collapsible */}
      {stats.by_lead_time && stats.lead_time_meta && (
        <LeadTimeGrid byLeadTime={stats.by_lead_time} meta={stats.lead_time_meta} />
      )}

      {/* Pick table */}
      {data.picks.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          No picks match your filters.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Matchup</th>
                <th className="py-2 pr-4">Market</th>
                <th className="py-2 pr-4">Pick</th>
                <th className="py-2 pr-4">Confidence</th>
                <th className="py-2 pr-4">Odds</th>
                <th className="py-2 pr-4">Final</th>
                <th className="py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {data.picks.map((pick) => (
                <tr key={pick.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                  <td className="py-3 pr-4 text-gray-400 whitespace-nowrap text-xs">{pick.pick_date}</td>
                  <td className="py-3 pr-4 text-gray-200 text-xs whitespace-nowrap">
                    {pick.game.away_team} @ {pick.game.home_team}
                  </td>
                  <td className="py-3 pr-4 text-gray-400 uppercase text-xs">{pick.market}</td>
                  <td className="py-3 pr-4 text-white font-medium text-xs">
                    <Link
                      href={`/picks/${pick.id}`}
                      className="hover:underline focus:underline focus:outline-none focus:ring-1 focus:ring-blue-500 rounded"
                    >
                      {pick.pick_side}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 text-gray-400 text-xs">Tier {pick.confidence_tier}</td>
                  <td className="py-3 pr-4 font-mono text-gray-300 text-xs">
                    {pick.best_line_price != null
                      ? (pick.best_line_price >= 0 ? `+${pick.best_line_price}` : `${pick.best_line_price}`)
                      : '—'}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs whitespace-nowrap">
                    {pick.final_score ? (
                      <>
                        <span className="text-gray-200">
                          {pick.final_score.away}–{pick.final_score.home}
                        </span>
                        <span className="text-gray-500 ml-2">
                          T {pick.final_score.total} · RL {pick.final_score.runline >= 0 ? '+' : ''}
                          {pick.final_score.runline}
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-3">
                    <ResultBadge result={pick.result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data.pagination.total_pages > 1 && (
        <div className="flex justify-center gap-4 mt-6 text-sm">
          {filters.page > 1 && (
            <Link
              href={buildPageHref(filters, filters.page - 1)}
              className="text-blue-400 hover:underline"
            >
              Previous
            </Link>
          )}
          <span className="text-gray-500">
            Page {filters.page} of {data.pagination.total_pages}
            {' '}({data.pagination.total} total)
          </span>
          {filters.page < data.pagination.total_pages && (
            <Link
              href={buildPageHref(filters, filters.page + 1)}
              className="text-blue-400 hover:underline"
            >
              Next
            </Link>
          )}
        </div>
      )}
    </>
  );
}

function buildPageHref(filters: FilterState, page: number): string {
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (filters.market) params.set('market', filters.market);
  if (filters.result) params.set('result', filters.result);
  if (filters.date_from) params.set('date_from', filters.date_from);
  if (filters.date_to) params.set('date_to', filters.date_to);
  return `/history?${params.toString()}`;
}

function buildFilterHref(filters: FilterState, overrides: Partial<FilterState>): string {
  const next: FilterState = { ...filters, ...overrides, page: 1 };
  const params = new URLSearchParams();
  if (next.market) params.set('market', next.market);
  if (next.result) params.set('result', next.result);
  if (next.date_from) params.set('date_from', next.date_from);
  if (next.date_to) params.set('date_to', next.date_to);
  const qs = params.toString();
  return qs ? `/history?${qs}` : '/history';
}

const MARKET_LABELS: Record<string, string> = {
  moneyline: 'Moneyline',
  run_line: 'Run Line',
  total: 'Totals',
  prop: 'Props',
  parlay: 'Parlay',
  future: 'Futures',
};
function marketLabel(mkt: string): string {
  return MARKET_LABELS[mkt] ?? mkt;
}

interface PageProps {
  searchParams: Promise<{
    page?: string;
    market?: string;
    result?: string;
    date_from?: string;
    date_to?: string;
  }>;
}

export default async function HistoryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const filters: FilterState = {
    page: Math.max(1, parseInt(params.page ?? '1', 10)),
    market: params.market ?? '',
    result: params.result ?? '',
    date_from: params.date_from ?? '',
    date_to: params.date_to ?? '',
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <SlateNav />
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Pick Performance</h1>
        <p className="text-sm text-gray-400 mt-1">
          Historical pick results and ROI. Most picks below were generated day-of at ~12:00 PM ET
          (lead time under 6 hours). See the lead-time analysis card for breakdown by lead time.
        </p>
      </div>

      {/* Filters are a Client Component — URL-driven via router.push */}
      <div className="mb-6">
        <Suspense>
          <HistoryFilters
            market={filters.market}
            result={filters.result}
            dateFrom={filters.date_from}
            dateTo={filters.date_to}
          />
        </Suspense>
      </div>

      <Suspense
        fallback={
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-4 mb-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse h-16" />
              ))}
            </div>
            <div className="text-gray-500 animate-pulse text-sm">Loading picks…</div>
          </div>
        }
      >
        <HistoryContent filters={filters} />
      </Suspense>
    </div>
  );
}
