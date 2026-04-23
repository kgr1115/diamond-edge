/**
 * Player name → players.id resolver for news signal extraction.
 *
 * Strategy: fuzzy match on full_name from the game_context roster provided
 * to the extraction call. We do NOT query the DB here — the roster is already
 * in memory from the extraction request, keeping this pure and testable.
 *
 * Resolution rules (in order):
 *   1. Exact match on full_name (case-insensitive).
 *   2. Last-name-only match when the name string contains no space.
 *   3. Jaro-Winkler similarity >= 0.92 on full_name (handles typos / abbreviations).
 *   4. If zero or two-or-more candidates match at any step, return null.
 *      We never guess between multiple candidates.
 *
 * Why null on ambiguity rather than best-guess:
 *   A wrong player_id is worse than null. Downstream ML features (war_proxy) are
 *   either not set or are explicit no-ops on null. A wrong ID silently corrupts
 *   the feature vector for the actual scratched player.
 */

export interface RosterEntry {
  player_id: string;
  name: string;
  war: number | null;
}

export interface ResolvedPlayer {
  player_id: string;
  name: string;
  war: number | null;
}

/**
 * Attempt to resolve a player name extracted from news text to a players.id UUID.
 *
 * Returns null if:
 *   - No match found (player not in tonight's game or name too different)
 *   - Multiple plausible matches (ambiguous — refuse to guess)
 *
 * @param extractedName - The name string Claude extracted from the news text.
 * @param roster        - All players in the game window (both teams combined).
 */
export function resolvePlayer(
  extractedName: string,
  roster: RosterEntry[],
): ResolvedPlayer | null {
  if (!extractedName || roster.length === 0) return null;

  const normalizedInput = extractedName.trim().toLowerCase();

  // Step 1: exact match (case-insensitive)
  const exactMatches = roster.filter(
    (p) => p.name.toLowerCase() === normalizedInput,
  );
  if (exactMatches.length === 1) return toResolved(exactMatches[0]);
  if (exactMatches.length > 1) return null; // ambiguous

  // Step 2: last-name-only match (when input has no space — e.g. "Ohtani")
  if (!normalizedInput.includes(' ')) {
    const lastNameMatches = roster.filter(
      (p) => p.name.toLowerCase().split(' ').pop() === normalizedInput,
    );
    if (lastNameMatches.length === 1) return toResolved(lastNameMatches[0]);
    if (lastNameMatches.length > 1) return null; // ambiguous (e.g. "Martinez")
  }

  // Step 3: Jaro-Winkler similarity >= 0.92
  const fuzzyMatches: Array<{ entry: RosterEntry; score: number }> = [];
  for (const p of roster) {
    const score = jaroWinkler(normalizedInput, p.name.toLowerCase());
    if (score >= 0.92) {
      fuzzyMatches.push({ entry: p, score });
    }
  }

  if (fuzzyMatches.length === 1) return toResolved(fuzzyMatches[0].entry);
  // ambiguous or no match
  return null;
}

function toResolved(entry: RosterEntry): ResolvedPlayer {
  return { player_id: entry.player_id, name: entry.name, war: entry.war };
}

// ---------------------------------------------------------------------------
// Jaro-Winkler similarity (pure function — no dependencies)
// ---------------------------------------------------------------------------
// Reference implementation sufficient for short name strings.
// Prefix scaling factor p = 0.1 (standard Winkler default).

function jaroWinkler(s1: string, s2: string): number {
  const jaroScore = jaro(s1, s2);
  if (jaroScore === 0) return 0;

  // Compute common prefix length (max 4 chars)
  let prefixLen = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) prefixLen++;
    else break;
  }

  return jaroScore + prefixLen * 0.1 * (1 - jaroScore);
}

function jaro(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array<boolean>(s1.length).fill(false);
  const s2Matches = new Array<boolean>(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3
  );
}
