/**
 * News event → games.id matcher for news signal extraction.
 *
 * Signals used (in priority order):
 *   1. Author handle: if the author is a known beat writer for a specific team,
 *      bias toward games involving that team.
 *   2. Body text: check for explicit team name mentions (full name or abbreviation).
 *   3. Time proximity: prefer games whose first_pitch is within 3 hours of published_at.
 *
 * Returns the best matching game_id UUID, or null if:
 *   - No games are provided (no games in the window).
 *   - Multiple games are equally plausible and no tiebreaker resolves.
 *   - No team name appears in the body and no author match exists.
 *
 * Why null on ambiguity:
 *   A wrong game_id links a signal to the wrong game and corrupts pick logic.
 *   The Supabase schema allows null game_id in news_signals — the Edge Function
 *   can re-attempt resolution at a later sweep when more context is available.
 */

export interface GameWindow {
  game_id: string;
  home_team_name: string;
  away_team_name: string;
  home_team_abbr: string;
  away_team_abbr: string;
  /** ISO 8601 UTC first-pitch time. */
  first_pitch_utc: string;
}

export interface BeatWriterHint {
  /** Bluesky handle or RSS author string to match against news_events.author. */
  author: string;
  /** MLB team abbreviation(s) this author primarily covers; [] = national. */
  teams: string[];
}

export interface GameMatchInput {
  /** Author field from the news_events row. */
  author: string | null;
  /** Body text of the news_events row. */
  body: string;
  /** Publication timestamp ISO 8601 UTC. */
  published_at: string;
  /** Games with first_pitch in the current sweep window (~now to now+120min). */
  games: GameWindow[];
  /** Optional: beat-writer team hints. If omitted, author matching is skipped. */
  beatWriterHints?: BeatWriterHint[];
}

/**
 * Match a news event to the most likely games.id in the window.
 * Returns null if the match is ambiguous or no evidence points to any game.
 */
export function matchGameId(input: GameMatchInput): string | null {
  const { author, body, published_at, games, beatWriterHints = [] } = input;

  if (games.length === 0) return null;
  if (games.length === 1) return games[0].game_id;

  // Score each game — higher score = stronger match
  const scores = games.map((g) => ({ game: g, score: 0 }));

  // Signal 1: author handle matches a beat writer for one of the teams
  if (author) {
    const authorLower = author.toLowerCase();
    for (const hint of beatWriterHints) {
      if (!hint.author.toLowerCase().includes(authorLower) &&
          !authorLower.includes(hint.author.toLowerCase())) continue;
      // This author covers specific teams — add score to matching games
      if (hint.teams.length === 0) continue; // national writer — no team bias
      for (const entry of scores) {
        if (
          hint.teams.includes(entry.game.home_team_abbr) ||
          hint.teams.includes(entry.game.away_team_abbr)
        ) {
          entry.score += 3;
        }
      }
    }
  }

  // Signal 2: team name or abbreviation appears in body text
  const bodyLower = body.toLowerCase();
  for (const entry of scores) {
    const g = entry.game;
    const namesToCheck = [
      g.home_team_name.toLowerCase(),
      g.away_team_name.toLowerCase(),
      g.home_team_abbr.toLowerCase(),
      g.away_team_abbr.toLowerCase(),
    ];
    for (const name of namesToCheck) {
      if (bodyLower.includes(name)) {
        entry.score += 2;
        break; // one point per game, not per mention
      }
    }
  }

  // Signal 3: time proximity — games closer to published_at score higher
  const pubMs = new Date(published_at).getTime();
  for (const entry of scores) {
    const pitchMs = new Date(entry.game.first_pitch_utc).getTime();
    const diffHours = Math.abs(pitchMs - pubMs) / 3_600_000;
    // Within 90 min: +2; within 3h: +1; beyond 3h: +0
    if (diffHours <= 1.5) entry.score += 2;
    else if (diffHours <= 3) entry.score += 1;
  }

  // Pick the highest-scoring game — null if tied
  scores.sort((a, b) => b.score - a.score);
  if (scores[0].score === 0) return null;
  if (scores.length > 1 && scores[0].score === scores[1].score) return null;

  return scores[0].game.game_id;
}
