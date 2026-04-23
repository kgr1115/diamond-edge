'use client';

import { useState } from 'react';

export function ManageSubscriptionClient() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="mt-2 text-xs text-gray-500 hover:text-gray-300 underline disabled:opacity-50"
    >
      {loading ? 'Opening…' : 'Manage subscription'}
    </button>
  );
}
