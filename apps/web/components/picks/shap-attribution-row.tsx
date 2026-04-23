/**
 * Renders the top-N SHAP feature attributions for a pick.
 * Used on the slate card (top-3) and pick detail (all).
 * Server Component.
 */

interface ShapAttribution {
  feature: string;
  value: number;
  direction: 'positive' | 'negative';
}

interface ShapAttributionRowProps {
  attributions: ShapAttribution[];
  limit?: number;
}

export function ShapAttributionRow({ attributions, limit = 3 }: ShapAttributionRowProps) {
  const visible = attributions.slice(0, limit);
  if (visible.length === 0) return null;

  return (
    <div className="border-t border-gray-800 pt-2 mt-2" aria-label="Model feature drivers">
      <p className="text-xs text-gray-500 mb-1">Edge driven by:</p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {visible.map((attr, i) => (
          <span key={i} className="text-xs text-gray-400">
            {attr.feature}{' '}
            <span className={attr.direction === 'positive' ? 'text-emerald-400' : 'text-red-400'}>
              ({attr.direction === 'positive' ? '+' : ''}{attr.value.toFixed(3)})
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
