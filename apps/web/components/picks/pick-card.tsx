import Link from 'next/link';
import { ConfidenceBadge } from './confidence-badge';
import { UpgradeCta } from '@/components/billing/upgrade-cta';

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
  };
  userTier: 'anon' | 'free' | 'pro' | 'elite';
}

function formatOdds(price: number): string {
  return price >= 0 ? `+${price}` : `${price}`;
}

function formatSpread(spread: number): string {
  return spread >= 0 ? `+${spread}` : `${spread}`;
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
  const showPaywall = !isProEligible && pick.required_tier !== 'free';

  return (
    <Link href={`/picks/${pick.id}`} className="block group">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors min-w-0">
        {/* Matchup + game time + result */}
        <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-100 truncate">
              {pick.game.away_team.abbreviation} @ {pick.game.home_team.abbreviation}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">{formatGameTime(pick.game.game_time_utc)}</p>
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
            <p className="mt-1 text-sm font-mono text-emerald-400">
              {formatOdds(pick.best_line_price)}
              {pick.best_line_book && (
                <span className="text-xs text-gray-500 font-sans ml-1.5">@ {pick.best_line_book}</span>
              )}
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
