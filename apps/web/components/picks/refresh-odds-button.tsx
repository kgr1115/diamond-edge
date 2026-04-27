'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  /** Only render the button if the user is Elite tier. */
  userTier: 'anon' | 'free' | 'pro' | 'elite';
}

/**
 * Manual odds-refresh button for Elite users. Triggers the Odds API poll
 * on demand (e.g., to check lines before placing a bet). Cron still runs
 * the routine 10am ET refresh; this is the ad-hoc escape hatch.
 */
export function RefreshOddsButton({ userTier }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'success'; rows: number; graded: number; durationMs: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  if (userTier === 'pro') {
    // Visible but disabled so Pro users discover the capability without
    // implying they can use it. Copy stays informational — no false
    // entitlement claim, no "click to upgrade" trickery.
    return (
      <button
        type="button"
        disabled
        title="On-demand odds refresh + pick grading is an Elite feature."
        aria-label="On-demand odds refresh + pick grading is an Elite feature."
        className="text-xs px-3 py-1.5 rounded border border-gray-800 bg-gray-900/60 text-gray-600 cursor-not-allowed"
      >
        Refresh odds + grade (Elite)
      </button>
    );
  }

  if (userTier !== 'elite') return null;

  async function handleClick() {
    setStatus({ kind: 'idle' });
    try {
      const res = await fetch('/api/odds/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const msg = data?.error?.message ?? data?.errors?.[0] ?? 'Refresh failed.';
        setStatus({ kind: 'error', message: msg });
        return;
      }
      setStatus({
        kind: 'success',
        rows: data.rowsInserted ?? 0,
        graded: data.gradedCount ?? 0,
        durationMs: data.durationMs ?? 0,
      });
      startTransition(() => router.refresh());
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error.',
      });
    }
  }

  const label = isPending
    ? 'Refreshing…'
    : status.kind === 'success'
      ? status.rows === 0 && status.graded === 0
        ? 'Already current'
        : `Updated (${status.rows} odds${status.graded > 0 ? `, ${status.graded} graded` : ''})`
      : status.kind === 'error'
        ? 'Retry'
        : 'Refresh odds + grade';

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className={`text-xs px-3 py-1.5 rounded border transition-colors ${
          isPending
            ? 'bg-gray-800 border-gray-700 text-gray-500 cursor-wait'
            : status.kind === 'error'
              ? 'bg-red-900/20 border-red-800 text-red-300 hover:bg-red-900/40'
              : 'bg-gray-900 border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white'
        }`}
      >
        {label}
      </button>
      {status.kind === 'error' ? (
        <span className="text-xs text-red-400 max-w-[200px] text-right">{status.message}</span>
      ) : null}
    </div>
  );
}
