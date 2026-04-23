'use client';

import { useEffect, useState, useCallback } from 'react';
import { BetLogForm } from '@/components/bankroll/bet-log-form';

interface BankrollSummary {
  total_wagered_cents: number;
  total_profit_loss_cents: number;
  roi_pct: number;
  win_count: number;
  loss_count: number;
  push_count: number;
  void_count: number;
  pending_count: number;
  win_rate: number;
}

interface BankrollEntry {
  id: string;
  bet_date: string;
  description: string | null;
  market: string | null;
  sportsbook: string | null;
  bet_amount_cents: number;
  odds_price: number;
  outcome: string | null;
  profit_loss_cents: number | null;
  settled_at: string | null;
  pick_id: string | null;
  notes: string | null;
}

function formatCents(cents: number): string {
  const sign = cents >= 0 ? '+' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatOdds(price: number): string {
  return price >= 0 ? `+${price}` : `${price}`;
}

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-xs text-gray-500">Pending</span>;
  const styles: Record<string, string> = {
    win: 'text-emerald-400',
    loss: 'text-red-400',
    push: 'text-yellow-400',
    void: 'text-gray-500',
  };
  return (
    <span className={`text-xs capitalize ${styles[outcome] ?? 'text-gray-400'}`}>{outcome}</span>
  );
}

export function BankrollDashboardClient() {
  const [summary, setSummary] = useState<BankrollSummary | null>(null);
  const [entries, setEntries] = useState<BankrollEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bankroll');
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary);
        setEntries(data.entries ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this bet entry?')) return;
    setDeletingId(id);
    try {
      await fetch(`/api/bankroll/entry/${id}`, { method: 'DELETE' });
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return <div className="text-gray-500 text-sm animate-pulse">Loading bankroll data…</div>;
  }

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      {summary ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total Wagered', value: `$${(summary.total_wagered_cents / 100).toFixed(2)}` },
            {
              label: 'P&L',
              value: formatCents(summary.total_profit_loss_cents),
              highlight: summary.total_profit_loss_cents >= 0 ? 'text-emerald-400' : 'text-red-400',
            },
            { label: 'ROI', value: `${summary.roi_pct.toFixed(1)}%` },
            { label: 'Win Rate', value: `${(summary.win_rate * 100).toFixed(0)}%` },
          ].map((stat) => (
            <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
              <p className={`text-lg font-bold ${stat.highlight ?? 'text-white'}`}>{stat.value}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* Log a bet button */}
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-400">
          {summary?.win_count ?? 0}W–{summary?.loss_count ?? 0}L–{summary?.push_count ?? 0}P{' '}
          ({summary?.pending_count ?? 0} pending)
        </p>
        <button
          onClick={() => setShowForm(true)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded transition-colors"
        >
          Log a Bet
        </button>
      </div>

      {/* Log bet form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h2 className="font-semibold text-white">Log a Bet</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-500 hover:text-white text-xl">
                ×
              </button>
            </div>
            <div className="p-4">
              <BetLogForm
                onSuccess={() => {
                  setShowForm(false);
                  fetchData();
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Entries table */}
      {entries.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <p className="text-gray-400">No bets logged yet.</p>
          <p className="text-sm text-gray-600">Start tracking your bets to see your ROI.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs text-gray-500 uppercase">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Description</th>
                <th className="py-2 pr-4">Market</th>
                <th className="py-2 pr-4">Book</th>
                <th className="py-2 pr-4 text-right">Amount</th>
                <th className="py-2 pr-4 text-right">Odds</th>
                <th className="py-2 pr-4">Outcome</th>
                <th className="py-2 pr-4 text-right">P&L</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                  <td className="py-3 pr-4 text-gray-400 whitespace-nowrap">{entry.bet_date}</td>
                  <td className="py-3 pr-4 text-gray-200 max-w-xs truncate">
                    {entry.description ?? '—'}
                  </td>
                  <td className="py-3 pr-4 text-gray-400 uppercase text-xs">{entry.market ?? '—'}</td>
                  <td className="py-3 pr-4 text-gray-400">{entry.sportsbook ?? '—'}</td>
                  <td className="py-3 pr-4 text-right text-gray-200">
                    ${(entry.bet_amount_cents / 100).toFixed(2)}
                  </td>
                  <td className="py-3 pr-4 text-right font-mono text-gray-300">
                    {formatOdds(entry.odds_price)}
                  </td>
                  <td className="py-3 pr-4">
                    <OutcomeBadge outcome={entry.outcome} />
                  </td>
                  <td className="py-3 pr-4 text-right">
                    {entry.profit_loss_cents !== null ? (
                      <span
                        className={
                          entry.profit_loss_cents >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }
                      >
                        {formatCents(entry.profit_loss_cents)}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-3">
                    <button
                      onClick={() => handleDelete(entry.id)}
                      disabled={deletingId === entry.id}
                      className="text-xs text-gray-600 hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                      {deletingId === entry.id ? '…' : 'Del'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
