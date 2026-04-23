import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { ResponsibleGamblingBanner } from '@/components/picks/responsible-gambling-banner';
import { ConfidenceBadge } from '@/components/picks/confidence-badge';
import { UpgradeCta } from '@/components/billing/upgrade-cta';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

interface PickDetailResponse {
  pick: {
    id: string;
    game: {
      id: string;
      home_team: { id: string; name: string; abbreviation: string };
      away_team: { id: string; name: string; abbreviation: string };
      game_time_utc: string;
      status: string;
      probable_home_pitcher: { id: string; full_name: string } | null;
      probable_away_pitcher: { id: string; full_name: string } | null;
      weather: { condition: string; temp_f: number; wind_mph: number; wind_dir: string } | null;
    };
    market: string;
    pick_side: string;
    confidence_tier: number;
    required_tier: string;
    result: string;
    generated_at: string;
    best_line_price?: number;
    best_line_book?: string;
    model_probability?: number;
    expected_value?: number;
    rationale?: string;
    shap_attributions?: Array<{
      feature: string;
      value: number;
      direction: 'positive' | 'negative';
    }>;
  };
}

function formatOdds(price: number) {
  return price >= 0 ? `+${price}` : `${price}`;
}

function formatGameTime(utc: string) {
  return new Date(utc).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
}

async function fetchPickDetail(id: string): Promise<PickDetailResponse | null> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/picks/${id}`, {
      cache: 'no-store',
      headers: { cookie: (await cookies()).toString() },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('fetch failed');
    return res.json();
  } catch {
    return null;
  }
}

export default async function PickDetailPage({ params }: PageProps) {
  const { id } = await params;
  const data = await fetchPickDetail(id);

  if (!data) {
    notFound();
  }

  const { pick } = data;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main content — 2/3 */}
        <div className="lg:col-span-2 space-y-6">
          {/* Matchup header */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-xl font-bold text-white">
                {pick.game.away_team.name} @ {pick.game.home_team.name}
              </h1>
              <span className="text-sm text-gray-400">{formatGameTime(pick.game.game_time_utc)}</span>
            </div>
            {pick.game.weather && (
              <p className="text-xs text-gray-500">
                {pick.game.weather.condition}, {pick.game.weather.temp_f}°F —{' '}
                {pick.game.weather.wind_mph} mph {pick.game.weather.wind_dir}
              </p>
            )}
            {(pick.game.probable_home_pitcher || pick.game.probable_away_pitcher) && (
              <div className="mt-2 text-xs text-gray-400 flex gap-4">
                {pick.game.probable_away_pitcher && (
                  <span>Away SP: {pick.game.probable_away_pitcher.full_name}</span>
                )}
                {pick.game.probable_home_pitcher && (
                  <span>Home SP: {pick.game.probable_home_pitcher.full_name}</span>
                )}
              </div>
            )}
          </div>

          {/* Pick summary */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Pick</h2>
            <div className="flex items-center gap-4 flex-wrap">
              <span className="text-sm text-gray-500 uppercase">{pick.market}</span>
              <span className="text-2xl font-bold text-white">{pick.pick_side}</span>
              {pick.best_line_price !== undefined && (
                <span className="text-lg font-mono text-emerald-400">
                  {formatOdds(pick.best_line_price)}
                </span>
              )}
              {pick.best_line_book && (
                <span className="text-sm text-gray-500">@ {pick.best_line_book}</span>
              )}
            </div>
            <div className="flex items-center gap-4">
              <ConfidenceBadge tier={pick.confidence_tier} showLabel />
              {pick.model_probability !== undefined && (
                <span className="text-sm text-gray-400">
                  Model: {(pick.model_probability * 100).toFixed(1)}%
                </span>
              )}
              {pick.expected_value !== undefined && (
                <span className="text-sm text-emerald-400">
                  EV: +{(pick.expected_value * 100).toFixed(1)}%
                </span>
              )}
            </div>
            <p className="text-xs text-gray-600">
              Generated {new Date(pick.generated_at).toLocaleString()}
            </p>
          </div>

          {/* AI Rationale */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
              Analysis
            </h2>
            {pick.rationale ? (
              <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                {pick.rationale}
              </div>
            ) : (
              <div className="text-center py-8 space-y-3">
                <p className="text-sm text-gray-400">
                  Upgrade to Pro to see the full statistical analysis and AI rationale.
                </p>
                <UpgradeCta tier="pro" />
              </div>
            )}
          </div>

          {/* SHAP attributions — Elite only */}
          {pick.shap_attributions && pick.shap_attributions.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Model Feature Drivers
              </h2>
              <div className="space-y-2">
                {pick.shap_attributions.map((attr, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-gray-300">{attr.feature}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">{attr.value}</span>
                      <span
                        className={attr.direction === 'positive' ? 'text-emerald-400' : 'text-red-400'}
                      >
                        {attr.direction === 'positive' ? '▲' : '▼'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar — 1/3 */}
        <div className="space-y-4">
          {/* Surface 5 — "A note on risk" */}
          <div className="bg-gray-900 border border-amber-900/40 rounded-lg p-4 space-y-2">
            <h3 className="text-sm font-semibold text-amber-400">A note on risk</h3>
            <p className="text-xs text-gray-400 leading-relaxed">
              This pick is based on a statistical model and AI analysis. The model identified an edge
              at the time of generation. Edges erode, lines move, and results vary.
            </p>
            <ul className="text-xs text-gray-500 space-y-1">
              <li>• Past performance does not predict future results.</li>
              <li>• This is analysis, not a guarantee.</li>
              <li>• Never bet more than your stated bankroll limit.</li>
            </ul>
            <p className="text-xs text-gray-600">
              Struggling?{' '}
              <a href="tel:18005224700" className="text-amber-600 hover:underline">
                1-800-522-4700
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Surface 1 footer disclaimer */}
      <div className="mt-8">
        <ResponsibleGamblingBanner surface="footer" />
      </div>
    </div>
  );
}
