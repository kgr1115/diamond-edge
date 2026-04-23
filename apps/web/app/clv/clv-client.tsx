'use client';

import { useEffect, useState } from 'react';
import { ClvScatterChart } from '@/components/charts/clv-scatter-chart';

interface MarketClvSummary {
  market: string;
  count: number;
  mean_clv_edge: number;
  positive_count: number;
  positive_rate: number;
}

interface ClvTimePoint {
  date: string;
  pick_id: string;
  market: string;
  clv_edge: number;
}

interface ClvSummaryResponse {
  overall_mean_clv: number | null;
  total_picks: number;
  by_market: MarketClvSummary[];
  time_series: ClvTimePoint[];
}

const MARKET_LABELS: Record<string, string> = {
  moneyline: 'Moneyline',
  run_line: 'Run Line',
  total: 'Totals',
  prop: 'Props',
};

/** Positive mean CLV > 0.5% indicates the market moved toward our picks — a sharp edge signal. */
const CLV_SHARP_THRESHOLD = 0.005;

function clvColor(edge: number): string {
  if (edge > CLV_SHARP_THRESHOLD) return 'text-emerald-400';
  if (edge > 0) return 'text-emerald-600';
  if (edge < 0) return 'text-red-400';
  return 'text-gray-400';
}

export function ClvDashboardClient() {
  const [data, setData] = useState<ClvSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/stats/clv-summary')
      .then((res) => {
        if (!res.ok) return res.json().then((d) => Promise.reject(d.error?.message ?? 'Failed to load CLV data.'));
        return res.json();
      })
      .then(setData)
      .catch((msg: string) => setError(msg))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-gray-500 text-sm animate-pulse">Loading CLV analytics…</div>;
  }

  if (error) {
    return <div className="text-red-400 text-sm py-8 text-center">{error}</div>;
  }

  if (!data || data.total_picks === 0) {
    return (
      <div className="text-center py-16 space-y-2">
        <p className="text-gray-400">No CLV data yet.</p>
        <p className="text-sm text-gray-600">
          CLV is computed nightly after games close. Check back once picks have been graded.
        </p>
      </div>
    );
  }

  const overallLabel = data.overall_mean_clv !== null
    ? `${(data.overall_mean_clv * 100).toFixed(2)}%`
    : 'N/A';

  const isSharp = data.overall_mean_clv !== null && data.overall_mean_clv > CLV_SHARP_THRESHOLD;

  return (
    <div className="space-y-6">
      {/* Interpretation banner */}
      <div className={`rounded-lg border px-4 py-3 text-sm ${isSharp ? 'bg-emerald-950/40 border-emerald-900/60 text-emerald-300' : 'bg-gray-900 border-gray-800 text-gray-400'}`}>
        {isSharp ? (
          <>
            <span className="font-semibold">Sharp signal detected.</span>{' '}
            Positive mean CLV &gt; 0.5% indicates the market moved toward our picks — a sharp edge signal.
            Overall mean CLV: <span className="font-mono font-bold">{overallLabel}</span> across {data.total_picks} graded picks.
          </>
        ) : (
          <>
            Overall mean CLV: <span className="font-mono font-bold">{overallLabel}</span> across {data.total_picks} graded picks.
            {' '}Positive mean CLV &gt; 0.5% would indicate the market is consistently moving toward our picks — a sharp edge signal.
          </>
        )}
      </div>

      {/* Market summary cards */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Mean CLV by Market</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {data.by_market.map((mkt) => (
            <div key={mkt.market} className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-1">
              <p className="text-xs text-gray-500 uppercase">{MARKET_LABELS[mkt.market] ?? mkt.market}</p>
              <p className={`text-2xl font-bold font-mono ${clvColor(mkt.mean_clv_edge)}`}>
                {mkt.mean_clv_edge >= 0 ? '+' : ''}{(mkt.mean_clv_edge * 100).toFixed(2)}%
              </p>
              <p className="text-xs text-gray-500">
                {mkt.positive_count}/{mkt.count} positive ({(mkt.positive_rate * 100).toFixed(0)}%)
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* CLV scatter chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">CLV Edge Over Time</h2>
        <p className="text-xs text-gray-500 mb-4">
          Each dot is a graded pick. Above zero = market moved toward our pick after generation.
        </p>
        <ClvScatterChart data={data.time_series} />
      </div>

      {/* Detail table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-300">Market Breakdown</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase">
                <th className="px-4 py-2">Market</th>
                <th className="px-4 py-2 text-right">Picks</th>
                <th className="px-4 py-2 text-right">Mean CLV</th>
                <th className="px-4 py-2 text-right">Positive Rate</th>
                <th className="px-4 py-2 text-right">Signal</th>
              </tr>
            </thead>
            <tbody>
              {data.by_market.map((mkt) => (
                <tr key={mkt.market} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 text-gray-200">{MARKET_LABELS[mkt.market] ?? mkt.market}</td>
                  <td className="px-4 py-3 text-right text-gray-400">{mkt.count}</td>
                  <td className={`px-4 py-3 text-right font-mono font-medium ${clvColor(mkt.mean_clv_edge)}`}>
                    {mkt.mean_clv_edge >= 0 ? '+' : ''}{(mkt.mean_clv_edge * 100).toFixed(2)}%
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">
                    {(mkt.positive_rate * 100).toFixed(0)}%
                  </td>
                  <td className="px-4 py-3 text-right">
                    {mkt.mean_clv_edge > CLV_SHARP_THRESHOLD ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-400">Sharp</span>
                    ) : mkt.mean_clv_edge > 0 ? (
                      <span className="text-xs text-gray-500">Marginal</span>
                    ) : (
                      <span className="text-xs text-red-400">Negative</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
