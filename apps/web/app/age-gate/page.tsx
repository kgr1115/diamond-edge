'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function AgeGateForm() {
  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect') ?? '/picks/today';

  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!month || !day || !year) return;

    setLoading(true);
    setFailed(false);

    const dob = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

    try {
      const res = await fetch('/api/auth/age-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_of_birth: dob, method: 'dob_entry' }),
      });

      if (res.ok) {
        window.location.href = redirect;
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  if (failed) {
    return (
      <div className="text-center space-y-4">
        <div className="text-red-400 text-lg font-semibold">
          You must be 21 or older to use Diamond Edge.
        </div>
        <p className="text-sm text-gray-500">
          If you or someone you know needs support, call{' '}
          <a href="tel:18005224700" className="underline">1-800-522-4700</a> (National Problem
          Gambling Helpline, 24/7, free).
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-300">Date of birth</p>
        <div className="flex gap-3">
          <div className="flex-1">
            <label htmlFor="month" className="text-xs text-gray-500 block mb-1">Month</label>
            <select
              id="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              required
            >
              <option value="">Month</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {new Date(2000, i).toLocaleString('en-US', { month: 'long' })}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="day" className="text-xs text-gray-500 block mb-1">Day</label>
            <select
              id="day"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              required
            >
              <option value="">Day</option>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>{i + 1}</option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="year" className="text-xs text-gray-500 block mb-1">Year</label>
            <input
              id="year"
              type="number"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="YYYY"
              min={1900}
              max={new Date().getFullYear()}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              required
            />
          </div>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading || !month || !day || !year}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded transition-colors"
      >
        {loading ? 'Verifying…' : 'Confirm Age'}
      </button>
    </form>
  );
}

export default function AgeGatePage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-sm w-full space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-white">Diamond Edge</h1>
          <p className="text-gray-400 text-sm">
            You must be <strong className="text-white">21 or older</strong> to access this site.
          </p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <Suspense fallback={<div className="text-gray-500 text-sm text-center">Loading…</div>}>
            <AgeGateForm />
          </Suspense>
        </div>

        <p className="text-xs text-gray-600 text-center">
          Problem gambling?{' '}
          <a href="tel:18005224700" className="underline">1-800-522-4700</a>
        </p>
      </div>
    </div>
  );
}
