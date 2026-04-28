'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

interface SlateDatePickerProps {
  /** Currently displayed pick_date (YYYY-MM-DD in ET). */
  value: string;
  /** Earliest date selectable. Today's ET date — picks haven't been generated for past days here. */
  min?: string;
  /** Latest date selectable. Today + LOOKAHEAD_DAYS in ET. */
  max?: string;
}

export function SlateDatePicker({ value, min, max }: SlateDatePickerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onChange = useCallback(
    (next: string) => {
      if (!next || !/^\d{4}-\d{2}-\d{2}$/.test(next)) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set('date', next);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  return (
    <label className="inline-flex items-center gap-2 text-sm text-gray-300">
      <span className="text-xs text-gray-500 uppercase tracking-wide">Date</span>
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-600"
        aria-label="Pick date"
      />
    </label>
  );
}
