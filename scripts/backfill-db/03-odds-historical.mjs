/**
 * Step 3 — Load historical Odds API snapshots from disk into `odds` table.
 *
 * Source: data/historical-odds/{year}/{YYYY-MM-DD}.json (already fetched; 0 credits)
 * Target: odds table
 * Tags every row: source = 'odds_api_historical', closing_snapshot = true
 *
 * Idempotency: ON CONFLICT (game_id, sportsbook_id, market) WHERE closing_snapshot = true DO NOTHING
 *
 * Game matching strategy:
 *   For each API game, use commence_time (UTC) to derive the game_date, then match by
 *   (game_date, normalized_home_team, normalized_away_team). This handles doubleheaders
 *   and cross-midnight games correctly.
 *   Fallback: ±1 day window on game_date in case of cross-midnight discrepancy.
 *
 * Market mapping: h2h → moneyline (only h2h is loaded for v0)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, makeDbClient, log, REPO_ROOT } from './shared.mjs';

loadEnv();

const MARKET_MAP = { h2h: 'moneyline' };
const SPORTSBOOK_IDS = new Map();
const YEARS = [2022, 2023, 2024];

/** Normalize team name → franchise moniker, lowercase, no punct.
 *  "Colorado Rockies" → "rockies", "Boston Red Sox" → "redsox"
 *  "Chicago White Sox" → "whitesox", "Chicago Cubs" → "cubs" */
function normTeam(name) {
  if (!name) return '';
  // Remove "the " prefix if present
  const clean = name.trim().replace(/^the\s+/i, '');
  // Take everything after the last city word(s)
  // Better: take last 1-2 words (franchise name), lowercase, remove spaces+punct
  const parts = clean.split(' ');
  // If 3+ parts, use last 2 words (handles "Red Sox", "White Sox", "Blue Jays")
  const franchise = parts.length >= 3
    ? parts.slice(-2).join('').toLowerCase().replace(/[^a-z]/g, '')
    : parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  return franchise;
}

/** Derive game_date from commence_time UTC.
 *  MLB games starting before 04:00 UTC are still "the previous calendar day" in ET.
 *  Use a 4h UTC cutoff: games starting 00:00-03:59 UTC belong to the previous ET date.
 *  This matches how MLB Stats API assigns game_date. */
