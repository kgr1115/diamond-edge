/**
 * Normalizes The Odds API response into `odds` table Insert rows.
 *
 * Key responsibilities:
 * - Match The Odds API game (identified by team names + date) to our games.id UUID.
 * - Map bookmaker keys ('draftkings', 'fanduel') to sportsbooks.id UUIDs.
 * - Map Odds API market keys ('h2h', 'spreads', 'totals') to our MarketType enum.
 * - Determine home/away direction for moneyline and run-line outcomes.
 * - Enforce UTC on snapshotted_at — never local time.
 */

import type { Database, MarketType } from '@/lib/types/database';
import type { OddsApiGame, OddsApiBookmaker, OddsApiMarket, OddsApiOutcome } from './client';
import { ODDS_API_MARKET_MAP } from '@/lib/ingestion/config';

type OddsInsertRow = Database['public']['Tables']['odds']['Insert'];

// ---------------------------------------------------------------------------
// Lookup types — built from DB data at call site in poll.ts
// ---------------------------------------------------------------------------

export interface GameRecord {
  id: string;             // our UUID (games.id)
  home_team_name: string; // from teams.name join
  away_team_name: string;
  game_date: string;      // 'YYYY-MM-DD'
  game_time_utc: string | null;
}

export interface SportsbookRecord {
  id: string;   // our UUID (sportsbooks.id)
  key: string;  // 'draftkings' | 'fanduel' | ...
}

// ---------------------------------------------------------------------------
// Transform entry point
// ---------------------------------------------------------------------------

export interface TransformResult {
  rows: OddsInsertRow[];
  unmatchedGames: string[];  // Odds API game IDs we could not match to a DB game
  snapshotTime: string;      // ISO 8601 UTC — applied to every row's snapshotted_at
}

/**
 * Transform an array of OddsApiGame objects into odds table insert rows.
 *
 * @param apiGames   - Raw response from The Odds API
 * @param games      - Today's games from our DB (with team names via join)
 * @param sportsbooks - Active sportsbooks from our DB
 */
export function transformOddsToRows(
  apiGames: OddsApiGame[],
  games: GameRecord[],
  sportsbooks: SportsbookRecord[]
): TransformResult {
  const snapshotTime = new Date().toISOString(); // UTC

  // Build O(1) lookups
  const gameByKey = buildGameLookup(games);
  const sportsbookById = new Map(sportsbooks.map(sb => [sb.key, sb.id]));

  const rows: OddsInsertRow[] = [];
  const unmatchedGames: string[] = [];

  for (const apiGame of apiGames) {
    const gameId = lookupGame(apiGame, gameByKey);
    if (!gameId) {
      unmatchedGames.push(apiGame.id);
      continue;
    }

    for (const bookmaker of apiGame.bookmakers) {
      const sportsbookId = sportsbookById.get(bookmaker.key);
      if (!sportsbookId) {
        // Book returned by Odds API but not in our sportsbooks table — skip silently.
        // This should not happen because we request only active books.
        continue;
      }

      for (const market of bookmaker.markets) {
        const marketRows = transformMarket(
          market,
          apiGame,
          gameId,
          sportsbookId,
          snapshotTime
        );
        rows.push(...marketRows);
      }
    }
  }

  return { rows, unmatchedGames, snapshotTime };
}

// ---------------------------------------------------------------------------
// Game matching
// ---------------------------------------------------------------------------

/** Key: `{normalized_home}|{normalized_away}|{YYYY-MM-DD}` */
function buildGameLookup(games: GameRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const g of games) {
    const key = makeGameKey(g.home_team_name, g.away_team_name, g.game_date);
    map.set(key, g.id);
  }
  return map;
}

function lookupGame(apiGame: OddsApiGame, lookup: Map<string, string>): string | null {
  const date = apiGame.commence_time.slice(0, 10); // 'YYYY-MM-DD' from UTC ISO string
  const key = makeGameKey(apiGame.home_team, apiGame.away_team, date);
  return lookup.get(key) ?? null;
}

function makeGameKey(home: string, away: string, date: string): string {
  return `${normalizeTeam(home)}|${normalizeTeam(away)}|${date}`;
}

function normalizeTeam(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Market transformation
// ---------------------------------------------------------------------------

function transformMarket(
  market: OddsApiMarket,
  apiGame: OddsApiGame,
  gameId: string,
  sportsbookId: string,
  snapshotTime: string
): OddsInsertRow[] {
  const marketType = ODDS_API_MARKET_MAP[market.key];
  if (!marketType) return []; // Unknown market key — skip

  const base: Partial<OddsInsertRow> = {
    game_id: gameId,
    sportsbook_id: sportsbookId,
    market: marketType,
    snapshotted_at: snapshotTime,
  };

  switch (market.key) {
    case 'h2h':
      return transformMoneyline(market.outcomes, apiGame, base);
    case 'spreads':
      return transformRunLine(market.outcomes, apiGame, base);
    case 'totals':
      return transformTotals(market.outcomes, base);
    default:
      return [];
  }
}

/** h2h → moneyline: identify home/away price from team names. */
function transformMoneyline(
  outcomes: OddsApiOutcome[],
  apiGame: OddsApiGame,
  base: Partial<OddsInsertRow>
): OddsInsertRow[] {
  const homeOutcome = outcomes.find(o => normalizeTeam(o.name) === normalizeTeam(apiGame.home_team));
  const awayOutcome = outcomes.find(o => normalizeTeam(o.name) === normalizeTeam(apiGame.away_team));

  if (!homeOutcome && !awayOutcome) return [];

  return [{
    ...base,
    home_price: homeOutcome?.price ?? null,
    away_price: awayOutcome?.price ?? null,
  } as OddsInsertRow];
}

/**
 * spreads → run_line: store home team's spread as run_line_spread.
 * MLB run lines are almost always ±1.5; store the actual value in case it moves.
 */
function transformRunLine(
  outcomes: OddsApiOutcome[],
  apiGame: OddsApiGame,
  base: Partial<OddsInsertRow>
): OddsInsertRow[] {
  const homeOutcome = outcomes.find(o => normalizeTeam(o.name) === normalizeTeam(apiGame.home_team));
  const awayOutcome = outcomes.find(o => normalizeTeam(o.name) === normalizeTeam(apiGame.away_team));

  if (!homeOutcome && !awayOutcome) return [];

  return [{
    ...base,
    home_price: homeOutcome?.price ?? null,
    away_price: awayOutcome?.price ?? null,
    // Store the home team's spread point (e.g., -1.5 if home is favored)
    run_line_spread: homeOutcome?.point ?? null,
  } as OddsInsertRow];
}

/** totals → over/under: line is the same for both outcomes. */
function transformTotals(
  outcomes: OddsApiOutcome[],
  base: Partial<OddsInsertRow>
): OddsInsertRow[] {
  const overOutcome = outcomes.find(o => o.name === 'Over');
  const underOutcome = outcomes.find(o => o.name === 'Under');

  if (!overOutcome && !underOutcome) return [];

  // total_line is the same for over and under
  const totalLine = (overOutcome ?? underOutcome)?.point ?? null;

  return [{
    ...base,
    total_line: totalLine,
    over_price: overOutcome?.price ?? null,
    under_price: underOutcome?.price ?? null,
  } as OddsInsertRow];
}
