/**
 * Step 3b — Load PER-GAME historical odds snapshots from disk into `odds`.
 *
 * Source: data/historical-odds-pergame/{year}/{game_id}.json
 *   One file per game; payload's top-level `timestamp` is the API's actual
 *   archived snap (the FIX — the old per-batch loader at 03-odds-historical.mjs
 *   stamped night-game rows with the next-day 03:00 UTC fetch wall-clock,
 *   which is 1-4 hours AFTER first pitch).
 *
 * Target: odds table
 * Tags every row: source = 'odds_api_historical_pergame', closing_snapshot = true
 *
 * Idempotency strategy:
 *   For each game we have a per-game payload for, FIRST delete the old
 *   `source = 'odds_api_historical'` closing rows (the buggy ones), THEN insert
 *   fresh per-game rows. This keeps the unique partial index
 *   idx_odds_closing_per_game_book_market satisfied and lets the script re-run
 *   safely (the second-run delete is a no-op because the buggy source is gone).
 *
 * Live-ingestion rows (source = 'odds_api_live') are LEFT ALONE — those carry
 * intra-day live captures and are independent of the closing-snapshot pin.
 *
 * COO/CEng conditions enforced:
 *   - response_timestamp_recorded: snapshotted_at = raw.timestamp from the API
 *     (NOT the script wall-clock, NOT matchedGame.game_time_utc, NOT now()).
 *     If raw.timestamp is missing for a payload, that game is skipped and logged.
 *   - drop_predicate_unchanged: this loader does not impute. Games where the
 *     per-game pull returned no DK or no FD h2h outcome are loaded as-is (NULL
 *     prices); the feature-eng layer applies the both-books-required drop.
 *
 * Market mapping: h2h → moneyline (only h2h is loaded from per-game payloads;
 *   spreads/totals are not part of v0 scope and were not requested in the pull).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, makeDbClient, log, REPO_ROOT } from './shared.mjs';

loadEnv();

const SOURCE_TAG_NEW = 'odds_api_historical_pergame';
const SOURCE_TAG_OLD = 'odds_api_historical';
const PERGAME_ROOT = join(REPO_ROOT, 'data', 'historical-odds-pergame');

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step3b_start');
  const startTs = Date.now();

  // Sportsbook id lookup
  const { rows: books } = await db.query('SELECT id, key FROM sportsbooks');
  const SPORTSBOOK_IDS = new Map(books.map(b => [b.key, b.id]));

  // Enumerate per-game files
  if (!existsSync(PERGAME_ROOT)) {
    console.error(`[ABORT] Per-game payload directory does not exist: ${PERGAME_ROOT}`);
    console.error('Run scripts/backfill-historical-odds/run-per-game.ts first.');
    await db.end();
    process.exit(1);
  }

  const yearDirs = readdirSync(PERGAME_ROOT).filter(d => /^\d{4}$/.test(d)).sort();
  log('info', 'step3b_year_dirs', { years: yearDirs });

  let totalFiles = 0;
  let totalSkippedNoTimestamp = 0;
  let totalSkippedParseError = 0;
  let totalSkippedNoMatchingGame = 0;
  let totalDeletedOldRows = 0;
  let totalInsertedNew = 0;
  let totalGamesWithBothBooks = 0;
  const errors = [];

  for (const yearDir of yearDirs) {
    const dir = join(PERGAME_ROOT, yearDir);
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    totalFiles += files.length;
    log('info', 'step3b_year', { year: yearDir, files: files.length });

    let yearInserted = 0;
    let yearDeleted = 0;
    let yearSkipped = 0;

    for (const file of files) {
      let raw;
      try {
        raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      } catch (err) {
        totalSkippedParseError++;
        yearSkipped++;
        errors.push(`${yearDir}/${file}: parse error: ${err.message}`);
        continue;
      }

      // Filename = {game_id}.json
      const gameId = file.replace(/\.json$/, '');

      // Validate the payload has the API-returned timestamp
      const apiTimestamp = raw.timestamp;
      if (!apiTimestamp || typeof apiTimestamp !== 'string') {
        totalSkippedNoTimestamp++;
        yearSkipped++;
        log('warn', 'step3b_no_api_timestamp', { game_id: gameId, file });
        continue;
      }

      // Validate the game exists
      const { rows: gameRows } = await db.query(
        `SELECT id::text AS id, game_time_utc::text AS game_time_utc,
                (SELECT name FROM teams WHERE id = home_team_id) AS home,
                (SELECT name FROM teams WHERE id = away_team_id) AS away
         FROM games WHERE id = $1::uuid`,
        [gameId],
      );
      if (gameRows.length === 0) {
        totalSkippedNoMatchingGame++;
        yearSkipped++;
        log('warn', 'step3b_game_not_found', { game_id: gameId });
        continue;
      }
      const game = gameRows[0];

      // Find the matching game in the API payload (it should be the only one
      // whose home_team + away_team match)
      const apiGames = raw.data ?? [];
      const matchedApiGame = apiGames.find(ag =>
        ag.home_team && ag.away_team &&
        normTeam(ag.home_team) === normTeam(game.home) &&
        normTeam(ag.away_team) === normTeam(game.away)
      );

      if (!matchedApiGame) {
        // The API didn't return our game in the snapshot — could mean the snap
        // predates the game appearing in the feed. Log and continue.
        log('warn', 'step3b_no_matching_api_game', {
          game_id: gameId,
          db_home: game.home, db_away: game.away,
          api_games_count: apiGames.length,
          api_timestamp: apiTimestamp,
        });
        yearSkipped++;
        continue;
      }

      // Begin transaction: delete old buggy closing rows for this game, insert fresh
      try {
        await db.query('BEGIN');

        // Delete old buggy closing rows for this (game) — keep live and other-source rows
        const delResult = await db.query(
          `DELETE FROM odds
           WHERE game_id = $1::uuid
             AND market = 'moneyline'
             AND closing_snapshot = true
             AND source = $2`,
          [gameId, SOURCE_TAG_OLD],
        );
        totalDeletedOldRows += delResult.rowCount ?? 0;
        yearDeleted += delResult.rowCount ?? 0;

        // Also delete any pre-existing per-game rows for this game (re-run idempotency)
        await db.query(
          `DELETE FROM odds
           WHERE game_id = $1::uuid
             AND market = 'moneyline'
             AND closing_snapshot = true
             AND source = $2`,
          [gameId, SOURCE_TAG_NEW],
        );

        let bookmakersInsertedThisGame = 0;
        let dkInserted = false;
        let fdInserted = false;

        for (const bm of matchedApiGame.bookmakers ?? []) {
          const sbId = SPORTSBOOK_IDS.get(bm.key);
          if (!sbId) continue; // not DK or FD

          const h2h = (bm.markets ?? []).find(m => m.key === 'h2h');
          if (!h2h || !Array.isArray(h2h.outcomes)) continue;

          const homeOutcome = h2h.outcomes.find(o => o.name === matchedApiGame.home_team);
          const awayOutcome = h2h.outcomes.find(o => o.name === matchedApiGame.away_team);
          if (!homeOutcome && !awayOutcome) continue;

          await db.query(
            `INSERT INTO odds (
               game_id, sportsbook_id, market,
               home_price, away_price,
               snapshotted_at, closing_snapshot, source
             ) VALUES ($1::uuid, $2::uuid, 'moneyline'::market_type, $3, $4, $5::timestamptz, true, $6)`,
            [
              gameId, sbId,
              homeOutcome?.price ?? null,
              awayOutcome?.price ?? null,
              apiTimestamp,
              SOURCE_TAG_NEW,
            ],
          );
          bookmakersInsertedThisGame++;
          totalInsertedNew++;
          yearInserted++;
          if (bm.key === 'draftkings') dkInserted = true;
          if (bm.key === 'fanduel') fdInserted = true;
        }

        if (dkInserted && fdInserted) totalGamesWithBothBooks++;

        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK');
        errors.push(`${gameId}: ${err.message}`);
        log('error', 'step3b_insert_failed', { game_id: gameId, err: err.message });
      }
    }

    log('info', 'step3b_year_done', {
      year: yearDir, inserted: yearInserted, deleted: yearDeleted, skipped: yearSkipped,
    });
  }

  const wallMs = Date.now() - startTs;

  // Final coverage check
  const { rows: coverageRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            sb.key AS sportsbook,
            COUNT(DISTINCT o.game_id) AS games_covered
     FROM odds o
     JOIN games g ON g.id = o.game_id
     JOIN sportsbooks sb ON sb.id = o.sportsbook_id
     WHERE o.market = 'moneyline'
       AND o.closing_snapshot = true
       AND o.source = $1
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [SOURCE_TAG_NEW],
  );

  // Snap-pin distribution: how many games now have a closing snap STRICTLY <= game_time_utc - 60min?
  const { rows: pinRows } = await db.query(
    `WITH per_game AS (
       SELECT g.id AS game_id, g.game_time_utc, EXTRACT(YEAR FROM g.game_date)::int AS yr,
              MAX(o.snapshotted_at) FILTER (WHERE sb.key = 'draftkings') AS dk_snap,
              MAX(o.snapshotted_at) FILTER (WHERE sb.key = 'fanduel')   AS fd_snap
       FROM games g
       LEFT JOIN odds o ON o.game_id = g.id
                       AND o.market = 'moneyline'
                       AND o.closing_snapshot = true
                       AND o.source = $1
       LEFT JOIN sportsbooks sb ON sb.id = o.sportsbook_id
       WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
         AND g.status = 'final'
       GROUP BY g.id, g.game_time_utc, g.game_date
     )
     SELECT yr,
            COUNT(*)::int AS finals,
            COUNT(*) FILTER (WHERE dk_snap <= game_time_utc - interval '60 minutes')::int AS dk_pin_ok,
            COUNT(*) FILTER (WHERE fd_snap <= game_time_utc - interval '60 minutes')::int AS fd_pin_ok,
            COUNT(*) FILTER (WHERE dk_snap <= game_time_utc - interval '60 minutes'
                               AND fd_snap <= game_time_utc - interval '60 minutes')::int AS both_pin_ok
     FROM per_game
     GROUP BY yr ORDER BY yr`,
    [SOURCE_TAG_NEW],
  );

  log('info', 'step3b_complete', {
    total_files: totalFiles,
    skipped_no_timestamp: totalSkippedNoTimestamp,
    skipped_parse_error: totalSkippedParseError,
    skipped_no_matching_game: totalSkippedNoMatchingGame,
    deleted_old_rows: totalDeletedOldRows,
    inserted_new_rows: totalInsertedNew,
    games_with_both_books: totalGamesWithBothBooks,
    coverage_by_season: coverageRows,
    pin_distribution: pinRows,
    errors: errors.length,
    wall_ms: wallMs,
  });

  console.log('\n=== STEP 3b COMPLETE: Per-Game Historical Odds ===');
  console.log(`Files processed:        ${totalFiles}`);
  console.log(`Skipped (no timestamp): ${totalSkippedNoTimestamp}`);
  console.log(`Skipped (parse error):  ${totalSkippedParseError}`);
  console.log(`Skipped (no DB match):  ${totalSkippedNoMatchingGame}`);
  console.log(`Deleted old buggy rows: ${totalDeletedOldRows}`);
  console.log(`Inserted new rows:      ${totalInsertedNew}`);
  console.log(`Games with DK+FD both:  ${totalGamesWithBothBooks}`);
  console.log(`\nCoverage (per-game source by season/book):`);
  for (const r of coverageRows) {
    console.log(`  ${r.season} ${r.sportsbook}: ${r.games_covered} games`);
  }
  console.log(`\nT-60 strict pin coverage (per-game source):`);
  for (const r of pinRows) {
    console.log(`  ${r.yr}: finals=${r.finals}  DK_pin_ok=${r.dk_pin_ok}  FD_pin_ok=${r.fd_pin_ok}  both=${r.both_pin_ok}`);
  }
  console.log(`Wall: ${(wallMs / 1000).toFixed(1)}s`);

  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length}):`);
    errors.slice(0, 20).forEach(e => console.error(`  ${e}`));
    process.exitCode = 1;
  }

  await db.end();
}

function normTeam(name) {
  if (!name) return '';
  const clean = name.trim().replace(/^the\s+/i, '');
  const parts = clean.split(' ');
  const franchise = parts.length >= 3
    ? parts.slice(-2).join('').toLowerCase().replace(/[^a-z]/g, '')
    : parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  return franchise;
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