function gameDate(commenceTimeUtc) {
  const d = new Date(commenceTimeUtc);
  const hourUtc = d.getUTCHours();
  if (hourUtc < 4) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step3_start');

  const startTs = Date.now();

  const { rows: books } = await db.query('SELECT id, key FROM sportsbooks');
  for (const b of books) SPORTSBOOK_IDS.set(b.key, b.id);

  // Load all 2022-2024 games into memory for fast matching
  // Build lookup: `${game_date}|${normHome}|${normAway}` → game row (array to handle rare dupes)
  const { rows: gameRows } = await db.query(
    `SELECT g.id, g.mlb_game_id, g.game_date::text, g.game_time_utc::text,
            ht.name AS home_name, at.name AS away_name
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
     ORDER BY g.game_date, g.game_time_utc`
  );

  log('info', 'step3_games_loaded', { count: gameRows.length });

  if (gameRows.length === 0) {
    log('error', 'step3_no_games', {});
    console.error('[ABORT] No 2022-2024 games in DB. Run 01-games-schedule.mjs first.');
    await db.end();
    process.exit(1);
  }

  // Primary lookup: date|normHome|normAway → game (multi-value for doubleheaders)
  const byTeamDate = new Map();
  // Secondary lookup: date|normHome → [games] (for when away team name doesn't match)
  const byDateHome = new Map();

  for (const g of gameRows) {
    const normH = normTeam(g.home_name);
    const normA = normTeam(g.away_name);
    const date = g.game_date;

    const primary = `${date}|${normH}|${normA}`;
    if (!byTeamDate.has(primary)) byTeamDate.set(primary, []);
    byTeamDate.get(primary).push(g);

    const secondary = `${date}|${normH}`;
    if (!byDateHome.has(secondary)) byDateHome.set(secondary, []);
    byDateHome.get(secondary).push(g);
  }

  let totalFiles = 0;
  let totalGamesAttempted = 0;
  let totalRowsInserted = 0;
  let totalGamesMatched = 0;
  let totalGamesMissed = 0;
  let totalDkFdBothPresent = 0;
  const gapDates = [];
  const errors = [];

  for (const year of YEARS) {
    const dir = join(REPO_ROOT, 'data', 'historical-odds', String(year));
    let files;
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    } catch {
      log('warn', 'step3_no_dir', { year, dir });
      continue;
    }

    let yearInserted = 0;
    let yearMissed = 0;
    let yearMatched = 0;

    for (const file of files) {
      totalFiles++;
      let raw;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      } catch (err) {
        errors.push(`${year}/${file}: parse error: ${err.message}`);
        continue;
      }

      const apiGames = raw.data ?? [];
      if (apiGames.length === 0) continue;

      for (const apiGame of apiGames) {
        totalGamesAttempted++;

        if (!apiGame.commence_time) {
          yearMissed++;
          totalGamesMissed++;
          continue;
        }

        const matchedGame = matchGame(apiGame, byTeamDate, byDateHome);

        if (!matchedGame) {
          yearMissed++;
          totalGamesMissed++;
          const key = `${apiGame.commence_time.slice(0,10)}|${apiGame.away_team}@${apiGame.home_team}`;
          if (!gapDates.includes(key)) gapDates.push(key);
          continue;
        }

        yearMatched++;
        totalGamesMatched++;

        const booksPresent = (apiGame.bookmakers ?? []).map(b => b.key);
        if (booksPresent.includes('draftkings') && booksPresent.includes('fanduel')) {
          totalDkFdBothPresent++;
        }

        const snapshotTs = raw.timestamp ?? matchedGame.game_time_utc;

        for (const bookmaker of (apiGame.bookmakers ?? [])) {
          const sbId = SPORTSBOOK_IDS.get(bookmaker.key);
          if (!sbId) continue;

          for (const market of (bookmaker.markets ?? [])) {
            const ourMarket = MARKET_MAP[market.key];
            if (!ourMarket) continue;

            const outcomes = market.outcomes ?? [];
            const homeOutcome = outcomes.find(o => o.name === apiGame.home_team);
            const awayOutcome = outcomes.find(o => o.name === apiGame.away_team);
            if (!homeOutcome && !awayOutcome) continue;

            try {
              await db.query(
                `INSERT INTO odds (
                   game_id, sportsbook_id, market,
                   home_price, away_price,
                   snapshotted_at, closing_snapshot, source
                 ) VALUES ($1,$2,$3::market_type,$4,$5,$6,true,'odds_api_historical')
                 ON CONFLICT (game_id, sportsbook_id, market)
                   WHERE closing_snapshot = true
                 DO NOTHING`,
                [
                  matchedGame.id,
                  sbId,
                  ourMarket,
                  homeOutcome?.price ?? null,
                  awayOutcome?.price ?? null,
                  snapshotTs,
                ]
              );
              totalRowsInserted++;
              yearInserted++;
            } catch (err) {
              if (err.code !== '23505') {
                errors.push(`insert ${matchedGame.id}/${bookmaker.key}: ${err.message}`);
              }
            }
          }
        }
      }
    }

    log('info', 'step3_year_done', {
      year,
      files: files.length,
      matched: yearMatched,
      missed: yearMissed,
      inserted: yearInserted,
    });
  }

  const wallMs = Date.now() - startTs;

  const { rows: coverageRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            sb.key AS sportsbook,
            COUNT(DISTINCT o.game_id) AS games_covered
     FROM odds o
     JOIN games g ON g.id = o.game_id
     JOIN sportsbooks sb ON sb.id = o.sportsbook_id
     WHERE o.market = 'moneyline'
       AND o.closing_snapshot = true
       AND o.source = 'odds_api_historical'
       AND EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
     GROUP BY 1, 2 ORDER BY 1, 2`
  );

  log('info', 'step3_complete', {
    total_files: totalFiles,
    total_games_attempted: totalGamesAttempted,
    total_games_matched: totalGamesMatched,
    total_games_missed: totalGamesMissed,
    total_rows_inserted: totalRowsInserted,
    games_with_both_dk_fd: totalDkFdBothPresent,
    coverage_by_season: coverageRows,
    gap_count: gapDates.length,
    wall_ms: wallMs,
  });

  console.log('\n=== STEP 3 COMPLETE: Historical Odds ===');
  console.log(`Files processed:     ${totalFiles}`);
  console.log(`Games attempted:     ${totalGamesAttempted}`);
  console.log(`Games matched:       ${totalGamesMatched}`);
  console.log(`Games missed (gap):  ${totalGamesMissed}`);
  console.log(`Rows inserted (new): ${totalRowsInserted}`);
  console.log(`Games with DK+FD:    ${totalDkFdBothPresent}`);
  console.log(`Coverage (closing by season/book):`);
  for (const r of coverageRows) {
    console.log(`  ${r.season} ${r.sportsbook}: ${r.games_covered} games`);
  }
  console.log(`Wall time:           ${(wallMs / 1000).toFixed(1)}s`);
  if (gapDates.length > 0) {
    console.log(`\nGap sample (${gapDates.length} total — first 20):`);
    gapDates.slice(0, 20).forEach(g => console.log(`  ${g}`));
  }
  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length}):`);
    errors.slice(0, 20).forEach(e => console.error(`  ${e}`));
    process.exitCode = 1;
  }

  await db.end();
}

/**
 * Match an API game to a DB game row.
 * Uses commence_time-derived game_date + normalized team pair.
 * Handles doubleheaders (same teams, same date, different times) by returning
 * the game whose game_time_utc is closest to commence_time.
 */
function matchGame(apiGame, byTeamDate, byDateHome) {
  const normH = normTeam(apiGame.home_team);
  const normA = normTeam(apiGame.away_team);

  const commenceTs = new Date(apiGame.commence_time).getTime();

  // Try the derived game date and ±1 day (cross-midnight edge cases)
  const baseDateStr = gameDate(apiGame.commence_time);
  const candidates = [];

  for (const delta of [0, -1, 1]) {
    const d = new Date(`${baseDateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    const tryDate = d.toISOString().slice(0, 10);

    // Primary: date + home + away
    const pk = `${tryDate}|${normH}|${normA}`;
    const rows = byTeamDate.get(pk);
    if (rows?.length === 1) return rows[0];
    if (rows?.length > 1) {
      // Doubleheader: pick game closest to commence_time
      candidates.push(...rows);
    }

    // Secondary: date + home only (away name mismatch)
    const sk = `${tryDate}|${normH}`;
    const srows = byDateHome.get(sk);
    if (srows?.length === 1) return srows[0];
    if (srows?.length > 1) candidates.push(...srows);
  }

  if (candidates.length > 0) {
    // Pick the candidate whose game_time_utc is closest to commence_time
    let best = null;
    let bestDelta = Infinity;
    for (const c of candidates) {
      if (!c.game_time_utc) continue;
      const d = Math.abs(new Date(c.game_time_utc).getTime() - commenceTs);
      if (d < bestDelta) { bestDelta = d; best = c; }
    }
    // Accept if within 15 minutes
    if (best && bestDelta <= 15 * 60 * 1000) return best;
  }

  return null;
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
