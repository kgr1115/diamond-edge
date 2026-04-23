'use client';

import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { PickCard } from './pick-card';
import { ShapAttributionRow } from './shap-attribution-row';
import { LineMovementSparkline } from './line-movement-sparkline';
import { AllPicksFilters, useAllPicksFilters } from './all-picks-filters';
import type { MarketFilter, MinStrengthFilter, VisibilityFilter, SortFilter } from './all-picks-filters';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Types — mirrors PickData from slate-picks-grid + visibility field
// ---------------------------------------------------------------------------

interface ShapAttribution {
  feature: string;
  value: number;
  direction: 'positive' | 'negative';
}

interface OddsSnapshot {
  label: string;
  price: number;
}

export interface AllPickData {
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
  visibility: 'live' | 'shadow';
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

interface AllPicksGridProps {
  picks: AllPickData[];
  userTier: 'anon' | 'free' | 'pro' | 'elite';
}

// ---------------------------------------------------------------------------
// Client-side filtering + sorting
// ---------------------------------------------------------------------------

function applyFilters(
  picks: AllPickData[],
  market: MarketFilter,
  minStrength: MinStrengthFilter,
  visibility: VisibilityFilter,
  sort: SortFilter,
  minEv: number,
): AllPickData[] {
  const filtered = picks.filter((p) => {
    if (market !== 'all' && p.market !== market) return false;

    const minTier = minStrength === 'all' ? 1 : parseInt(minStrength, 10);
    if (p.confidence_tier < minTier) return false;

    if (visibility === 'live' && p.visibility !== 'live') return false;

    const evPct = (p.expected_value ?? 0) * 100;
    if (evPct < minEv) return false;

    return true;
  });

  return [...filtered].sort((a, b) => {
    if (sort === 'ev') {
      return (b.expected_value ?? 0) - (a.expected_value ?? 0);
    }
    if (sort === 'confidence') {
      return b.confidence_tier - a.confidence_tier;
    }
    // game_time
    const aTime = a.game.game_time_utc ? new Date(a.game.game_time_utc).getTime() : Infinity;
    const bTime = b.game.game_time_utc ? new Date(b.game.game_time_utc).getTime() : Infinity;
    return aTime - bTime;
  });
}

// ---------------------------------------------------------------------------
// Shadow pick badge — visually distinguishes shadow picks in the grid
// ---------------------------------------------------------------------------

function ShadowBadge() {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/60 font-medium"
      title="Shadow pick — below publish threshold (EV < 8% or confidence < 5)"
    >
      Shadow
    </span>
  );
}

// ---------------------------------------------------------------------------
// Zero state
// ---------------------------------------------------------------------------

function ZeroState({ filtered }: { filtered: boolean }) {
  return (
    <div className="text-center py-16 space-y-4 max-w-md mx-auto">
      <p className="text-gray-300 font-semibold text-lg">
        {filtered ? 'No picks match your filters.' : 'No picks for today yet.'}
      </p>
      {!filtered && (
        <p className="text-sm text-gray-500">
          The pipeline may still be running. Check back shortly.
        </p>
      )}
      <Link href="/history" className="text-sm text-blue-400 hover:underline">
        View pick history
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AllPicksGrid({ picks, userTier }: AllPicksGridProps) {
  const searchParams = useSearchParams();
  const { market, minStrength, visibility, sort, minEv } = useAllPicksFilters();

  const filtered = useMemo(
    () => applyFilters(picks, market, minStrength, visibility, sort, minEv),
    [picks, market, minStrength, visibility, sort, minEv]
  );

  const isActiveFilter =
    market !== 'all' ||
    minStrength !== 'all' ||
    visibility !== 'all' ||
    sort !== 'ev' ||
    minEv !== 0;

  return (
    <div className="space-y-4">
      <AllPicksFilters totalPicks={picks.length} visiblePicks={filtered.length} />

      {filtered.length === 0 ? (
        <ZeroState filtered={isActiveFilter} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((pick) => (
            <article key={pick.id} className="flex flex-col">
              {/* Shadow label sits above the card so it doesn't collide with card chrome */}
              {pick.visibility === 'shadow' && (
                <div className="mb-1 flex justify-end">
                  <ShadowBadge />
                </div>
              )}

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
