'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { GameStrip } from './game-strip';
import { SlateFilters, useSlateFilters } from './slate-filters';
import type {
  MarketFilter,
  MinStrengthFilter,
  VisibilityFilter,
  SortFilter,
} from './slate-filters';
import { DailyExposureMeter } from './daily-exposure-meter';
import { UpgradeCta } from '@/components/billing/upgrade-cta';

const THIN_SLATE_THRESHOLD = 4;

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
  line_snapshots?: OddsSnapshot[];
  has_note?: boolean;
  odds_stale?: boolean;
  odds_snapshot_at?: string;
}

interface SlatePicksGridProps {
  picks: PickData[];
  userTier: 'anon' | 'free' | 'pro' | 'elite';
  meta?: {
    pipeline_ran: boolean;
    games_analyzed: number;
    games_scheduled_count?: number;
    below_threshold: number;
    ev_threshold: number;
    confidence_threshold: number;
    last_odds_snapshot_at: string | null;
    odds_stale: boolean;
  };
  /** Date being rendered (YYYY-MM-DD, ET). Used for empty-state copy. */
  pickDate?: string;
  /** Tab context — affects empty-state messaging. */
  mode?: 'today' | 'upcoming';
}

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

interface GameGroup {
  game: PickData['game'];
  picks: PickData[];
  earliestStart: number;
  bestTier: number;
  bestEv: number;
}

function groupByGame(picks: PickData[]): GameGroup[] {
  const map = new Map<string, GameGroup>();
  for (const p of picks) {
    const key = p.game.id;
    let group = map.get(key);
    if (!group) {
      group = {
        game: p.game,
        picks: [],
        earliestStart: p.game.game_time_utc ? new Date(p.game.game_time_utc).getTime() : Infinity,
        bestTier: 0,
        bestEv: -Infinity,
      };
      map.set(key, group);
    }
    group.picks.push(p);
    if (p.confidence_tier > group.bestTier) group.bestTier = p.confidence_tier;
    if ((p.expected_value ?? -Infinity) > group.bestEv) group.bestEv = p.expected_value ?? -Infinity;
  }
  return Array.from(map.values());
}

function sortGroups(groups: GameGroup[], sort: SortFilter): GameGroup[] {
  const out = [...groups];
  if (sort === 'ev') out.sort((a, b) => b.bestEv - a.bestEv);
  else if (sort === 'confidence') out.sort((a, b) => b.bestTier - a.bestTier);
  else out.sort((a, b) => a.earliestStart - b.earliestStart);
  return out;
}

function ZeroState({
  userTier,
  meta,
  filtered,
  pickDate,
  mode,
}: {
  userTier: 'anon' | 'free' | 'pro' | 'elite';
  meta?: SlatePicksGridProps['meta'];
  filtered: boolean;
  pickDate?: string;
  mode?: 'today' | 'upcoming';
}) {
  // Distinguish "no MLB games scheduled for this date" from "games exist but
  // pipeline hasn't generated picks yet." The first is a calendar fact (off-day,
  // All-Star break); the second is a process gap (cron hasn't fired).
  const noGamesScheduled = !!meta && (meta.games_scheduled_count ?? meta.games_analyzed) === 0;
  const hasGamesNoPicks = !!meta && !noGamesScheduled && !meta.pipeline_ran;

  let headline = 'No qualifying picks today.';
  if (filtered) {
    headline = 'No picks match your filters.';
  } else if (noGamesScheduled) {
    headline = mode === 'upcoming'
      ? 'No MLB games scheduled for this date.'
      : 'No MLB games scheduled today.';
  } else if (hasGamesNoPicks) {
    headline = mode === 'upcoming'
      ? 'Picks not yet generated for this date.'
      : 'Picks not yet generated for today.';
  }

  return (
    <div className="text-center py-16 space-y-4 max-w-md mx-auto">
      <p className="text-gray-300 font-semibold text-lg">{headline}</p>

      {!filtered && noGamesScheduled && (
        <p className="text-sm text-gray-500">
          {mode === 'upcoming'
            ? 'Pick another date with the date selector above.'
            : 'No games on the schedule. Check back tomorrow.'}
        </p>
      )}

      {!filtered && hasGamesNoPicks && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-left space-y-2 text-sm">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Pipeline status</p>
          <ul className="space-y-1 text-gray-400">
            <li>
              Games scheduled:{' '}
              <span className="text-white">{meta?.games_scheduled_count ?? meta?.games_analyzed ?? 0}</span>
            </li>
            <li>Pipeline ran for this date: <span className="text-red-400">No</span></li>
          </ul>
          <div className="mt-2 inline-block bg-amber-950/40 border border-amber-900/60 rounded px-2 py-1 text-xs text-amber-300">
            The pipeline runs daily at 12:00 PM ET. Picks for {pickDate ? `${pickDate}` : 'this date'} appear here after that.
          </div>
        </div>
      )}

      {!filtered && !noGamesScheduled && !hasGamesNoPicks && meta && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-left space-y-2 text-sm">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Pipeline diagnostic</p>
          <ul className="space-y-1 text-gray-400">
            <li>Games analyzed: <span className="text-white">{meta.games_analyzed}</span></li>
            <li>
              Below threshold: <span className="text-white">{meta.below_threshold}</span>
              <span className="text-gray-600 text-xs ml-1">
                (EV &lt; {(meta.ev_threshold * 100).toFixed(0)}% or Tier &lt; {meta.confidence_threshold})
              </span>
            </li>
          </ul>
          <p className="text-xs text-gray-500 mt-2">
            Our model requires EV &gt; 4% — on lighter slates, no picks qualify.
          </p>
        </div>
      )}

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

export function SlatePicksGrid({ picks, userTier, meta, pickDate, mode }: SlatePicksGridProps) {
  const { market, minStrength, visibility, sort, minEv } = useSlateFilters();
  const canSeeShadow = userTier === 'pro' || userTier === 'elite';

  const filtered = useMemo(
    () => applyFilters(picks, market, minStrength, visibility, sort, minEv),
    [picks, market, minStrength, visibility, sort, minEv]
  );

  const groups = useMemo(() => sortGroups(groupByGame(filtered), sort), [filtered, sort]);

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

      {groups.length === 0 ? (
        <ZeroState
          userTier={userTier}
          meta={meta}
          filtered={isActiveFilter}
          pickDate={pickDate}
          mode={mode}
        />
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <GameStrip key={group.game.id} game={group.game} picks={group.picks} />
          ))}
        </div>
      )}
    </div>
  );
}
