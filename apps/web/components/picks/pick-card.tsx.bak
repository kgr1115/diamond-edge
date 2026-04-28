import Link from 'next/link';
import { ConfidenceBadge } from './confidence-badge';
import { UpgradeCta } from '@/components/billing/upgrade-cta';
import { resolveUrgency, type UrgencyState, type UrgencyVariant } from '@/lib/picks/urgency';

// Server Components evaluate at request time — read directly from process.env
// rather than importing the helper, which keeps this module synchronous.
const PAID_TIERS_ENABLED = process.env.NEXT_PUBLIC_PAID_TIERS === 'true';

interface PickCardProps {
  pick: {
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
    total_line?: number;
    run_line_spread?: number;
    model_probability?: number;
    expected_value?: number;
    rationale_preview?: string;
    /** True when the user has a journal note saved for this pick. */
    has_note?: boolean;
    /** True when THIS pick's pinned odds snapshot is past the freshness
     *  threshold. Per-pick narrowing of the slate-level meta.odds_stale so
     *  only the actually-stale pick card surfaces the warning. */
    odds_stale?: boolean;
    /** ISO timestamp of the pinned odds snapshot this pick was priced against. */
    odds_snapshot_at?: string;
  };
  userTier: 'anon' | 'free' | 'pro' | 'elite';
}

function formatOdds(price: number): string {
  return price >= 0 ? `+${price}` : `${price}`;
}

function formatSpread(spread: number): string {
  return spread >= 0 ? `+${spread}` : `${spread}`;
}

function formatRelativeOddsAge(iso: string | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const ageMin = Math.max(0, (nowMs - new Date(iso).getTime()) / 60_000);
  if (ageMin < 1) return 'just now';
  if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
  const ageHours = ageMin / 60;
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  return `${Math.round(ageHours / 24)}d ago`;
}

function formatGameTime(utc: string | null): string {
  if (!utc) return 'TBD';
  return new Date(utc).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
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
  const isCountdown = state.variant.startsWith('countdown-');
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${styles[state.variant]}`}
      aria-label={isCountdown ? `Time to first pitch ${state.label}` : state.label}
    >
      {isCountdown && <span aria-hidden>⏱</span>}
      {state.label}
    </span>
  );
}

/**
 * Top-of-card banner for line-locked states (live / final / postponed / cancelled).
 * Copy is intentionally factual ("line locked / closed / voided") rather than
 * directive ("do not bet") — it describes the state of the underlying market,
 * not a betting recommendation.
 */
function LockedLineBanner({ state }: { state: UrgencyState }) {
  if (!state.lineLocked || !state.lockedReason) return null;
  const styles: Record<UrgencyVariant, string> = {
    'countdown-neutral': '',
    'countdown-amber': '',
    'countdown-red': '',
    'live': 'bg-amber-500/20 text-amber-200 border-amber-500/60',
    'final': 'bg-gray-700/40 text-gray-200 border-gray-600',
    'off': 'bg-gray-700/40 text-gray-200 border-gray-600',
  };
  return (
    <div
      className={`mb-3 -mx-4 -mt-4 px-4 py-2 border-b text-[11px] font-bold uppercase tracking-wider text-center ${styles[state.variant]}`}
      role="status"
      aria-label={state.lockedReason}
    >
      <span aria-hidden>⛔ </span>
      {state.lockedReason}
    </div>
  );
}

function ResultBadge({ result }: { result: string }) {
  const config: Record<string, { label: string; className: string }> = {
    pending: { label: 'Pending', className: 'bg-gray-800 text-gray-400' },
    win: { label: 'Win', className: 'bg-emerald-900/60 text-emerald-300' },
    loss: { label: 'Loss', className: 'bg-red-900/60 text-red-300' },
    push: { label: 'Push', className: 'bg-yellow-900/60 text-yellow-300' },
    void: { label: 'Void', className: 'bg-gray-800 text-gray-400' },
  };
  const { label, className } = config[result] ?? config['pending'];
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${className}`}>{label}</span>
  );
}

function MarketLabel({ market }: { market: string }) {
  const labels: Record<string, string> = {
    moneyline: 'Moneyline',
    run_line: 'Run Line',
    total: 'Total',
    prop: 'Prop',
    future: 'Future',
  };
  return (
    <span className="text-[10px] text-gray-500 font-semibold uppercase tracking-wide">
      {labels[market] ?? market}
    </span>
  );
}

function sideLabelForMoneyline(pick: PickCardProps['pick']): string {
  if (pick.pick_side === 'home') return pick.game.home_team.abbreviation;
  if (pick.pick_side === 'away') return pick.game.away_team.abbreviation;
  return pick.pick_side.toUpperCase();
}

/**
 * Primary line block — the prominent "what is the bet" display.
 * Varies by market so O/U shows "OVER 8.5", RL shows "NYY -1.5", ML shows team.
 */
