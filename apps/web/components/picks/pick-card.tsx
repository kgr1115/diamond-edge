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
    model_probability?: number;
    expected_value?: number;
    rationale_preview?: string;
  };
  userTier: 'anon' | 'free' | 'pro' | 'elite';
}

function formatOdds(price: number): string {
  return price >= 0 ? `+${price}` : `${price}`;
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
    moneyline: 'ML',
    run_line: 'RL',
    total: 'O/U',
    prop: 'Prop',
    future: 'Future',
  };
  return (
    <span className="text-xs text-gray-400 font-mono uppercase tracking-wide">
      {labels[market] ?? market}
    </span>
  );
}

export function PickCard({ pick, userTier }: PickCardProps) {
  const isProEligible = userTier === 'pro' || userTier === 'elite';
  const hasProData = pick.best_line_price !== undefined;
  const showPaywall = !isProEligible && pick.required_tier !== 'free';

  return (
    <Link href={`/picks/${pick.id}`} className="block group">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-600 transition-colors">
        {/* Header row: teams + game time + result */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <p className="text-sm font-semibold text-gray-100">
              {pick.game.away_team.abbreviation} @ {pick.game.home_team.abbreviation}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">{formatGameTime(pick.game.game_time_utc)}</p>
          </div>
          <ResultBadge result={pick.result} />
        </div>

        {/* Pick details */}
        <div className="flex items-center gap-3 mb-3">
          <MarketLabel market={pick.market} />
          <span className="text-base font-bold text-white">{pick.pick_side}</span>
          {hasProData && pick.best_line_price !== undefined && (
            <span className="text-sm font-mono text-emerald-400">
              {formatOdds(pick.best_line_price)}
            </span>
          )}
          {hasProData && pick.best_line_book && (
            <span className="text-xs text-gray-500">@{pick.best_line_book}</span>
          )}
        </div>

        {/* Confidence + model prob */}
        <div className="flex items-center justify-between">
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
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Full analysis available with Pro</p>
              <UpgradeCta tier="pro" size="xs" />
            </div>
          </div>
        ) : null}
      </div>
    </Link>
  );
}
