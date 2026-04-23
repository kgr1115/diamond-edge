'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

interface SlateFiltersProps {
  totalPicks: number;
  visiblePicks: number;
}

const TIER_OPTIONS = [1, 2, 3, 4, 5] as const;
const MARKET_OPTIONS = [
  { value: 'moneyline', label: 'ML' },
  { value: 'run_line', label: 'RL' },
  { value: 'total', label: 'O/U' },
] as const;

function parseEvParam(raw: string | null): number {
  const n = parseFloat(raw ?? '');
  return isNaN(n) ? 4 : Math.min(10, Math.max(0, n));
}

function parseTierParam(raw: string | null): number[] {
  if (!raw) return [1, 2, 3, 4, 5];
  const parsed = raw.split(',').map(Number).filter((n) => n >= 1 && n <= 5);
  return parsed.length > 0 ? parsed : [1, 2, 3, 4, 5];
}

function parseMarketParam(raw: string | null): string[] {
  const valid = ['moneyline', 'run_line', 'total'];
  if (!raw) return valid;
  const parsed = raw.split(',').filter((m) => valid.includes(m));
  return parsed.length > 0 ? parsed : valid;
}

export function useSlateFilters() {
  const searchParams = useSearchParams();
  const ev = parseEvParam(searchParams.get('ev'));
  const tiers = parseTierParam(searchParams.get('tier'));
  const markets = parseMarketParam(searchParams.get('market'));
  return { ev, tiers, markets };
}

export function SlateFilters({ totalPicks, visiblePicks }: SlateFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const ev = parseEvParam(searchParams.get('ev'));
  const tiers = parseTierParam(searchParams.get('tier'));
  const markets = parseMarketParam(searchParams.get('market'));

  const isFiltered =
    ev !== 4 ||
    tiers.length !== 5 ||
    markets.length !== 3;

  const pushParams = useCallback(
    (next: { ev: number; tiers: number[]; markets: string[] }) => {
      const p = new URLSearchParams(searchParams.toString());
      p.set('ev', String(next.ev));
      p.set('tier', next.tiers.join(','));
      p.set('market', next.markets.join(','));
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  function resetFilters() {
    router.replace(pathname, { scroll: false });
  }

  function handleEvChange(val: number) {
    pushParams({ ev: val, tiers, markets });
  }

  function toggleTier(tier: number) {
    const next = tiers.includes(tier)
      ? tiers.filter((t) => t !== tier)
      : [...tiers, tier].sort();
    // Don't allow deselecting all tiers
    if (next.length === 0) return;
    pushParams({ ev, tiers: next, markets });
  }

  function toggleMarket(market: string) {
    const next = markets.includes(market)
      ? markets.filter((m) => m !== market)
      : [...markets, market];
    if (next.length === 0) return;
    pushParams({ ev, tiers, markets: next });
  }

  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4"
      role="search"
      aria-label="Filter picks"
    >
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
              onClick={resetFilters}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              aria-label="Reset all filters"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* EV threshold slider */}
        <div>
          <label htmlFor="ev-slider" className="text-xs text-gray-500 block mb-2">
            Min EV:{' '}
            <span className="text-white font-semibold">{ev.toFixed(0)}%</span>
          </label>
          <input
            id="ev-slider"
            type="range"
            min={0}
            max={10}
            step={1}
            value={ev}
            onChange={(e) => handleEvChange(Number(e.target.value))}
            className="w-full accent-blue-500 cursor-pointer"
            aria-valuemin={0}
            aria-valuemax={10}
            aria-valuenow={ev}
            aria-valuetext={`${ev}% minimum EV`}
          />
          <div className="flex justify-between text-xs text-gray-700 mt-0.5">
            <span>0%</span>
            <span>10%</span>
          </div>
        </div>

        {/* Confidence tier checkboxes */}
        <div>
          <p className="text-xs text-gray-500 mb-2">Confidence tier</p>
          <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Confidence tier filter">
            {TIER_OPTIONS.map((t) => (
              <button
                key={t}
                onClick={() => toggleTier(t)}
                aria-pressed={tiers.includes(t)}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                  tiers.includes(t)
                    ? 'bg-blue-700 border-blue-600 text-white'
                    : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'
                }`}
              >
                T{t}
              </button>
            ))}
          </div>
        </div>

        {/* Market checkboxes */}
        <div>
          <p className="text-xs text-gray-500 mb-2">Market</p>
          <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Market filter">
            {MARKET_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => toggleMarket(value)}
                aria-pressed={markets.includes(value)}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                  markets.includes(value)
                    ? 'bg-blue-700 border-blue-600 text-white'
                    : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
