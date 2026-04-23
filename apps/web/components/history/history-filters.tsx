'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

interface HistoryFiltersProps {
  market: string;
  result: string;
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

export function HistoryFilters({ market, result, dateFrom, dateTo }: HistoryFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete('page'); // reset to page 1 on filter change
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  return (
    <fieldset className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <legend className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-1 mb-3">
        Filters
      </legend>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label htmlFor="filter-market" className="text-xs text-gray-500 block mb-1">
            Market
          </label>
          <select
            id="filter-market"
            value={market}
            onChange={(e) => updateParam('market', e.target.value)}
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
            value={result}
            onChange={(e) => updateParam('result', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
          >
            {RESULTS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
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
            value={dateFrom}
            onChange={(e) => updateParam('date_from', e.target.value)}
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
            value={dateTo}
            onChange={(e) => updateParam('date_to', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
          />
        </div>
      </div>
    </fieldset>
  );
}
