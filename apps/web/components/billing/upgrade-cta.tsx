'use client';

import { useState } from 'react';

interface UpgradeCtaProps {
  tier: 'pro' | 'elite';
  size?: 'xs' | 'sm' | 'md';
  label?: string;
}

// NEXT_PUBLIC_PAID_TIERS=false → upgrade button renders nothing. The full Stripe
// integration below is preserved as portfolio reference; flipping the env var
// back to true restores the working checkout flow without code changes.
const PAID_TIERS_ENABLED = process.env.NEXT_PUBLIC_PAID_TIERS === 'true';

const SIZE_CLASSES = {
  xs: 'text-xs px-2 py-1',
  sm: 'text-sm px-3 py-1.5',
  md: 'text-sm px-4 py-2',
};

const TIER_STYLES = {
  pro: 'bg-blue-600 hover:bg-blue-500 text-white',
  elite: 'bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-white',
};

/**
 * Upgrade CTA button. Calls POST /api/billing/checkout and redirects to Stripe.
 * Handles loading state. If TASK-009 routes are not wired, shows a disabled state.
 */
export function UpgradeCta({ tier, size = 'sm', label }: UpgradeCtaProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!PAID_TIERS_ENABLED) return null;

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? 'Unable to start checkout.');
        return;
      }
      // Redirect to Stripe-hosted checkout
      window.location.href = data.url;
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const defaultLabel = tier === 'pro' ? 'Upgrade to Pro' : 'Go Elite';

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        onClick={handleClick}
        disabled={loading}
        className={`
          ${SIZE_CLASSES[size]}
          ${TIER_STYLES[tier]}
          rounded font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed
          inline-flex items-center gap-1.5
        `}
      >
        {loading ? (
          <>
            <span className="animate-spin inline-block w-3 h-3 border border-current border-t-transparent rounded-full" />
            Redirecting…
          </>
        ) : (
          label ?? defaultLabel
        )}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
