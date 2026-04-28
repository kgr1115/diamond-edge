'use client';

import { useState } from 'react';

interface Cell {
  picks: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate: number;
  roi_pct: number;
  has_min_sample: boolean;
  graded: number;
}

interface LeadTimeGridProps {
  byLeadTime: Record<'same_day' | 'next_day' | 'multi_day', Record<string, Cell>>;
  meta: {
    sample_min: number;
    excluded_no_lead_time: number;
    bucket_definitions: Record<string, string>;
  };
}

const BUCKETS: Array<{ key: 'same_day' | 'next_day' | 'multi_day'; label: string; sub: string }> = [
  { key: 'same_day',  label: 'Same-day', sub: '0–6h' },
  { key: 'next_day',  label: 'Next-day', sub: '6–30h' },
  { key: 'multi_day', label: 'Multi-day', sub: '30h+' },
];

const MARKETS: Array<{ key: string; label: string }> = [
  { key: 'moneyline', label: 'ML' },
  { key: 'run_line',  label: 'RL' },
  { key: 'total',     label: 'Totals' },
];

function CellContents({ cell, sampleMin }: { cell: Cell; sampleMin: number }) {
  if (!cell.has_min_sample) {
    const pct = Math.min(100, Math.round((cell.picks / sampleMin) * 100));
    return (
      <div className="text-center">
        <p className="text-xs text-gray-500">[N={cell.picks}/{sampleMin}]</p>
        <div className="mt-1 h-1 bg-gray-800 rounded overflow-hidden">
          <div
            className="h-full bg-gray-600"
            style={{ width: `${pct}%` }}
            aria-label={`${cell.picks} of ${sampleMin} graded outcomes`}
          />
        </div>
      </div>
    );
  }

  const winRatePct = (cell.win_rate * 100).toFixed(0);
  const roiSign = cell.roi_pct >= 0 ? '+' : '';
  const roiColor = cell.roi_pct >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="text-center">
      <p className="text-sm font-semibold text-white">{winRatePct}% W</p>
      <p className={`text-xs font-mono ${roiColor}`}>
        {roiSign}{cell.roi_pct.toFixed(1)}% ROI
      </p>
      <p className="text-[10px] text-gray-500 mt-0.5">N={cell.picks}</p>
    </div>
  );
}

export function LeadTimeGrid({ byLeadTime, meta }: LeadTimeGridProps) {
  const [open, setOpen] = useState(true);

  const totalPicks = MARKETS.reduce((sum, m) => sum + BUCKETS.reduce((s, b) => s + (byLeadTime[b.key][m.key]?.picks ?? 0), 0), 0);
  const populatedCells = MARKETS.flatMap((m) => BUCKETS.map((b) => byLeadTime[b.key][m.key])).filter((c) => c?.has_min_sample).length;

  return (
    <details
      className="bg-gray-900 border border-gray-800 rounded-lg mb-6 group"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer p-4 flex items-center justify-between hover:bg-gray-900/60">
        <div>
          <p className="text-sm font-semibold text-white">Lead-time analysis</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Pick performance by hours-before-first-pitch · {populatedCells}/{MARKETS.length * BUCKETS.length} cells populated · N={totalPicks} graded
          </p>
        </div>
        <span className="text-xs text-gray-600 group-open:rotate-180 transition-transform" aria-hidden>▼</span>
      </summary>

      <div className="px-4 pb-4 space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="py-2 pr-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Market</th>
                {BUCKETS.map((b) => (
                  <th key={b.key} className="py-2 px-3 text-center text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <span className="block">{b.label}</span>
                    <span className="block text-[10px] text-gray-600 normal-case">{b.sub}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MARKETS.map((m) => (
                <tr key={m.key} className="border-t border-gray-800/60">
                  <td className="py-3 pr-3 text-sm font-medium text-gray-200">{m.label}</td>
                  {BUCKETS.map((b) => {
                    const cell = byLeadTime[b.key][m.key];
                    return (
                      <td key={b.key} className="py-3 px-3 align-middle">
                        {cell ? <CellContents cell={cell} sampleMin={meta.sample_min} /> : <span className="text-gray-700">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-gray-800 pt-3 space-y-2 text-xs text-gray-500">
          <p>
            Each pick is counted as an independent stake-unit. Cells require ≥{meta.sample_min} graded
            outcomes before metrics display. Picks generated after first pitch are excluded
            ({meta.excluded_no_lead_time} excluded).
          </p>
          <p className="text-gray-600">
            Past performance does not predict future results. Confidence tiers retrain monthly as
            graded outcomes accumulate.
          </p>
        </div>
      </div>
    </details>
  );
}
