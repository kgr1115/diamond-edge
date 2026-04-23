'use client';

import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { PickCard } from './pick-card';
import { ShapAttributionRow } from './shap-attribution-row';
import { LineMovementSparkline } from './line-movement-sparkline';
import { SlateFilters } from './slate-filters';
import { DailyExposureMeter } from './daily-exposure-meter';
import Link from 'next/link';

interface ShapAttribution {
  feature: string;
  value: number;
  direction: 'positive' | 'negative';
}

interface OddsSnapshot {
  label: string;
  price: number;
}

interface PickData {
  id: string;
  game: {
    id: string;
    home_team: { id: string; name: string; abbreviation: string };
    away_team: { id: string; name: string; abbreviation: string };
    game_time_utc: string | null;
    status: string;
  };
  market: string;
  pick_side: string;
  confidence_tier: number;
  required_tier: string;
  result: string;
  best_line_price?: number;
  best_line_book?: string;
  model_probability?: number;
  expected_value?: number;
  rationale_preview?: string;
  shap_attributions?: ShapAttribution[];
  line_snapshots?: OddsSnapshot[];
  has_note?: boolean;
}

interface SlatePicksGridProps {
  picks: PickData[];
  userTier: 'anon' | 'free' | 'pro' | 'elite';
  meta?: {
    pipeline_ran: boolean;
    games_analyzed: number;
    below_threshold: number;
    ev_threshold: number;
    confidence_threshold: number;
  };
}

function parseEvParam(raw: string | null): number {
  const n = parseFloat(raw ?? '');
  return isNaN(n) ? 4 : Math.min(10, Math.max(0, n));
}

function parseTierParam(raw: string | null): number[] {
  if (!raw) return [1, 2, 3, 4, 5];
  const parsed = raw.split(',').map(Number).filter((n) => n >= 1 && n <= 5);
  return parsed.length > 0 ? parsed : [1, 2, 3, 4, 5];
}

function parseMarketParam(raw: string | null): string[] {
  const valid = ['moneyline', 'run_line', 'total'];
  if (!raw) return valid;
  const parsed = raw.split(',').filter((m) => valid.includes(m));
  return parsed.length > 0 ? parsed : valid;
}

function ZeroState({
  userTier,
  meta,
  filtered,
}: {
  userTier: 'anon' | 'free' | 'pro' | 'elite';
  meta?: SlatePicksGridProps['meta'];
  filtered: boolean;
}) {
  return (
    <div className="text-center py-16 space-y-4 max-w-md mx-auto">
      <p className="text-gray-300 font-semibold text-lg">
        {filtered ? 'No picks match your filters.' : 'No qualifying picks today.'}
      </p>

      {!filtered && meta ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-left space-y-2 text-sm">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Pipeline diagnostic</p>
          <ul className="space-y-1 text-gray-400">
            <li>
              Pipeline ran:{' '}
              <span className={meta.pipeline_ran ? 'text-emerald-400' : 'text-red-400'}>
                {meta.pipeline_ran ? 'Yes' : 'No — check back later'}
              </span>
            </li>
            {meta.pipeline_ran && (
              <>
                <li>Games analyzed: <span className="text-white">{meta.games_analyzed}</span></li>
                <li>
                  Below threshold: <span className="text-white">{meta.below_threshold}</span>
                  <span className="text-gray-600 text-xs ml-1">
                    (EV &lt; {(meta.ev_threshold * 100).toFixed(0)}% or Tier &lt; {meta.confidence_threshold})
                  </span>
                </li>
              </>
            )}
          </ul>
        </div>
      ) : !filtered ? (
        <p className="text-sm text-gray-500">
          Our model requires EV &gt; 4% — on lighter slates, no picks qualify.
        </p>
      ) : null}

      <div className="flex items-center justify-center gap-4 flex-wrap pt-2">
        <Link href="/history" className="text-sm text-blue-400 hover:underline">
          View pick history
        </Link>
        {userTier === 'elite' && (
          <Link href="/picks/today?visibility=shadow" className="text-sm text-amber-400 hover:underline">
            View shadow picks (Elite)
          </Link>
        )}
      </div>
    </div>
  );
}

export function SlatePicksGrid({ picks, userTier, meta }: SlatePicksGridProps) {
  const searchParams = useSearchParams();

  const ev = parseEvParam(searchParams.get('ev'));
  const tiers = parseTierParam(searchParams.get('tier'));
  const markets = parseMarketParam(searchParams.get('market'));

  const filtered = useMemo(() => {
    return picks.filter((p) => {
      const evPct = (p.expected_value ?? 0) * 100;
      if (evPct < ev) return false;
      if (!tiers.includes(p.confidence_tier)) return false;
      if (!markets.includes(p.market)) return false;
      return true;
    });
  }, [picks, ev, tiers, markets]);

  const isActiveFilter = ev !== 4 || tiers.length !== 5 || markets.length !== 3;

  return (
    <div className="space-y-4">
      {/* Daily exposure meter */}
      {(userTier === 'pro' || userTier === 'elite') && (
        <DailyExposureMeter />
      )}

      {/* Filter bar */}
      <SlateFilters totalPicks={picks.length} visiblePicks={filtered.length} />

      {/* Grid or zero state */}
      {filtered.length === 0 ? (
        <ZeroState userTier={userTier} meta={meta} filtered={isActiveFilter} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((pick) => (
            <article key={pick.id} className="flex flex-col">
              <PickCard pick={pick} userTier={userTier} />

              {userTier === 'elite' && pick.shap_attributions && pick.shap_attributions.length > 0 && (
                <div className="mt-1 px-4 pb-3 bg-gray-900 border border-t-0 border-gray-800 rounded-b-lg">
                  <ShapAttributionRow attributions={pick.shap_attributions} limit={3} />
                </div>
              )}

              {(userTier === 'pro' || userTier === 'elite') &&
                pick.line_snapshots &&
                pick.line_snapshots.length >= 2 && (
                  <div className="mt-1 px-4 py-2 bg-gray-900/60 border border-t-0 border-gray-800/60 rounded-b-lg">
                    <p className="text-xs text-gray-600 mb-1">Line movement</p>
                    <LineMovementSparkline
                      snapshots={pick.line_snapshots}
                      pickSide={pick.pick_side}
                    />
                  </div>
                )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
