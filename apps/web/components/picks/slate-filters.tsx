'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MarketFilter = 'all' | 'moneyline' | 'run_line' | 'total';
export type MinStrengthFilter = 'all' | '2' | '3' | '4' | '5';
export type VisibilityFilter = 'all' | 'live';
export type SortFilter = 'ev' | 'game_time' | 'confidence';

export interface SlateFilterValues {
  market: MarketFilter;
  minStrength: MinStrengthFilter;
  visibility: VisibilityFilter;
  sort: SortFilter;
  minEv: number;
}

// ---------------------------------------------------------------------------
// URL param helpers
// ---------------------------------------------------------------------------

function parseMarket(raw: string | null): MarketFilter {
  const valid: MarketFilter[] = ['all', 'moneyline', 'run_line', 'total'];
  return valid.includes(raw as MarketFilter) ? (raw as MarketFilter) : 'all';
}

function parseMinStrength(raw: string | null): MinStrengthFilter {
  const valid: MinStrengthFilter[] = ['all', '2', '3', '4', '5'];
  return valid.includes(raw as MinStrengthFilter) ? (raw as MinStrengthFilter) : 'all';
}

function parseVisibility(raw: string | null): VisibilityFilter {
  return raw === 'live' ? 'live' : 'all';
}

function parseSort(raw: string | null): SortFilter {
  const valid: SortFilter[] = ['ev', 'game_time', 'confidence'];
  return valid.includes(raw as SortFilter) ? (raw as SortFilter) : 'ev';
}

