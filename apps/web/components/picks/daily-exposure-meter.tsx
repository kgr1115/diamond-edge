'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface ExposureData {
  today_exposure_cents: number;
  bankroll_dollars: number;
  daily_cap_pct: number;
}

function fetchExposure(): Promise<ExposureData | null> {
  return fetch('/api/bankroll/exposure')
    .then((r) => r.ok ? r.json() : null)
    .catch(() => null);
}

function meterColor(pct: number): string {
  if (pct < 60) return 'bg-emerald-500';
  if (pct < 90) return 'bg-amber-400';
  return 'bg-red-500';
}

function labelColor(pct: number): string {
  if (pct < 60) return 'text-emerald-400';
  if (pct < 90) return 'text-amber-400';
  return 'text-red-400';
}

export function DailyExposureMeter() {
  const [data, setData] = useState<ExposureData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchExposure().then((d) => {
      setData(d);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="h-10 bg-gray-900 border border-gray-800 rounded-lg animate-pulse" />
    );
  }

  if (!data) return null;

  const capCents = (data.bankroll_dollars * data.daily_cap_pct) / 100 * 100;
  const exposurePct = capCents > 0 ? Math.min((data.today_exposure_cents / capCents) * 100, 100) : 0;
  const usedPctOfBankroll = data.bankroll_dollars > 0
    ? (data.today_exposure_cents / 100 / data.bankroll_dollars) * 100
    : 0;

  return (
    <Link
      href="/bankroll"
      className="block group"
      aria-label={`Daily exposure: ${usedPctOfBankroll.toFixed(1)}% of bankroll staked today. Click to configure.`}
    >
      <div className="bg-gray-900 border border-gray-800 group-hover:border-gray-600 rounded-lg px-4 py-3 transition-colors">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs text-gray-500">Today&apos;s exposure</p>
          <p className={`text-xs font-semibold ${labelColor(exposurePct)}`}>
            {usedPctOfBankroll.toFixed(1)}% of bankroll
            <span className="text-gray-600 font-normal ml-1">/ {data.daily_cap_pct}% cap</span>
          </p>
        </div>
        {/* Progress bar */}
        <div
          className="h-1.5 bg-gray-800 rounded-full overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(exposurePct)}
          aria-label="Daily exposure vs cap"
        >
          <div
            className={`h-full rounded-full transition-all duration-300 ${meterColor(exposurePct)}`}
            style={{ width: `${exposurePct}%` }}
          />
        </div>
      </div>
    </Link>
  );
}
