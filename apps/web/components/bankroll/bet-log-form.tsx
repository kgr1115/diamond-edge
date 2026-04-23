'use client';

import { useState } from 'react';

interface BetLogFormProps {
  onSuccess: () => void;
}

/** Validate American odds format: integer, optionally prefixed with + or - */
function isValidOdds(val: string): boolean {
  return /^[+-]?\d+$/.test(val.trim()) && Math.abs(parseInt(val)) >= 100;
}

export function BetLogForm({ onSuccess }: BetLogFormProps) {
  const [betDate, setBetDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const [market, setMarket] = useState('');
  const [sportsbook, setSportsbook] = useState('');
  const [amountDollars, setAmountDollars] = useState('');
  const [odds, setOdds] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function validate(): boolean {
    const errors: Record<string, string> = {};
    if (!betDate) errors.betDate = 'Date is required.';
    if (!amountDollars || parseFloat(amountDollars) <= 0)
      errors.amount = 'Amount must be a positive number.';
    if (!odds || !isValidOdds(odds)) errors.odds = 'Enter valid American odds (e.g. -110, +150).';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    setError(null);

    const body = {
      bet_date: betDate,
      description: description || undefined,
      market: market || undefined,
      // Map sportsbook name to a lookup — the API expects sportsbook_id but we pass name for v1
      sportsbook_id: undefined as string | undefined,
      bet_amount_cents: Math.round(parseFloat(amountDollars) * 100),
      odds_price: parseInt(odds),
      notes: notes || undefined,
    };

    try {
      const res = await fetch('/api/bankroll/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? 'Failed to log bet.');
        return;
      }
      onSuccess();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Date *</label>
          <input
            type="date"
            value={betDate}
            onChange={(e) => setBetDate(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            required
          />
          {fieldErrors.betDate && <p className="text-xs text-red-400 mt-1">{fieldErrors.betDate}</p>}
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Market</label>
          <select
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
          >
            <option value="">Any</option>
            <option value="moneyline">Moneyline</option>
            <option value="run_line">Run Line</option>
            <option value="total">Total</option>
            <option value="prop">Prop</option>
          </select>
        </div>
      </div>

      <div>
        <label className="text-xs text-gray-400 block mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Yankees ML vs Red Sox"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 block mb-1">Sportsbook</label>
          <select
            value={sportsbook}
            onChange={(e) => setSportsbook(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
          >
            <option value="">Select…</option>
            <option value="draftkings">DraftKings</option>
            <option value="fanduel">FanDuel</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Amount ($) *</label>
          <input
            type="number"
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            placeholder="50.00"
            min="0.01"
            step="0.01"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            required
          />
          {fieldErrors.amount && <p className="text-xs text-red-400 mt-1">{fieldErrors.amount}</p>}
        </div>
      </div>

      <div>
        <label className="text-xs text-gray-400 block mb-1">Odds (American) *</label>
        <input
          type="text"
          value={odds}
          onChange={(e) => setOdds(e.target.value)}
          placeholder="-110 or +150"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm"
          required
        />
        {fieldErrors.odds && <p className="text-xs text-red-400 mt-1">{fieldErrors.odds}</p>}
      </div>

      <div>
        <label className="text-xs text-gray-400 block mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm resize-none"
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-medium py-2 rounded transition-colors"
      >
        {loading ? 'Saving…' : 'Log Bet'}
      </button>
    </form>
  );
}
