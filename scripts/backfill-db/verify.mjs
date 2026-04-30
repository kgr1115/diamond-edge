/**
 * Post-backfill verification — produces the metrics.json coverage report.
 *
 * Checks:
 *   1. Games per season (expected ~2,430/season)
 *   2. Weather coverage + wind_dir format validation
 *   3. Closing odds coverage by season/book
 *   4. Lineup coverage by season
 *   5. Park factor rows count
 *   6. Divisional flag counts
 *   7. game_wind_features view sanity (wind_out computable for non-dome outdoor games)
 *
 * Writes output to docs/audits/moneyline-v0-backfill-results-2026-04-30.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, makeDbClient, log, REPO_ROOT } from './shared.mjs';

loadEnv();

async function main() {
  const db = makeDbClient();
  await db.connect();

  const startTs = Date.now();
  const report = { generated_at: new Date().toISOString() };

  // --- 1. Games per season ---
  const { rows: gamesPerSeason } = await db.query(
    `SELECT EXTRACT(YEAR FROM game_date)::int AS season,
            COUNT(*) AS total_games,
            COUNT(*) FILTER (WHERE status = 'final') AS final_games,
            COUNT(*) FILTER (WHERE status = 'postponed') AS postponed,
            COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
            COUNT(*) FILTER (WHERE divisional_flag = true) AS divisional_games
     FROM games
     WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
     GROUP BY 1 ORDER BY 1`
  );
  report.games_per_season = gamesPerSeason;
  report.total_games = gamesPerSeason.reduce((s, r) => s + parseInt(r.total_games, 10), 0);
  report.expected_games_approx = 7290;
  report.games_coverage_pct = +(report.total_games / report.expected_games_approx * 100).toFixed(1);

  // --- 2. Weather coverage ---
  const { rows: weatherRows } = await db.query(
    `SELECT
       EXTRACT(YEAR FROM game_date)::int AS season,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE weather_temp_f IS NOT NULL) AS has_temp,
       COUNT(*) FILTER (WHERE weather_wind_mph IS NOT NULL) AS has_wind_mph,
       COUNT(*) FILTER (WHERE weather_wind_dir IS NOT NULL) AS has_wind_dir,
       COUNT(*) FILTER (WHERE weather_wind_dir ~ '^[0-9]+$') AS wind_dir_numeric,
       COUNT(*) FILTER (WHERE weather_wind_dir !~ '^[0-9]+$' AND weather_wind_dir IS NOT NULL) AS wind_dir_bad_format
     FROM games
     WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
     GROUP BY 1 ORDER BY 1`
  );
  report.weather_coverage = weatherRows;

  // Check for field-relative strings that should not exist
  const { rows: badWindDir } = await db.query(
    `SELECT weather_wind_dir, COUNT(*) AS n FROM games
     WHERE (weather_wind_dir ILIKE '%CF%' OR weather_wind_dir ILIKE '%LF%'
            OR weather_wind_dir ILIKE '%RF%'
            OR weather_wind_dir IN ('N','NE','E','SE','S','SW','W','NW'))
     GROUP BY 1`
  );
  report.weather_wind_dir_bad_values = badWindDir;
  report.weather_wind_dir_parity_pass = badWindDir.length === 0;

  // --- 3. Closing odds coverage ---
  const { rows: oddsRows } = await db.query(
    `SELECT
       EXTRACT(YEAR FROM g.game_date)::int AS season,
       sb.key AS sportsbook,
       COUNT(DISTINCT o.game_id) AS games_covered,
       COUNT(DISTINCT g.id) AS total_final_games
     FROM games g
     LEFT JOIN odds o ON o.game_id = g.id
       AND o.market = 'moneyline'
       AND o.closing_snapshot = true
       AND o.source = 'odds_api_historical'
     JOIN sportsbooks sb ON sb.id = o.sportsbook_id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     GROUP BY 1, 2 ORDER BY 1, 2`
  );

  // Also get total final games per season for denominator
  const { rows: finalGamesPerSeason } = await db.query(
    `SELECT EXTRACT(YEAR FROM game_date)::int AS season, COUNT(*) AS final_games
     FROM games WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024 AND status = 'final'
     GROUP BY 1 ORDER BY 1`
  );
  const finalByYear = Object.fromEntries(finalGamesPerSeason.map(r => [r.season, r.final_games]));

  report.odds_closing_coverage = oddsRows.map(r => ({
    ...r,
    total_final_games: finalByYear[r.season] ?? 0,
    coverage_pct: +(parseInt(r.games_covered, 10) / Math.max(finalByYear[r.season] ?? 1, 1) * 100).toFixed(1),
  }));

  // Games with BOTH DK and FD closing lines
  const { rows: bothBooks } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            COUNT(DISTINCT o.game_id) AS games_with_both_dk_fd
     FROM odds o
     JOIN games g ON g.id = o.game_id
     WHERE o.market = 'moneyline'
       AND o.closing_snapshot = true
       AND o.source = 'odds_api_historical'
       AND EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
     GROUP BY o.game_id, 1
     HAVING COUNT(DISTINCT o.sportsbook_id) = 2`
  );
  // Recount by season
  const { rows: bothBooksCount } = await db.query(
    `WITH per_game AS (
       SELECT g.id, EXTRACT(YEAR FROM g.game_date)::int AS season
       FROM odds o
       JOIN games g ON g.id = o.game_id
       WHERE o.market = 'moneyline'
         AND o.closing_snapshot = true
         AND o.source = 'odds_api_historical'
         AND EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       GROUP BY g.id, 2
       HAVING COUNT(DISTINCT o.sportsbook_id) = 2
     )
     SELECT season, COUNT(*) AS games_with_both FROM per_game GROUP BY 1 ORDER BY 1`
  );
  report.odds_both_books_coverage = bothBooksCount;

  // --- 4. Lineup coverage ---
  const { rows: lineupRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            COUNT(DISTINCT g.id) AS final_games,
            COUNT(DISTINCT le.game_id) AS games_with_full_lineup,
            ROUND(100.0 * COUNT(DISTINCT le.game_id) / NULLIF(COUNT(DISTINCT g.id), 0), 1) AS coverage_pct
     FROM games g
     LEFT JOIN (
       SELECT game_id FROM lineup_entries GROUP BY game_id HAVING COUNT(*) >= 18
     ) le ON le.game_id = g.id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     GROUP BY 1 ORDER BY 1`
  );
  report.lineup_coverage = lineupRows;
  const { rows: totalLineupRows } = await db.query(
    `SELECT COUNT(*) AS n FROM lineup_entries le
     JOIN games g ON g.id = le.game_id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024`
  );
  report.lineup_total_rows = parseInt(totalLineupRows[0].n, 10);
  report.lineup_expected_rows_approx = 131220;

  // --- 5. Park factors ---
  const { rows: parkRows } = await db.query(
    'SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE is_dome) AS domes, COUNT(*) FILTER (WHERE outfield_bearing_deg IS NOT NULL) AS has_bearing FROM park_factor_runs'
  );
  report.park_factor_runs = {
    total_rows: parseInt(parkRows[0].n, 10),
    expected_rows: 30,
    dome_venues: parseInt(parkRows[0].domes, 10),
    venues_with_bearing: parseInt(parkRows[0].has_bearing, 10),
  };

  // --- 6. game_wind_features view sanity ---
  const { rows: windViewRows } = await db.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE weather_wind_out_mph IS NOT NULL) AS wind_out_computable,
       COUNT(*) FILTER (WHERE is_dome = true) AS dome_games,
       COUNT(*) FILTER (WHERE weather_wind_out_mph = 0 AND is_dome = false) AS outdoor_zero_wind
     FROM game_wind_features gwf
     JOIN games g ON g.id = gwf.game_id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024`
  );
  report.game_wind_features_view = windViewRows[0];

  // --- 7. Summary ---
  const wallMs = Date.now() - startTs;
  report.wall_time_ms = wallMs;
  report.credits_consumed = 0; // raw files already fetched; 0 credits this run
  report.credits_consumed_total_backfill = 'see data/historical-odds fetch logs';

  // Gaps summary
  const { rows: gapRows } = await db.query(
    `SELECT COUNT(DISTINCT g.id) AS games_missing_closing_odds
     FROM games g
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
       AND NOT EXISTS (
         SELECT 1 FROM odds o
         WHERE o.game_id = g.id
           AND o.closing_snapshot = true
           AND o.source = 'odds_api_historical'
       )`
  );
  report.gaps = {
    final_games_missing_closing_odds: parseInt(gapRows[0].games_missing_closing_odds, 10),
    expected: 'some 2022 early-season games may be missing (archive starts 2022-09-18)',
  };

  // Write to docs/audits/
  const auditDir = join(REPO_ROOT, 'docs', 'audits');
  mkdirSync(auditDir, { recursive: true });
  const outPath = join(auditDir, 'moneyline-v0-backfill-results-2026-04-30.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  log('info', 'verify_complete', { output: outPath, wall_ms: wallMs });

  console.log('\n=== BACKFILL VERIFICATION REPORT ===');
  console.log(`Output: ${outPath}`);
  console.log(`\nGames in DB (2022-2024): ${report.total_games} (expected ~${report.expected_games_approx})`);
  console.log(`Coverage: ${report.games_coverage_pct}%`);
  console.log('\nWeather coverage:');
  for (const r of weatherRows) {
    const pct = +(parseInt(r.has_wind_dir, 10) / parseInt(r.total, 10) * 100).toFixed(1);
    console.log(`  ${r.season}: ${r.has_wind_dir}/${r.total} wind_dir populated (${pct}%), bad format: ${r.wind_dir_bad_format}`);
  }
  console.log(`  wind_dir parity (no field-relative strings): ${report.weather_wind_dir_parity_pass ? 'PASS' : 'FAIL'}`);
  console.log('\nOdds closing coverage:');
  for (const r of report.odds_closing_coverage) {
    console.log(`  ${r.season} ${r.sportsbook}: ${r.games_covered}/${r.total_final_games} (${r.coverage_pct}%)`);
  }
  console.log('\nLineup coverage:');
  for (const r of lineupRows) {
    console.log(`  ${r.season}: ${r.games_with_full_lineup}/${r.final_games} (${r.coverage_pct}%)`);
  }
  console.log(`\nPark factors: ${report.park_factor_runs.total_rows}/30 venues`);
  console.log(`Dome venues: ${report.park_factor_runs.dome_venues}`);
  console.log(`Wind view — wind_out computable: ${windViewRows[0].wind_out_computable}/${windViewRows[0].total}`);
  console.log(`\nGap: ${report.gaps.final_games_missing_closing_odds} final games missing closing odds`);

  await db.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
