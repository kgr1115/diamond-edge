/**
 * Visual indicator for confidence tier (1–5).
 * Uses diamond shapes (on-brand) in a dark-mode-first color scheme.
 */

interface ConfidenceBadgeProps {
  tier: number;
  showLabel?: boolean;
}

const TIER_LABELS: Record<number, string> = {
  1: 'Speculative',
  2: 'Low',
  3: 'Moderate',
  4: 'High',
  5: 'Strong',
};

const TIER_COLORS: Record<number, string> = {
  1: 'text-gray-500',
  2: 'text-blue-400',
  3: 'text-yellow-400',
  4: 'text-orange-400',
  5: 'text-emerald-400',
};

export function ConfidenceBadge({ tier, showLabel = false }: ConfidenceBadgeProps) {
  const safeTier = Math.min(Math.max(Math.round(tier), 1), 5);
  const color = TIER_COLORS[safeTier];
  const label = TIER_LABELS[safeTier];

  return (
    <span className={`inline-flex items-center gap-1 ${color}`} title={`Confidence: ${label}`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={`text-xs ${i < safeTier ? 'opacity-100' : 'opacity-20'}`}
          aria-hidden="true"
        >
          ◆
        </span>
      ))}
      {showLabel && <span className="text-xs ml-1 font-medium">{label}</span>}
    </span>
  );
}
