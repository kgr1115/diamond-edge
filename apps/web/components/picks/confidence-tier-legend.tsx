/**
 * Compact, prominent legend explaining the confidence-tier color treatment
 * applied to picks across the slate. Mirrors the colors in
 * components/picks/confidence-badge.tsx and the cell highlights in
 * components/picks/game-strip.tsx.
 */

const LEGEND = [
  { tier: 5, label: 'Strong',   diamond: 'text-emerald-400', ring: 'ring-emerald-500/60', bg: 'bg-emerald-500/10' },
  { tier: 4, label: 'High',     diamond: 'text-orange-400',  ring: 'ring-orange-500/60',  bg: 'bg-orange-500/10' },
  { tier: 3, label: 'Moderate', diamond: 'text-yellow-400',  ring: 'ring-yellow-500/60',  bg: 'bg-yellow-500/10' },
];

export function ConfidenceTierLegend() {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Confidence Legend
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            Pick cells are highlighted by the model&apos;s confidence tier.
          </p>
        </div>
        <ul className="flex items-center gap-3 flex-wrap">
          {LEGEND.map((entry) => (
            <li
              key={entry.tier}
              className={`flex items-center gap-2 px-2 py-1 rounded ring-1 ${entry.ring} ${entry.bg}`}
            >
              <span className={`${entry.diamond}`} aria-hidden>
                {Array.from({ length: entry.tier }).map((_, i) => (
                  <span key={i} className="text-xs">◆</span>
                ))}
              </span>
              <span className="text-xs font-medium text-gray-200">{entry.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
