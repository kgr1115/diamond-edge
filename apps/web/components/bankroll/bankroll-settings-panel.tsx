'use client';

import { useState, useEffect, useCallback } from 'react';

interface BankrollSettings {
  bankroll_unit_pct: number;
  daily_exposure_cap_pct: number;
  kelly_fraction: number;
}

const DEFAULTS: BankrollSettings = {
  bankroll_unit_pct: 1.0,
  daily_exposure_cap_pct: 3.0,
  kelly_fraction: 0.25,
};

async function loadSettings(): Promise<BankrollSettings> {
  const res = await fetch('/api/bankroll/settings');
  if (!res.ok) return DEFAULTS;
  return res.json();
}

async function saveSettings(settings: BankrollSettings): Promise<boolean> {
  const res = await fetch('/api/bankroll/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  return res.ok;
}

interface FieldProps {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function NumberField({ id, label, hint, value, min, max, step, onChange }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="text-xs text-gray-400 block mb-1">
        {label}
        <span className="text-gray-600 ml-1 font-normal">{hint}</span>
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:ring-1 focus:ring-blue-600"
      />
    </div>
  );
}

export function BankrollSettingsPanel() {
  const [settings, setSettings] = useState<BankrollSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    loadSettings().then((s) => {
      setSettings(s);
      setLoading(false);
    });
  }, [open]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    const ok = await saveSettings(settings);
    setSaving(false);
    if (ok) {
      setSavedAt(new Date().toLocaleTimeString());
    } else {
      setError('Failed to save settings. Please try again.');
    }
  }, [settings]);

  function patch(field: keyof BankrollSettings, value: number) {
    setSettings((prev) => ({ ...prev, [field]: value }));
    setSavedAt(null);
  }

  const unitDollarsHint = `(1u = ~$${((1000 * settings.bankroll_unit_pct) / 100).toFixed(0)} on $1,000 bankroll)`;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/40 transition-colors"
        aria-expanded={open}
        aria-controls="bankroll-settings-body"
      >
        <span className="text-sm font-semibold text-gray-300">Bankroll Settings</span>
        <span className="text-gray-500 text-xs">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div id="bankroll-settings-body" className="px-4 pb-4 space-y-4 border-t border-gray-800">
          {loading ? (
            <p className="text-sm text-gray-500 animate-pulse py-3">Loading settings…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4">
                <NumberField
                  id="setting-unit-pct"
                  label="Unit size"
                  hint="% of bankroll"
                  value={settings.bankroll_unit_pct}
                  min={0.1}
                  max={25}
                  step={0.5}
                  onChange={(v) => patch('bankroll_unit_pct', v)}
                />
                <NumberField
                  id="setting-exposure-cap"
                  label="Daily exposure cap"
                  hint="% of bankroll"
                  value={settings.daily_exposure_cap_pct}
                  min={0.5}
                  max={20}
                  step={0.5}
                  onChange={(v) => patch('daily_exposure_cap_pct', v)}
                />
                <NumberField
                  id="setting-kelly-fraction"
                  label="Kelly fraction"
                  hint="0.1 – 1.0"
                  value={settings.kelly_fraction}
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  onChange={(v) => patch('kelly_fraction', v)}
                />
              </div>

              <p className="text-xs text-gray-600">{unitDollarsHint}</p>

              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs" aria-live="polite">
                  {saving && <span className="text-gray-500">Saving…</span>}
                  {!saving && error && <span className="text-red-400">{error}</span>}
                  {!saving && !error && savedAt && (
                    <span className="text-emerald-400">Saved {savedAt}</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-1.5 rounded transition-colors"
                >
                  {saving ? 'Saving…' : 'Save settings'}
                </button>
              </div>

              <p className="text-xs text-gray-700 border-t border-gray-800 pt-3">
                Settings persist to your profile. Kelly fraction is applied to the per-pick suggestion
                (0.25 = quarter-Kelly, the default for recreational sharp play).
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
