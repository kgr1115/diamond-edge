'use client';

import Link from 'next/link';
import { resolveUrgency, type UrgencyState, type UrgencyVariant } from '@/lib/picks/urgency';

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
  has_note?: boolean;
  odds_stale?: boolean;
  odds_snapshot_at?: string;
  generated_at?: string;
}

function formatLeadTime(generatedAt: string | undefined, gameTimeUtc: string | null): string | null {
  if (!generatedAt || !gameTimeUtc) return null;
  const ms = new Date(gameTimeUtc).getTime() - new Date(generatedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = ms / 3_600_000;
  if (hours < 1) return 'Generated <1h before first pitch';
  if (hours < 24) return `Generated ${Math.round(hours)}h before first pitch`;
  const days = Math.round(hours / 24);
  return `Generated ${days}d before first pitch`;
}

interface GameStripProps {
  game: PickData['game'];
  picks: PickData[];
}

function formatOdds(price: number): string {
  return price >= 0 ? `+${price}` : `${price}`;
}

function formatSpread(spread: number): string {
  return spread >= 0 ? `+${spread}` : `${spread}`;
}

function formatGameTime(utc: string | null): string {
  if (!utc) return 'TBD';
  return new Date(utc).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

function formatRelativeAge(iso: string | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const ageMin = Math.max(0, (nowMs - new Date(iso).getTime()) / 60_000);
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
  const ageHours = ageMin / 60;
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  return `${Math.round(ageHours / 24)}d ago`;
}

const TIER_RING: Record<number, string> = {
  3: 'ring-yellow-500/60 bg-yellow-500/10',
  4: 'ring-orange-500/60 bg-orange-500/10',
  5: 'ring-emerald-500/60 bg-emerald-500/10',
};

const TIER_DIAMOND: Record<number, string> = {
  3: 'text-yellow-400',
  4: 'text-orange-400',
  5: 'text-emerald-400',
};

function TierDiamonds({ tier }: { tier: number }) {
  const t = Math.min(5, Math.max(1, Math.round(tier)));
  const color = TIER_DIAMOND[t] ?? 'text-gray-400';
  return (
    <span className={`text-[10px] leading-none ${color}`} aria-hidden>
      {Array.from({ length: t }).map((_, i) => (
        <span key={i}>◆</span>
      ))}
    </span>
  );
}

function UrgencyPill({ state }: { state: UrgencyState }) {
  const styles: Record<UrgencyVariant, string> = {
    'countdown-neutral': 'bg-gray-800 text-gray-400 border-gray-700',
    'countdown-amber': 'bg-amber-950/60 text-amber-300 border-amber-800/60',
    'countdown-red': 'bg-red-950/60 text-red-300 border-red-800/60',
    'live': 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60',
    'final': 'bg-gray-800 text-gray-400 border-gray-700',
    'off': 'bg-gray-800 text-gray-400 border-gray-700',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${styles[state.variant]}`}
    >
      {state.variant.startsWith('countdown-') && <span aria-hidden>⏱</span>}
      {state.label}
    </span>
  );
}

function PickCell({
  pick,
  emptyLabel,
  className = '',
}: {
  pick: PickData | null;
  emptyLabel?: string;
  className?: string;
}) {
  if (!pick) {
    return (
      <div className={`text-center text-gray-700 text-xs py-3 ${className}`}>
        {emptyLabel ?? '—'}
      </div>
    );
  }

  const tier = Math.min(5, Math.max(3, Math.round(pick.confidence_tier)));
  const ring = TIER_RING[tier] ?? 'ring-gray-700/50 bg-gray-900';
  const price = pick.best_line_price;
  const book = pick.best_line_book;

  let lineLabel = '';
  if (pick.market === 'run_line' && typeof pick.run_line_spread === 'number') {
    lineLabel = formatSpread(pick.run_line_spread);
  } else if (pick.market === 'total' && typeof pick.total_line === 'number') {
    const side = pick.pick_side.toUpperCase();
    lineLabel = `${side} ${pick.total_line}`;
  }

  return (
    <Link
      href={`/picks/${pick.id}`}
      className={`block rounded ring-1 ${ring} px-2 py-1.5 hover:brightness-110 focus:outline-none focus:ring-2 transition ${className}`}
      aria-label={`${pick.market} pick — ${lineLabel || pick.pick_side}${price != null ? ` at ${formatOdds(price)}` : ''}${book ? ` on ${book}` : ''}`}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="min-w-0">
          {lineLabel && (
            <p className="text-xs font-semibold text-amber-300 leading-tight">{lineLabel}</p>
          )}
          {price != null && (
            <p className="text-sm font-mono font-bold text-white leading-tight">
              {formatOdds(price)}
            </p>
          )}
          {book && (
            <p className="text-[10px] text-gray-400 leading-tight mt-0.5">@ {book}</p>
          )}
        </div>
        <TierDiamonds tier={pick.confidence_tier} />
      </div>
      {pick.visibility === 'shadow' && (
        <p className="mt-1 text-[9px] text-amber-500 uppercase tracking-wide">Shadow</p>
      )}
    </Link>
  );
}

function ColumnFooter({ snapshots, label }: { snapshots: (string | undefined)[]; label: string }) {
  const valid = snapshots.filter((s): s is string => typeof s === 'string');
  if (valid.length === 0) {
    return (
      <div className="text-[10px] text-gray-700 text-center pt-1">
        <span className="block text-gray-600 uppercase tracking-wide">{label}</span>
        <span>—</span>
      </div>
    );
  }
  const newest = valid.reduce((a, b) => (new Date(a).getTime() > new Date(b).getTime() ? a : b));
  return (
    <div className="text-[10px] text-gray-500 text-center pt-1">
      <span className="block text-gray-600 uppercase tracking-wide">{label}</span>
      <span>{formatRelativeAge(newest, Date.now())}</span>
    </div>
  );
}

function teamMatches(pickSide: string, team: { name: string; abbreviation: string }): boolean {
  const norm = (s: string) => s.toLowerCase().trim();
  return norm(pickSide) === norm(team.name) || norm(pickSide) === norm(team.abbreviation);
}

function pickForTeamSide(
  picks: PickData[],
  market: string,
  side: 'home' | 'away',
  homeTeam: { name: string; abbreviation: string },
  awayTeam: { name: string; abbreviation: string },
): PickData | null {
  for (const p of picks) {
    if (p.market !== market) continue;
    const ps = p.pick_side.toLowerCase().trim();
    if (ps === side) return p;
    const team = side === 'home' ? homeTeam : awayTeam;
    if (teamMatches(p.pick_side, team)) return p;
  }
  return null;
}

function pickForTotal(picks: PickData[]): PickData | null {
  return picks.find((p) => p.market === 'total') ?? null;
}

export function GameStrip({ game, picks }: GameStripProps) {
  const urgency = resolveUrgency(game.status, game.game_time_utc, Date.now());
  const lineLocked = urgency?.lineLocked ?? false;

  const awayML = pickForTeamSide(picks, 'moneyline', 'away', game.home_team, game.away_team);
  const homeML = pickForTeamSide(picks, 'moneyline', 'home', game.home_team, game.away_team);
  const awayRL = pickForTeamSide(picks, 'run_line', 'away', game.home_team, game.away_team);
  const homeRL = pickForTeamSide(picks, 'run_line', 'home', game.home_team, game.away_team);
  const totalPick = pickForTotal(picks);

  // Use the OLDEST generated_at across this game's picks for the lead-time
  // pill — usually all picks are from the same pipeline run, but min protects
  // against mixed batches. After load-slate dedup, all picks shown here are
  // the freshest per (game, market) anyway.
  const leadTimeLabel = (() => {
    const ts = picks.map((p) => p.generated_at).filter(Boolean) as string[];
    if (ts.length === 0) return null;
    const oldest = ts.reduce((a, b) => (new Date(a).getTime() < new Date(b).getTime() ? a : b));
    return formatLeadTime(oldest, game.game_time_utc);
  })();

  const mlSnapshots = [awayML?.odds_snapshot_at, homeML?.odds_snapshot_at];
  const rlSnapshots = [awayRL?.odds_snapshot_at, homeRL?.odds_snapshot_at];
  const totalSnapshots = [totalPick?.odds_snapshot_at];

  return (
    <article
      className={`bg-gray-900 border border-gray-800 rounded-lg p-3 sm:p-4 ${lineLocked ? 'opacity-70' : ''}`}
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-baseline gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-white truncate">
            {game.away_team.abbreviation} @ {game.home_team.abbreviation}
          </h3>
          <span className="text-xs text-gray-500">{formatGameTime(game.game_time_utc)}</span>
        </div>
        {urgency && <UrgencyPill state={urgency} />}
      </header>
      {leadTimeLabel && (
        <p className="text-[10px] text-gray-600 mb-3 leading-tight">{leadTimeLabel}</p>
      )}

      {/* Mobile layout: Team | ML | RL grid, then Total full-width below.
          Avoids cramming 3 pick cols + team col into a 375px viewport
          (which leaves ~71px per cell). Stacking Total gives ML/RL ~125px
          and Total the full row. */}
      <div className="sm:hidden">
        <div className="grid grid-cols-[minmax(56px,72px)_repeat(2,minmax(0,1fr))] gap-x-2 gap-y-1 items-stretch">
          <div className="text-[10px] uppercase tracking-wide text-gray-600">Team</div>
          <div className="text-[10px] uppercase tracking-wide text-gray-600 text-center">ML</div>
          <div className="text-[10px] uppercase tracking-wide text-gray-600 text-center">RL</div>

          <div className="text-sm text-gray-200 self-center">
            <span className="font-semibold">{game.away_team.abbreviation}</span>
            <span className="text-[10px] text-gray-500 ml-1">Away</span>
          </div>
          <PickCell pick={awayML} />
          <PickCell pick={awayRL} />

          <div className="text-sm text-gray-200 self-center">
            <span className="font-semibold">{game.home_team.abbreviation}</span>
            <span className="text-[10px] text-gray-500 ml-1">Home</span>
          </div>
          <PickCell pick={homeML} />
          <PickCell pick={homeRL} />
        </div>

        <div className="mt-2 space-y-1">
          <div className="text-[10px] uppercase tracking-wide text-gray-600">Total</div>
          <PickCell pick={totalPick} />
        </div>

        <div className="mt-2 grid grid-cols-3 gap-x-2 text-[10px] text-gray-500 text-center">
          <ColumnFooter snapshots={mlSnapshots} label="ML" />
          <ColumnFooter snapshots={rlSnapshots} label="RL" />
          <ColumnFooter snapshots={totalSnapshots} label="Total" />
        </div>
      </div>

      {/* Desktop layout: classic sportsbook grid (team | ML | RL | Total) */}
      <div className="hidden sm:grid grid-cols-[minmax(64px,88px)_repeat(3,minmax(0,1fr))] gap-x-2 gap-y-1 items-stretch">
        <div className="text-[10px] uppercase tracking-wide text-gray-600">Team</div>
        <div className="text-[10px] uppercase tracking-wide text-gray-600 text-center">ML</div>
        <div className="text-[10px] uppercase tracking-wide text-gray-600 text-center">RL</div>
        <div className="text-[10px] uppercase tracking-wide text-gray-600 text-center">Total</div>

        <div className="text-sm text-gray-200 self-center">
          <span className="font-semibold">{game.away_team.abbreviation}</span>
          <span className="text-[10px] text-gray-500 ml-1">Away</span>
        </div>
        <PickCell pick={awayML} />
        <PickCell pick={awayRL} />
        <div className="row-span-2">
          <PickCell pick={totalPick} className="h-full flex items-center justify-center" />
        </div>

        <div className="text-sm text-gray-200 self-center">
          <span className="font-semibold">{game.home_team.abbreviation}</span>
          <span className="text-[10px] text-gray-500 ml-1">Home</span>
        </div>
        <PickCell pick={homeML} />
        <PickCell pick={homeRL} />

        <div className="text-[10px] text-gray-700 text-right pt-1 self-center">Updated</div>
        <ColumnFooter snapshots={mlSnapshots} label="ML" />
        <ColumnFooter snapshots={rlSnapshots} label="RL" />
        <ColumnFooter snapshots={totalSnapshots} label="Total" />
      </div>
    </article>
  );
}
