import { Suspense } from 'react';
import Link from 'next/link';

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
    by_confidence: Record<string, { picks: number; wins: number; win_rate: number }>;
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
  }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}

async function fetchHistory(page: number = 1): Promise<HistoryResponse | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/history?page=${page}&per_page=50`, {
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
    pending: 'text-gray-600',
  };
  return (
    <span className={`text-xs capitalize ${styles[result] ?? 'text-gray-400'}`}>{result}</span>
  );
}

async function HistoryContent({ page }: { page: number }) {
  const data = await fetchHistory(page);

  if (!data) {
    return <div className="text-gray-500 text-sm py-8 text-center">Unable to load pick history.</div>;
  }

  const { stats } = data;

  return (
    <>
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Total Picks', value: stats.total_picks },
          { label: 'Win Rate', value: `${(stats.win_rate * 100).toFixed(1)}%` },
          {
            label: 'ROI (flat $100)',
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

      {/* Market breakdown */}
      {Object.keys(stats.by_market).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">By Market</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Object.entries(stats.by_market).map(([mkt, s]) => (
              <div key={mkt}>
                <p className="text-xs text-gray-500 uppercase">{mkt}</p>
                <p className="text-sm text-gray-200">
                  {s.picks} picks · {(s.win_rate * 100).toFixed(0)}% W
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pick history table */}
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
                  <Link href={`/picks/${pick.id}`} className="hover:underline">
                    {pick.pick_side}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-gray-400 text-xs">Tier {pick.confidence_tier}</td>
                <td className="py-3 pr-4 font-mono text-gray-300 text-xs">
                  {pick.best_line_price != null
                    ? (pick.best_line_price >= 0 ? `+${pick.best_line_price}` : `${pick.best_line_price}`)
                    : '—'}
                </td>
                <td className="py-3">
                  <ResultBadge result={pick.result} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data.pagination.total_pages > 1 && (
        <div className="flex justify-center gap-4 mt-6 text-sm">
          {page > 1 && (
            <Link href={`/history?page=${page - 1}`} className="text-blue-400 hover:underline">
              ← Previous
            </Link>
          )}
          <span className="text-gray-500">
            Page {page} of {data.pagination.total_pages}
          </span>
          {page < data.pagination.total_pages && (
            <Link href={`/history?page=${page + 1}`} className="text-blue-400 hover:underline">
              Next →
            </Link>
          )}
        </div>
      )}
    </>
  );
}

interface PageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function HistoryPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? '1', 10));

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Pick Performance</h1>
        <p className="text-sm text-gray-400 mt-1">Historical pick results. Public social proof.</p>
      </div>
      <Suspense fallback={<div className="text-gray-500 animate-pulse">Loading…</div>}>
        <HistoryContent page={page} />
      </Suspense>
    </div>
  );
}
