'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { PickCard } from './pick-card';
import { ShapAttributionRow } from './shap-attribution-row';
import { LineMovementSparkline } from './line-movement-sparkline';
import { SlateFilters, useSlateFilters } from './slate-filters';
import type {
  MarketFilter,
  MinStrengthFilter,
  VisibilityFilter,
  SortFilter,
} from './slate-filters';
import { DailyExposureMeter } from './daily-exposure-meter';
import { UpgradeCta } from '@/components/billing/upgrade-cta';

// Render the thin-slate transparency diagnostic above the grid when the server
// returned fewer live picks than this threshold (strictly less than). The count
// is on live picks only so Pro/Elite (who see live+shadow) get a truthful read.
const THIN_SLATE_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Types
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
  visibility: 'live' | 'shadow';
  result: string;
  best_line_price?: number;
  best_line_book?: string;
  total_line?: number;
  run_line_spread?: number;
  model_probability?: number;
  expected_value?: number;
  rationale_preview?: string;
  shap_attributions?: ShapAttribution[];
  line_snapshots?: OddsSnapshot[];
  has_note?: boolean;
  odds_stale?: boolean;
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
    last_odds_snapshot_at: string | null;
    odds_stale: boolean;
  };
}

// ---------------------------------------------------------------------------
// Client-side filter + sort
// ---------------------------------------------------------------------------

function applyFilters(
  picks: PickData[],
  market: MarketFilter,
  minStrength: MinStrengthFilter,
  visibility: VisibilityFilter,
  sort: SortFilter,
  minEv: number,
): PickData[] {
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
    const aTime = a.game.game_time_utc ? new Date(a.game.game_time_utc).getTime() : Infinity;
    const bTime = b.game.game_time_utc ? new Date(b.game.game_time_utc).getTime() : Infinity;
    return aTime - bTime;
  });
}

// ---------------------------------------------------------------------------
// Shadow badge
// ---------------------------------------------------------------------------

function ShadowBadge() {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/60 font-medium"
      title="Shadow pick — below publish threshold (EV < 8% or confidence < Strong)"
    >
      Shadow
    </span>
  );
}

// ---------------------------------------------------------------------------
// Zero state
// ---------------------------------------------------------------------------

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
          {!meta.pipeline_ran && (
            <div className="mt-2 inline-block bg-amber-950/40 border border-amber-900/60 rounded px-2 py-1 text-xs text-amber-300">
              Picks run at 12:00 PM ET daily (11:00 AM ET in winter). Today&apos;s picks appear here after that.
            </div>
          )}
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
          <Link href="/picks/today?visibility=all" className="text-sm text-amber-400 hover:underline">
            Include shadow picks
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thin-slate transparency diagnostic
// ---------------------------------------------------------------------------

function ThinSlateDiagnostic({
  userTier,
  meta,
  liveCount,
}: {
  userTier: 'anon' | 'free' | 'pro' | 'elite';
  meta: NonNullable<SlatePicksGridProps['meta']>;
  liveCount: number;
}) {
  const evPct = (meta.ev_threshold * 100).toFixed(0);
  const belowThreshold = meta.below_threshold;
  const gamesAnalyzed = meta.games_analyzed;
  const canSeeShadow = userTier === 'pro' || userTier === 'elite';

  return (
    <div
      className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm"
      role="status"
      aria-label="Thin slate explanation"
    >
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
        Why today&apos;s slate is thin
      </p>
      <ul className="space-y-1 text-gray-300">
        <li>
          <span className="text-white font-semibold">{gamesAnalyzed}</span>{' '}
          {gamesAnalyzed === 1 ? 'game' : 'games'} on today&apos;s schedule.
        </li>
        <li>
          <span className="text-white font-semibold">{belowThreshold}</span> candidate
          {belowThreshold === 1 ? '' : 's'} did not clear the {evPct}% EV publish threshold.
        </li>
        <li>
          <span className="text-white font-semibold">{liveCount}</span>{' '}
          {liveCount === 1 ? 'pick' : 'picks'} cleared and {liveCount === 1 ? 'is' : 'are'} shown below.
        </li>
      </ul>

      {canSeeShadow ? (
        <div className="mt-3 pt-3 border-t border-gray-800">
          <Link
            href="/picks/today?visibility=all"
            className="text-sm text-amber-400 hover:text-amber-300 hover:underline"
          >
            Include below-threshold candidates in the slate
          </Link>
        </div>
      ) : (
        <div className="mt-3 pt-3 border-t border-gray-800 flex items-start justify-between gap-3 flex-wrap">
          <p className="text-xs text-gray-500 max-w-sm">
            Pro and Elite plans include access to additional candidates that did
            not clear the live publish threshold.
          </p>
          <UpgradeCta tier="pro" size="xs" label="See plans" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SlatePicksGrid({ picks, userTier, meta }: SlatePicksGridProps) {
  const { market, minStrength, visibility, sort, minEv } = useSlateFilters();
  const canSeeShadow = userTier === 'pro' || userTier === 'elite';

  const filtered = useMemo(
    () => applyFilters(picks, market, minStrength, visibility, sort, minEv),
    [picks, market, minStrength, visibility, sort, minEv]
  );

  const isActiveFilter =
    market !== 'all' ||
    minStrength !== 'all' ||
    (canSeeShadow && visibility !== 'all') ||
    sort !== 'ev' ||
    minEv !== 0;

  const liveCount = useMemo(
    () => picks.filter((p) => p.visibility === 'live').length,
    [picks]
  );

  const showThinSlateDiagnostic =
    !!meta &&
    meta.pipeline_ran &&
    meta.games_analyzed > 0 &&
    liveCount > 0 &&
    liveCount < THIN_SLATE_THRESHOLD &&
    !isActiveFilter;

  return (
    <div className="space-y-4">
      {canSeeShadow && <DailyExposureMeter />}

      <SlateFilters
        totalPicks={picks.length}
        visiblePicks={filtered.length}
        canSeeShadow={canSeeShadow}
      />

      {showThinSlateDiagnostic && meta && (
        <ThinSlateDiagnostic userTier={userTier} meta={meta} liveCount={liveCount} />
      )}

      {filtered.length === 0 ? (
        <ZeroState userTier={userTier} meta={meta} filtered={isActiveFilter} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((pick) => (
            <article key={pick.id} className="flex flex-col">
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