function parseEvParam(raw: string | null): number {
  const n = parseFloat(raw ?? '');
  return isNaN(n) ? 0 : Math.min(10, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Hook — exposes parsed filter values for the grid to consume
// ---------------------------------------------------------------------------

export function useSlateFilters(): SlateFilterValues {
  const searchParams = useSearchParams();
  return {
    market: parseMarket(searchParams.get('market')),
    minStrength: parseMinStrength(searchParams.get('minStrength')),
    visibility: parseVisibility(searchParams.get('visibility')),
    sort: parseSort(searchParams.get('sort')),
    minEv: parseEvParam(searchParams.get('ev')),
  };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SlateFiltersProps {
  totalPicks: number;
  visiblePicks: number;
  /** When false, the visibility toggle is hidden (free/anon only ever see live). */
  canSeeShadow: boolean;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SegmentGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <p className="text-xs text-gray-500 mb-2">{label}</p>
      <div className="flex flex-wrap gap-1" role="group" aria-label={label}>
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              aria-pressed={active}
              className={`text-xs px-3 py-1 rounded border transition-colors ${
                active
                  ? 'bg-blue-700 border-blue-600 text-white font-medium'
                  : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SlateFilters({ totalPicks, visiblePicks, canSeeShadow }: SlateFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const market = parseMarket(searchParams.get('market'));
  const minStrength = parseMinStrength(searchParams.get('minStrength'));
  const visibility = parseVisibility(searchParams.get('visibility'));
  const sort = parseSort(searchParams.get('sort'));
  const minEv = parseEvParam(searchParams.get('ev'));

  // Local EV state during drag — commits to URL only on release for smooth UX
  const [localEv, setLocalEv] = useState(minEv);
  useEffect(() => { setLocalEv(minEv); }, [minEv]);

  const isFiltered =
    market !== 'all' ||
    minStrength !== 'all' ||
    (canSeeShadow && visibility !== 'all') ||
    sort !== 'ev' ||
    minEv !== 0;

  const pushParams = useCallback(
    (next: {
      market: MarketFilter;
      minStrength: MinStrengthFilter;
      visibility: VisibilityFilter;
      sort: SortFilter;
      ev: number;
    }) => {
      const p = new URLSearchParams(searchParams.toString());
      if (next.market === 'all') p.delete('market'); else p.set('market', next.market);
      if (next.minStrength === 'all') p.delete('minStrength'); else p.set('minStrength', next.minStrength);
      if (next.visibility === 'all') p.delete('visibility'); else p.set('visibility', next.visibility);
      if (next.sort === 'ev') p.delete('sort'); else p.set('sort', next.sort);
      if (next.ev === 0) p.delete('ev'); else p.set('ev', String(next.ev));
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  function update(patch: Partial<{ market: MarketFilter; minStrength: MinStrengthFilter; visibility: VisibilityFilter; sort: SortFilter; ev: number }>) {
    pushParams({ market, minStrength, visibility, sort, ev: minEv, ...patch });
  }

  function commitEv(val: number) {
    pushParams({ market, minStrength, visibility, sort, ev: val });
  }

  function reset() {
    setLocalEv(0);
    router.replace(pathname, { scroll: false });
  }

  const marketOptions: { value: MarketFilter; label: string }[] = [
    { value: 'all',        label: 'All'       },
    { value: 'moneyline',  label: 'Moneyline' },
    { value: 'run_line',   label: 'Run Line'  },
    { value: 'total',      label: 'Totals'    },
  ];

  // Label vocabulary mirrors components/picks/confidence-badge.tsx TIER_LABELS.
  // Source of truth for tier gate values: SHADOW_TIER_MIN / LIVE_TIER_MIN in
  // supabase/functions/pick-pipeline/index.ts. Tiers 1/2 ("Low") are below the
  // shadow gate and should not appear in today's slate; they may still appear
  // on /history for legacy rows.
  const strengthOptions: { value: MinStrengthFilter; label: string }[] = [
    { value: 'all', label: 'All picks'          },
    { value: '2',   label: 'Low and above'      },
    { value: '3',   label: 'Moderate and above' },
    { value: '4',   label: 'High and above'     },
    { value: '5',   label: 'Strong only'        },
  ];

  const sortOptions: { value: SortFilter; label: string }[] = [
    { value: 'ev',         label: 'EV (highest first)'      },
    { value: 'game_time',  label: 'Game time (soonest)'     },
    { value: 'confidence', label: 'Confidence (highest)'    },
  ];

  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-lg p-3 sm:p-4 space-y-4"
      role="search"
      aria-label="Filter picks"
    >
      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Filters</h2>
        <div className="flex items-center gap-3">
          {isFiltered && (
            <span className="text-xs text-gray-400">
              Showing{' '}
              <span className="text-white font-semibold">{visiblePicks}</span>
              {' '}of{' '}
              <span className="text-white font-semibold">{totalPicks}</span>
              {' '}picks
            </span>
          )}
          {isFiltered && (
            <button
              onClick={reset}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              aria-label="Reset all filters"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Row 1: Market (+ Visibility for Pro+) */}
      <div className={`grid grid-cols-1 ${canSeeShadow ? 'sm:grid-cols-2' : ''} gap-4`}>
        <SegmentGroup
          label="Market"
          options={marketOptions}
          value={market}
          onChange={(v) => update({ market: v })}
        />

        {canSeeShadow && (
          <div>
            <p className="text-xs text-gray-500 mb-2">Visibility</p>
            <div className="flex gap-2 flex-wrap" role="group" aria-label="Visibility filter">
              <button
                onClick={() => update({ visibility: 'all' })}
                aria-pressed={visibility === 'all'}
                className={`text-xs px-3 py-1 rounded border transition-colors ${
                  visibility === 'all'
                    ? 'bg-blue-700 border-blue-600 text-white font-medium'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                Include shadow picks
              </button>
              <button
                onClick={() => update({ visibility: 'live' })}
                aria-pressed={visibility === 'live'}
                className={`text-xs px-3 py-1 rounded border transition-colors ${
                  visibility === 'live'
                    ? 'bg-blue-700 border-blue-600 text-white font-medium'
                    : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
              >
                Published only
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-2 leading-snug">
              Shadow picks fall just under our publishing threshold (EV / confidence). Tracked for transparency and ROI study, not promoted as recommendations.
            </p>
          </div>
        )}
      </div>

      {/* Row 2: Min strength + Sort + EV slider */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div>
          <label htmlFor="slate-strength" className="text-xs text-gray-500 block mb-2">
            Minimum strength
          </label>
          <select
            id="slate-strength"
            value={minStrength}
            onChange={(e) => update({ minStrength: e.target.value as MinStrengthFilter })}
            className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {strengthOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="slate-sort" className="text-xs text-gray-500 block mb-2">
            Sort by
          </label>
          <select
            id="slate-sort"
            value={sort}
            onChange={(e) => update({ sort: e.target.value as SortFilter })}
            className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="slate-ev" className="text-xs text-gray-500 block mb-2">
            Min EV:{' '}
            <span className="text-white font-semibold">{localEv.toFixed(0)}%</span>
          </label>
          <input
            id="slate-ev"
            type="range"
            min={0}
            max={10}
            step={1}
            value={localEv}
            onChange={(e) => setLocalEv(Number(e.target.value))}
            onPointerUp={(e) => commitEv(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commitEv(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitEv(Number((e.target as HTMLInputElement).value))}
            className="w-full accent-blue-500 cursor-pointer"
            aria-valuemin={0}
            aria-valuemax={10}
            aria-valuenow={localEv}
            aria-valuetext={`${localEv}% minimum EV`}
          />
          <div className="flex justify-between text-xs text-gray-700 mt-0.5">
            <span>0%</span>
            <span>10%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
