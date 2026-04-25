/**
 * Outcome panel for graded picks. Renders at the TOP of /picks/[id] when a
 * pick_outcomes row exists. Shows final score, W/L/P/V badge, PnL units, and
 * graded-at date. PnL is computed at render-time via computePnL from
 * outcome-grader/lib.ts (pick_outcomes has no pnl_units column).
 */

import { computePnL, type PickResult } from '@/lib/outcome-grader/lib';

interface PickOutcomePanelProps {
  result: PickResult;
  homeScore: number;
  awayScore: number;
  homeAbbr: string;
  awayAbbr: string;
  gradedAt: string;
  bestLinePrice: number | null;
}

const RESULT_CONFIG: Record<PickResult, { label: string; chipClass: string }> = {
  win:  { label: 'WIN',  chipClass: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50' },
  loss: { label: 'LOSS', chipClass: 'bg-red-900/60 text-red-300 border-red-700/50' },
  push: { label: 'PUSH', chipClass: 'bg-gray-800 text-gray-300 border-gray-700/50' },
  void: { label: 'VOID', chipClass: 'bg-gray-800 text-gray-400 border-gray-700/50' },
};

function formatPnL(pnl: number): string {
  if (pnl === 0) return '0.00 units';
  const sign = pnl > 0 ? '+' : '';
  const noun = Math.abs(pnl) === 1 ? 'unit' : 'units';
  return `${sign}${pnl.toFixed(2)} ${noun}`;
}

function formatGradedAt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

export function PickOutcomePanel({
  result,
  homeScore,
  awayScore,
  homeAbbr,
  awayAbbr,
  gradedAt,
  bestLinePrice,
}: PickOutcomePanelProps) {
  const config = RESULT_CONFIG[result];
  const pnl = computePnL(result, bestLinePrice);
  const pnlClass = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-red-400' : 'text-gray-400';

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`px-3 py-1 rounded text-sm font-bold uppercase tracking-wide border ${config.chipClass}`}
            aria-label={`Result: ${config.label}`}
          >
            {config.label}
          </span>
          <span className="text-xs text-gray-500 uppercase tracking-wide">Final</span>
        </div>
        <span className={`text-lg font-mono font-semibold ${pnlClass}`}>
          {formatPnL(pnl)}
        </span>
      </div>

      <div className="text-2xl font-bold text-white font-mono">
        {homeAbbr} {homeScore} <span className="text-gray-500">–</span> {awayScore} {awayAbbr}
      </div>

      <p className="text-xs text-gray-500">
        Graded {formatGradedAt(gradedAt)}
      </p>
    </div>
  );
}
