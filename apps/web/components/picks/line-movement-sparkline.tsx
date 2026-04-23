/**
 * Inline sparkline for line movement across odds snapshots.
 * Three snapshots (morning / afternoon / evening) → tiny SVG path.
 * Server Component — no interactivity needed.
 */

interface OddsSnapshot {
  label: string; // 'AM' | 'PM' | 'Close'
  price: number; // American odds
}

interface LineMovementSparklineProps {
  snapshots: OddsSnapshot[];
  pickSide: 'home' | 'away' | 'over' | 'under' | string;
}

function formatOdds(price: number): string {
  return price >= 0 ? `+${price}` : `${price}`;
}

/** Convert American odds to implied probability (raw, with vig). */
function impliedProb(price: number): number {
  if (price >= 100) return 100 / (100 + price);
  return Math.abs(price) / (Math.abs(price) + 100);
}

const W = 72;
const H = 24;
const PAD = 3;

export function LineMovementSparkline({ snapshots, pickSide }: LineMovementSparklineProps) {
  if (snapshots.length < 2) return null;

  const probs = snapshots.map((s) => impliedProb(s.price));
  const minP = Math.min(...probs);
  const maxP = Math.max(...probs);
  const range = maxP - minP || 0.01;

  const pts = probs.map((p, i) => {
    const x = PAD + (i / (probs.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (p - minP) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const first = snapshots[0].price;
  const last = snapshots[snapshots.length - 1].price;
  const moved = last - first;

  // Positive moved toward pick side (line got shorter / prob rose) = favorable
  const direction = moved > 0 ? 'shortened' : moved < 0 ? 'lengthened' : 'flat';
  const arrowColor =
    direction === 'shortened' ? 'text-emerald-400' : direction === 'lengthened' ? 'text-red-400' : 'text-gray-500';
  const arrow = direction === 'shortened' ? '▲' : direction === 'lengthened' ? '▼' : '—';

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