function PickHeadline({ pick }: { pick: PickCardProps['pick'] }) {
  if (pick.market === 'total') {
    const side = pick.pick_side.toUpperCase();
    const line = pick.total_line !== undefined ? pick.total_line : null;
    return (
      <p className="text-xl font-bold text-white leading-tight break-words">
        {side}
        {line !== null && <span className="text-amber-300 ml-2">{line}</span>}
      </p>
    );
  }

  if (pick.market === 'run_line') {
    const teamAbbr =
      pick.pick_side === 'home'
        ? pick.game.home_team.abbreviation
        : pick.game.away_team.abbreviation;
    const spread = pick.run_line_spread;
    return (
      <p className="text-xl font-bold text-white leading-tight break-words">
        {teamAbbr}
        {spread !== undefined && <span className="text-amber-300 ml-2">{formatSpread(spread)}</span>}
      </p>
    );
  }

  // moneyline or unknown
  return (
    <p className="text-xl font-bold text-white leading-tight break-words">
      {sideLabelForMoneyline(pick)}
    </p>
  );
}

export function PickCard({ pick, userTier }: PickCardProps) {
  const isProEligible = userTier === 'pro' || userTier === 'elite';
  const hasProData = pick.best_line_price !== undefined;
  // Portfolio mode: never render the paywall nudge — every viewer sees full data.
  const showPaywall = PAID_TIERS_ENABLED && !isProEligible && pick.required_tier !== 'free';
  const oddsStale = pick.odds_stale ?? false;

  const urgency = resolveUrgency(pick.game.status, pick.game.game_time_utc, Date.now());
  const cardDim = urgency?.dim ?? false;
  const lineLocked = urgency?.lineLocked ?? false;

  return (
    <Link
      href={`/picks/${pick.id}`}
      className="block group"
      aria-describedby={lineLocked ? `pick-${pick.id}-locked-status` : undefined}
    >
      <div
        className={`bg-gray-900 rounded-lg p-4 transition-colors min-w-0 ${
          lineLocked
            ? 'border border-dashed border-gray-700 grayscale-[0.4] cursor-not-allowed'
            : 'border border-gray-800 hover:border-gray-600'
        } ${cardDim ? 'opacity-60' : ''}`}
      >
        {urgency && <LockedLineBanner state={urgency} />}
        {lineLocked && urgency?.lockedReason && (
          <span id={`pick-${pick.id}-locked-status`} className="sr-only">
            {urgency.lockedReason}
          </span>
        )}
        {/* Matchup + game time + result */}
        <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-100 truncate">
              {pick.game.away_team.abbreviation} @ {pick.game.home_team.abbreviation}
            </p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <p className="text-xs text-gray-500">{formatGameTime(pick.game.game_time_utc)}</p>
              {urgency && <UrgencyPill state={urgency} />}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {pick.has_note && (
              <span
                className="text-xs text-amber-400"
                aria-label="This pick has a journal note"
                title="Journal note saved"
              >
                [note]
              </span>
            )}
            <ResultBadge result={pick.result} />
          </div>
        </div>

        {/* Prominent pick headline */}
        <div className="mb-3">
          <MarketLabel market={pick.market} />
          <div className="mt-0.5">
            <PickHeadline pick={pick} />
          </div>
          {hasProData && pick.best_line_price !== undefined && (
            <p
              className={`mt-1 text-sm font-mono ${
                lineLocked ? 'text-gray-500 line-through decoration-gray-500/80' : 'text-emerald-400'
              }`}
              aria-label={
                lineLocked
                  ? `Line ${formatOdds(pick.best_line_price)} no longer bettable`
                  : undefined
              }
            >
              {formatOdds(pick.best_line_price)}
              {pick.best_line_book && (
                <span
                  className={`text-xs font-sans ml-1.5 no-underline ${
                    lineLocked ? 'text-gray-600' : 'text-gray-500'
                  }`}
                >
                  @ {pick.best_line_book}
                </span>
              )}
            </p>
          )}
          {hasProData && oddsStale && !lineLocked && (
            <p className="mt-1 text-xs text-amber-400 font-sans">Line may be stale</p>
          )}
          {hasProData && pick.odds_snapshot_at && (
            <p
              className={`mt-0.5 text-xs font-sans ${
                oddsStale ? 'text-amber-500/80' : 'text-gray-500'
              }`}
              title={new Date(pick.odds_snapshot_at).toLocaleString()}
            >
              Odds updated {formatRelativeOddsAge(pick.odds_snapshot_at, Date.now())}
            </p>
          )}
        </div>

        {/* Confidence + model prob */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <ConfidenceBadge tier={pick.confidence_tier} showLabel />
          {pick.model_probability !== undefined && (
            <span className="text-xs text-gray-400">
              Model: {(pick.model_probability * 100).toFixed(1)}%
            </span>
          )}
        </div>

        {/* Rationale preview (pro+) or paywall nudge */}
        {pick.rationale_preview ? (
          <p className="mt-3 text-xs text-gray-400 line-clamp-2 border-t border-gray-800 pt-3">
            {pick.rationale_preview}
          </p>
        ) : showPaywall ? (
          <div className="mt-3 border-t border-gray-800 pt-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs text-gray-500">Full analysis available with Pro</p>
              <UpgradeCta tier="pro" size="xs" />
            </div>
          </div>
        ) : null}
      </div>
    </Link>
  );
}
