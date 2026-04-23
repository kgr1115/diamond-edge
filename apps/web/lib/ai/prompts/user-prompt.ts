import type { RationaleInput, FeatureAttribution } from '@/lib/ai/types';

/**
 * Build the per-pick user message for Claude.
 *
 * This is NOT cache-eligible — it changes with every pick.
 * Keep the system prompt stable for caching; put all pick-specific
 * variable data here.
 *
 * Output is structured markdown so the LLM receives human-readable
 * context rather than raw machine JSON.
 */
export function buildUserPrompt(input: RationaleInput): string {
  const { pick, game_context, tier } = input;
  const tierLabel = tier === 'elite' ? 'ELITE' : 'PRO';

  // Format American odds for readability
  const oddsStr = formatOdds(pick.best_line.price);
  const bookName = pick.best_line.sportsbook_key === 'draftkings' ? 'DraftKings' : 'FanDuel';

  // Format pick side for readability
  const pickSideStr = formatPickSide(pick.pick_side, pick.market);

  // Model probability as percentage
  const probPct = (pick.model_probability * 100).toFixed(1);
  // EV as percentage
  const evPct = (pick.expected_value * 100).toFixed(1);

  // Top attributions — cap at 5 for elite, 3 for pro
  const maxAttributions = tier === 'elite' ? 5 : 3;
  const attributions = pick.feature_attributions
    .slice(0, maxAttributions);

  // Pitcher context
  const homePitcher = game_context.probable_home_pitcher?.full_name ?? 'TBD';
  const awayPitcher = game_context.probable_away_pitcher?.full_name ?? 'TBD';

  // Weather context (only include if available)
  const weatherStr = game_context.weather
    ? `${game_context.weather.temp_f}°F, ${game_context.weather.condition}, ` +
      `wind ${game_context.weather.wind_mph} mph ${game_context.weather.wind_dir}`
    : 'Not available';

  return `\
TIER: ${tierLabel}

## Game Context

Matchup: ${game_context.away_team.name} (${game_context.away_team.abbreviation}) \
at ${game_context.home_team.name} (${game_context.home_team.abbreviation})
Records: ${game_context.away_team.abbreviation} ${game_context.away_team.record} / \
${game_context.home_team.abbreviation} ${game_context.home_team.record}
Time: ${game_context.game_time_local}
Venue: ${game_context.venue}
Probable Pitchers: ${awayPitcher} (away) vs. ${homePitcher} (home)
Weather: ${weatherStr}

## The Pick

Market: ${formatMarket(pick.market)}
Pick: ${pickSideStr}
Best Available Line: ${oddsStr} (${bookName})
Model Probability: ${probPct}%
${tier === 'elite' ? `Expected Value: +${evPct}%` : ''}
Confidence Tier: ${pick.confidence_tier}/5

## Feature Attributions (Key Factors)

${formatAttributions(attributions)}

---

Write the rationale for this pick following the TIER: ${tierLabel} format specified \
in your instructions. Use only the facts provided above — do not introduce any \
statistics, names, or claims not present in this message.`;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatOdds(americanOdds: number): string {
  return americanOdds > 0 ? `+${americanOdds}` : `${americanOdds}`;
}

function formatPickSide(side: string, market: string): string {
  if (market === 'moneyline' || market === 'run_line') {
    if (side === 'home') return 'Home Team (Moneyline)';
    if (side === 'away') return 'Away Team (Moneyline)';
  }
  if (market === 'total') {
    if (side === 'over') return 'Over';
    if (side === 'under') return 'Under';
  }
  return side;
}

function formatMarket(market: string): string {
  const labels: Record<string, string> = {
    moneyline: 'Moneyline',
    run_line: 'Run Line',
    total: 'Total (Over/Under)',
    prop: 'Player Prop',
  };
  return labels[market] ?? market;
}

function formatAttributions(attributions: FeatureAttribution[]): string {
  if (attributions.length === 0) return 'No attributions available.';

  return attributions
    .map((attr, i) => {
      const directionLabel = attr.direction === 'positive' ? 'supports pick' : 'works against pick';
      return `${i + 1}. ${attr.label} (${directionLabel})`;
    })
    .join('\n');
}
