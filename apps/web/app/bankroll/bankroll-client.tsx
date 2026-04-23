'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { BetLogForm } from '@/components/bankroll/bet-log-form';
import { DrawdownChart } from '@/components/charts/drawdown-chart';
import { UnitSizingPanel } from '@/components/bankroll/unit-sizing-panel';

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
  units_won_7d: number;
  units_won_30d: number;
  units_won_all: number;
  dollars_won_7d: number;
  dollars_won_30d: number;
  dollars_won_all: number;
  open_exposure_cents: number;
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

interface CumulativePoint {
  date: string;
  cumulative_units: number;
}

type PnLWindow = '7d' | '30d' | 'all';

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
  const [cumulativeSeries, setCumulativeSeries] = useState<CumulativePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pnlWindow, setPnlWindow] = useState<PnLWindow>('30d');
  const [unitPct, setUnitPct] = useState(1);
  const [bankrollDollars, setBankrollDollars] = useState(1000);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/bankroll');
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary);
        setEntries(data.entries ?? []);
        setCumulativeSeries(data.cumulative_series ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function handleUnitChange(newUnitPct: number, newBankroll: number) {
    setUnitPct(newUnitPct);
    setBankrollDollars(newBankroll);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this bet entry?')) return;
    setDeletingId(id);
    // Optimistic removal
    setEntries((prev) => prev.filter((e) => e.id !== id));
    try {
      await fetch(`/api/bankroll/entry/${id}`, { method: 'DELETE' });
    } catch {
      // If delete fails, refetch to reconcile
      fetchData();
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return <div className="text-gray-500 text-sm animate-pulse">Loading bankroll data…</div>;
  }

  const unitDollars = (bankrollDollars * unitPct) / 100;

  // P&L for selected window
  const plCents =
    pnlWindow === '7d'
      ? (summary?.dollars_won_7d ?? 0)
      : pnlWindow === '30d'
      ? (summary?.dollars_won_30d ?? 0)
      : (summary?.dollars_won_all ?? 0);

  const exposureUnits = unitDollars > 0 ? (summary?.open_exposure_cents ?? 0) / 100 / unitDollars : 0;

  return (
    <div className="space-y-6">
      {/* Unit Sizing Panel */}
      <UnitSizingPanel onUnitChange={handleUnitChange} />

      {/* Summary stats */}
      {summary ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total Wagered', value: `$${(summary.total_wagered_cents / 100).toFixed(2)}` },
            {
              label: 'P&L (All-time)',
              value: formatCents(summary.total_profit_loss_cents),
              highlight: summary.total_profit_loss_cents >= 0 ? 'text-emerald-400' : 'text-red-400',
            },
            { label: 'ROI', value: `${summary.roi_pct >= 0 ? '+' : ''}${summary.roi_pct.toFixed(1)}%` },
            { label: 'Win Rate', value: `${(summary.win_rate * 100).toFixed(0)}%` },
          ].map((stat) => (
            <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
              <p className={`text-lg font-bold ${stat.highlight ?? 'text-white'}`}>{stat.value}</p>
            </div>
          ))}
        </div>
      ) : null}

      {/* Running P&L by window */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-gray-300">Running P&amp;L</h2>
          <div className="flex gap-1" role="group" aria-label="P&L time window">
            {(['7d', '30d', 'all'] as PnLWindow[]).map((w) => (
              <button
                key={w}
                onClick={() => setPnlWindow(w)}
                className={`text-xs px-2.5 py-1 rounded transition-colors ${
                  pnlWindow === w
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white border border-gray-700'
                }`}
                aria-pressed={pnlWindow === w}
              >
                {w === 'all' ? 'All time' : w}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-gray-500 mb-1">
              P&amp;L ({pnlWindow === 'all' ? 'all time' : `last ${pnlWindow}`})
            </p>
            <p className={`text-xl font-bold ${plCents >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatCents(plCents)}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Open exposure</p>
            <p className="text-xl font-bold text-amber-400">
              {exposureUnits.toFixed(2)}u
            </p>
            <p className="text-xs text-gray-600">
              = ${((summary?.open_exposure_cents ?? 0) / 100).toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">W–L–P (pending)</p>
            <p className="text-sm font-semibold text-white">
              {summary?.win_count ?? 0}–{summary?.loss_count ?? 0}–{summary?.push_count ?? 0}{' '}
              <span className="text-gray-500">({summary?.pending_count ?? 0})</span>
            </p>
          </div>
        </div>
      </div>

      {/* Drawdown chart */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Cumulative Units (Drawdown View)</h2>
        <DrawdownChart data={cumulativeSeries} />
      </div>

      {/* Log a bet button */}
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-500">
          1 unit = ${unitDollars.toFixed(2)} at ${bankrollDollars.toLocaleString()} bankroll
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
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Log a bet"
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md">
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h2 className="font-semibold text-white">Log a Bet</h2>
              <button
                onClick={() => setShowForm(false)}
                className="text-gray-500 hover:text-white text-xl"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="p-4">
              <p className="text-xs text-gray-500 mb-3">
                1 unit = ${unitDollars.toFixed(2)} (${bankrollDollars.toLocaleString()} bankroll, {unitPct}%)
              </p>
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
          <p className="text-sm text-gray-600">Start tracking your bets to see your ROI and drawdown chart.</p>
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
                <th className="py-2 pr-4 text-right">Units</th>
                <th className="py-2 pr-4 text-right">Odds</th>
                <th className="py-2 pr-4">Outcome</th>
                <th className="py-2 pr-4 text-right">P&L</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const units = unitDollars > 0 ? entry.bet_amount_cents / 100 / unitDollars : 0;
                return (
                  <tr key={entry.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
                    <td className="py-3 pr-4 text-gray-400 whitespace-nowrap text-xs">{entry.bet_date}</td>
                    <td className="py-3 pr-4 text-gray-200 max-w-xs truncate text-xs">
                      {entry.description ?? '—'}
                    </td>
                    <td className="py-3 pr-4 text-gray-400 uppercase text-xs">{entry.market ?? '—'}</td>
                    <td className="py-3 pr-4 text-gray-400 text-xs">{entry.sportsbook ?? '—'}</td>
                    <td className="py-3 pr-4 text-right text-gray-200 text-xs">
                      ${(entry.bet_amount_cents / 100).toFixed(2)}
                    </td>
                    <td className="py-3 pr-4 text-right text-gray-400 text-xs">
                      {units.toFixed(2)}u
                    </td>
                    <td className="py-3 pr-4 text-right font-mono text-gray-300 text-xs">
                      {formatOdds(entry.odds_price)}
                    </td>
                    <td className="py-3 pr-4">
                      <OutcomeBadge outcome={entry.outcome} />
                    </td>
                    <td className="py-3 pr-4 text-right text-xs">
                      {entry.profit_loss_cents !== null ? (
                        <span className={entry.profit_loss_cents >= 0 ? 'text-emerald-400' : 'text-red-400'}>
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
                        aria-label={`Delete bet from ${entry.bet_date}`}
                      >
                        {deletingId === entry.id ? '…' : 'Del'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
