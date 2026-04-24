/**
 * Inline sparkline for line movement across odds snapshots.
 * Three snapshots (morning / afternoon / evening) → tiny SVG path.
 * Server Component — no interactivity needed.
 *
 * Pure direction/probability logic lives in lib/picks/line-movement.ts so
 * it can be unit-tested without a JSX jest transform.
 */

import {
  computeLineDirection,
  formatOdds,
  pickSideImpliedProb,
  type OddsSnapshot,
} from '@/lib/picks/line-movement';

interface LineMovementSparklineProps {
  snapshots: OddsSnapshot[];
  pickSide: 'home' | 'away' | 'over' | 'under' | string;
}

const W = 72;
const H = 24;
const PAD = 3;

export function LineMovementSparkline({ snapshots, pickSide }: LineMovementSparklineProps) {
  if (snapshots.length < 2) return null;

  const probs = snapshots.map((s) => pickSideImpliedProb(s.price, pickSide));
  const minP = Math.min(...probs);
  const maxP = Math.max(...probs);
  const range = maxP - minP || 0.01;

  const pts = probs.map((p, i) => {
    const x = PAD + (i / (probs.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (p - minP) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const direction = computeLineDirection(snapshots, pickSide);
  const arrowColor =
    direction === 'shortened' ? 'text-emerald-400' : direction === 'lengthened' ? 'text-red-400' : 'text-gray-500';
  const arrow = direction === 'shortened' ? '▲' : direction === 'lengthened' ? '▼' : '—';

  const first = snapshots[0].price;
  const last = snapshots[snapshots.length - 1].price;

  return (
    <div
      className="flex items-center gap-2"
      title={`Line movement — ${snapshots.map((s) => `${s.label}: ${formatOdds(s.price)}`).join(' → ')}`}
      aria-label={`Line ${direction} from ${formatOdds(first)} to ${formatOdds(last)}`}
    >
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        aria-hidden="true"
        className="flex-shrink-0"
      >
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke={direction === 'shortened' ? '#34d399' : direction === 'lengthened' ? '#f87171' : '#6b7280'}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Endpoint dot */}
        <circle
          cx={parseFloat(pts[pts.length - 1].split(',')[0])}
          cy={parseFloat(pts[pts.length - 1].split(',')[1])}
          r={2}
          fill={direction === 'shortened' ? '#34d399' : direction === 'lengthened' ? '#f87171' : '#6b7280'}
        />
      </svg>
      <span className={`text-xs font-mono ${arrowColor}`}>{arrow} {formatOdds(last)}</span>
      <span className="text-xs text-gray-600">{pickSide}</span>
    </div>
  );
}
