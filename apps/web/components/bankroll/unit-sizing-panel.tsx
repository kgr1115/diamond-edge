'use client';

import { useState, useEffect } from 'react';

const STORAGE_KEY = 'de_unit_size_pct';
const STORAGE_BANKROLL_KEY = 'de_bankroll_dollars';

interface UnitSizingPanelProps {
  onUnitChange?: (unitPct: number, bankrollDollars: number) => void;
}

export function UnitSizingPanel({ onUnitChange }: UnitSizingPanelProps) {
  const [unitPct, setUnitPct] = useState<number>(1);
  const [bankrollDollars, setBankrollDollars] = useState<number>(1000);
  const [editing, setEditing] = useState(false);

  // Persist user preferences across sessions
  useEffect(() => {
    const savedPct = localStorage.getItem(STORAGE_KEY);
    const savedBankroll = localStorage.getItem(STORAGE_BANKROLL_KEY);
    if (savedPct) setUnitPct(parseFloat(savedPct));
    if (savedBankroll) setBankrollDollars(parseFloat(savedBankroll));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(unitPct));
    localStorage.setItem(STORAGE_BANKROLL_KEY, String(bankrollDollars));
    onUnitChange?.(unitPct, bankrollDollars);
  }, [unitPct, bankrollDollars, onUnitChange]);

  const unitDollars = (bankrollDollars * unitPct) / 100;

  if (!editing) {
    return (
      <div
        className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between gap-4 cursor-pointer hover:border-gray-600 transition-colors"
        onClick={() => setEditing(true)}
        role="button"
        tabIndex={0}
        aria-label="Edit unit sizing settings"
        onKeyDown={(e) => e.key === 'Enter' && setEditing(true)}
      >
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Unit size</p>
          <p className="text-sm font-semibold text-white">
            {unitPct}% of bankroll
            <span className="text-gray-400 font-normal ml-2">
              = ${unitDollars.toFixed(0)} / unit
            </span>
          </p>
          <p className="text-xs text-gray-600 mt-0.5">Bankroll: ${bankrollDollars.toLocaleString()}</p>
        </div>
        <button
          className="text-xs text-blue-400 hover:text-blue-300 transition-colors whitespace-nowrap"
          aria-hidden="true"
          tabIndex={-1}
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-blue-800/60 rounded-lg p-4 space-y-3">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Unit Sizing</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="bankroll-input" className="text-xs text-gray-400 block mb-1">
            Bankroll ($)
          </label>
          <input
            id="bankroll-input"
            type="number"
            min={1}
            step={100}
            value={bankrollDollars}
            onChange={(e) => setBankrollDollars(Math.max(1, parseFloat(e.target.value) || 0))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
          />
        </div>
        <div>
          <label htmlFor="unit-pct-input" className="text-xs text-gray-400 block mb-1">
            Unit size (% of bankroll)
          </label>
          <input
            id="unit-pct-input"
            type="number"
            min={0.1}
            max={25}
            step={0.5}
            value={unitPct}
            onChange={(e) => setUnitPct(Math.min(25, Math.max(0.1, parseFloat(e.target.value) || 1)))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
          />
        </div>
      </div>
      <p className="text-sm text-gray-300">
        1 unit = <span className="font-semibold text-white">${unitDollars.toFixed(2)}</span>
      </p>
      <button
        onClick={() => setEditing(false)}
        className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors"
      >
        Save
      </button>
    </div>
  );
}

/** Inline Kelly suggestion for a single pick. Pure calculation — no state. */
interface KellySuggestionProps {
  modelProbability: number;
  oddsPrice: number;
  unitPct: number;
  bankrollDollars: number;
  fractionOfKelly?: number; // default 0.25
}

export function KellySuggestion({
  modelProbability,
  oddsPrice,
  unitPct,
  bankrollDollars,
  fractionOfKelly = 0.25,
}: KellySuggestionProps) {
  // Kelly formula: f = (p * b - q) / b where b = decimal odds - 1
  // American to decimal: +150 → 2.5, -110 → 1.909
  const decimalOdds = oddsPrice >= 0
    ? oddsPrice / 100 + 1
    : 100 / Math.abs(oddsPrice) + 1;

  const b = decimalOdds - 1;
  const q = 1 - modelProbability;
  const fullKelly = (modelProbability * b - q) / b;
  const fractionalKelly = fullKelly * fractionOfKelly;

  if (fullKelly <= 0) return null; // negative edge — no suggestion

  const unitDollars = (bankrollDollars * unitPct) / 100;
  const suggestedDollars = bankrollDollars * fractionalKelly;
  const suggestedUnits = unitDollars > 0 ? suggestedDollars / unitDollars : 0;

  return (
    <div className="text-xs text-gray-400" aria-label={`Kelly stake suggestion: ${(fractionOfKelly * 100).toFixed(0)}% Kelly`}>
      <span className="text-gray-500">Suggested ({(fractionOfKelly * 100).toFixed(0)}%-Kelly):{' '}</span>
      <span className="text-white font-medium">{suggestedUnits.toFixed(2)}u</span>
      <span className="text-gray-500 ml-1">= ${suggestedDollars.toFixed(0)}</span>
    </div>
  );
}
