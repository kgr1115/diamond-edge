/**
 * Per-invocation user prompt for news signal extraction.
 *
 * NOT cache-eligible — the news items change with every call.
 * The system prompt (stable taxonomy + rules) is cached; only this
 * small, variable block is unchached input.
 *
 * Inputs:
 *   - news_items: array of news_events rows for the game window
 *   - game_context: team names, player roster with IDs and WAR values
 *
 * The prompt deliberately omits explicit JSON schema repetition here —
 * that lives in the cacheable system prompt above. The user turn only
 * provides the variable data the model needs to extract from.
 */

export interface NewsItem {
  /** Raw body text of the news event. */
  body: string;
  /** ISO 8601 UTC publication timestamp. */
  published_at: string;
  /** Source identifier: 'bluesky', 'mlb_rss', 'espn', 'rotoballer', 'mlb_stats_api' */
  source: string;
  /** Bluesky handle or RSS author name; null for API sources. */
  author: string | null;
}

export interface RosterPlayer {
  /** UUID from the players table — must be set on player_id in extracted signals. */
  player_id: string;
  /** Full name as stored in the players table. */
  name: string;
  /** Season WAR or best available proxy. Use as war_proxy when the player is scratched. */
  war: number | null;
}

export interface NewsExtractionGameContext {
  home_team_name: string;
  away_team_name: string;
  /** All active roster players for both teams involved in tonight's game. */
  home_players: RosterPlayer[];
  away_players: RosterPlayer[];
  /** ISO 8601 UTC first-pitch time. */
  game_time_utc: string;
}

/**
 * Build the user-turn prompt for a single news extraction call.
 *
 * Token budget target: ~400 tokens per game window (30 news items × ~12 tokens/item
 * plus roster block and framing). This is the uncached portion charged at full input price.
 */
export function buildNewsExtractionUserPrompt(
  newsItems: NewsItem[],
  gameContext: NewsExtractionGameContext,
): string {
  const rosterBlock = buildRosterBlock(gameContext);
  const newsBlock = buildNewsBlock(newsItems);

  return `\
## Game

${gameContext.away_team_name} at ${gameContext.home_team_name}
First pitch (UTC): ${gameContext.game_time_utc}

## Active Roster (for player_id resolution)

${rosterBlock}

## News Items (${newsItems.length} items, ordered newest-first)

${newsBlock}

---

Extract all actionable signals from the news items above. \
Match any player names to the player_id values in the Active Roster. \
If a player name does not appear in the roster, set player_id to null. \
Return only the JSON array — no other text.`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildRosterBlock(ctx: NewsExtractionGameContext): string {
  const homeLines = ctx.home_players.map(
    (p) => `  ${p.name} | id:${p.player_id} | war:${p.war ?? 'n/a'} | ${ctx.home_team_name}`
  );
  const awayLines = ctx.away_players.map(
    (p) => `  ${p.name} | id:${p.player_id} | war:${p.war ?? 'n/a'} | ${ctx.away_team_name}`
  );

  const allLines = [...homeLines, ...awayLines];
  if (allLines.length === 0) return '  (no roster data available)';

  return allLines.join('\n');
}

function buildNewsBlock(items: NewsItem[]): string {
  if (items.length === 0) return '  (no news items in this window)';

  return items
    .map((item, i) => {
      const ts = item.published_at.slice(0, 16).replace('T', ' ') + ' UTC';
      const authorStr = item.author ? ` [${item.author}]` : '';
      return `[${i + 1}] ${ts} (${item.source}${authorStr})\n${item.body.trim()}`;
    })
    .join('\n\n');
}
