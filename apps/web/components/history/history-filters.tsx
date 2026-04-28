'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

interface HistoryFiltersProps {
  market: string;
  result: string;
  confidenceTier: string;
  dateFrom: string;
  dateTo: string;
}

interface PendingState {
  market: string;
  result: string;
  confidenceTier: string;
  dateFrom: string;
  dateTo: string;
}

const MARKETS = [
  { value: '', label: 'All markets' },
  { value: 'moneyline', label: 'Moneyline' },
  { value: 'run_line', label: 'Run Line' },
  { value: 'total', label: 'Totals' },
  { value: 'prop', label: 'Props' },
];

const RESULTS = [
  { value: '', label: 'All results' },
  { value: 'win', label: 'Won' },
  { value: 'loss', label: 'Lost' },
  { value: 'push', label: 'Push' },
  { value: 'pending', label: 'Pending' },
];

const CONFIDENCE_TIERS = [
  { value: '',  label: 'All tiers' },
  { value: '5', label: 'Tier 5 — Strong' },
  { value: '4', label: 'Tier 4 — High' },
  { value: '3', label: 'Tier 3 — Moderate' },
];

const EMPTY: PendingState = { market: '', result: '', confidenceTier: '', dateFrom: '', dateTo: '' };

function hrefFromState(pathname: string, s: PendingState): string {
  const params = new URLSearchParams();
  if (s.market) params.set('market', s.market);
  if (s.result) params.set('result', s.result);
  if (s.confidenceTier) params.set('confidence_tier', s.confidenceTier);
  if (s.dateFrom) params.set('date_from', s.dateFrom);
  if (s.dateTo) params.set('date_to', s.dateTo);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function statesEqual(a: PendingState, b: PendingState): boolean {
  return a.market === b.market
    && a.result === b.result
    && a.confidenceTier === b.confidenceTier
    && a.dateFrom === b.dateFrom
    && a.dateTo === b.dateTo;
}

export function HistoryFilters({ market, result, confidenceTier, dateFrom, dateTo }: HistoryFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();

  const applied: PendingState = { market, result, confidenceTier, dateFrom, dateTo };
  const [pending, setPending] = useState<PendingState>(applied);

  // If the URL changes externally (back button, link click, programmatic
  // navigation), re-sync local state to the new applied filters.
  useEffect(() => {
    setPending({ market, result, confidenceTier, dateFrom, dateTo });
  }, [market, result, confidenceTier, dateFrom, dateTo]);

  const dirty = !statesEqual(pending, applied);
  const hasPending = !statesEqual(pending, EMPTY);
  const hasApplied = !statesEqual(applied, EMPTY);

  const set = useCallback(<K extends keyof PendingState>(key: K, value: PendingState[K]) => {
    setPending((prev) => ({ ...prev, [key]: value }));
  }, []);

  const apply = useCallback(() => {
    router.push(hrefFromState(pathname, pending));
  }, [router, pathname, pending]);

  const clear = useCallback(() => {
    setPending(EMPTY);
    router.push(pathname);
  }, [router, pathname]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    apply();
  }, [apply]);

  return (
    <form onSubmit={handleSubmit}>
      <fieldset className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <legend className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-1 mb-3">
          Filters
          {dirty && (
            <span className="ml-2 normal-case text-amber-400 font-normal">
              · unapplied changes
            </span>
          )}
        </legend>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <label htmlFor="filter-market" className="text-xs text-gray-500 block mb-1">
              Market
            </label>
            <select
              id="filter-market"
              value={pending.market}
              onChange={(e) => set('market', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
            >
              {MARKETS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-result" className="text-xs text-gray-500 block mb-1">
              Result
            </label>
            <select
              id="filter-result"
              value={pending.result}
              onChange={(e) => set('result', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
            >
              {RESULTS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-confidence" className="text-xs text-gray-500 block mb-1">
              Confidence Tier
            </label>
            <select
              id="filter-confidence"
              value={pending.confidenceTier}
              onChange={(e) => set('confidenceTier', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
            >
              {CONFIDENCE_TIERS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-date-from" className="text-xs text-gray-500 block mb-1">
              From
            </label>
            <input
              id="filter-date-from"
              type="date"
              value={pending.dateFrom}
              onChange={(e) => set('dateFrom', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
          </div>

          <div>
            <label htmlFor="filter-date-to" className="text-xs text-gray-500 block mb-1">
              To
            </label>
            <input
              id="filter-date-to"
              type="date"
              value={pending.dateTo}
              onChange={(e) => set('dateTo', e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            type="submit"
            disabled={!dirty && !hasPending}
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400"
            aria-label="Apply filters"
          >
            Apply Filters
          </button>
          {(hasApplied || hasPending) && (
            <button
              type="button"
              onClick={clear}
              className="px-3 py-2 rounded text-gray-300 hover:text-white text-sm transition-colors focus:outline-none focus:ring-1 focus:ring-gray-500"
              aria-label="Clear all filters"
            >
              Clear
            </button>
          )}
          {dirty && (
            <p className="text-xs text-gray-500">
              Press Apply to run the filter, or Clear to reset.
            </p>
          )}
        </div>
      </fieldset>
    </form>
  );
}
