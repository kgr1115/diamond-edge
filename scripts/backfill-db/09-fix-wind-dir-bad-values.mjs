/**
 * Step 9 — Fix 18 bad weather_wind_dir rows (Task B).
 *
 * Problem: 18 games.weather_wind_dir values contain field-relative MLB strings
 *   ('In From CF', 'Out To LF', 'In From RF', 'Out To CF', 'Out To LF', 'Out To RF')
 *   written by a prior ingester that has since been replaced. These strings are
 *   non-numeric and cause game_wind_features view to fall back to 0.0, but they
 *   also cause the parity check query to fail.
 *
 * Fix chosen: NULL them out (option b from task brief).
 *   Rationale: Re-fetching Open-Meteo for 18 specific game_ids requires building
 *   a targeted call with venue coordinates and game dates — >30 min of work.
 *   The feature spec states: feature 12 (weather_wind_out_mph) "imputes 0.0 when
 *   wind_dir is unparseable, so a NULL is functionally equivalent." The
 *   game_wind_features view already returns 0.0 for NULL weather_wind_dir.
 *   Zero API calls, zero cost, auditable.
 *
 * The parity query that verifies correctness:
 *   SELECT weather_wind_dir, COUNT(*) FROM games
 *   WHERE weather_wind_dir ILIKE '%CF%' OR weather_wind_dir ILIKE '%LF%'
 *      OR weather_wind_dir ILIKE '%RF%'
 *      OR weather_wind_dir IN ('N','NE','E','SE','S','SW','W','NW')
 *   GROUP BY 1;
 *   -- Expected: zero rows
 */

import { loadEnv, makeDbClient, log } from './shared.mjs';

loadEnv();

const BAD_PATTERNS_SQL = `
  weather_wind_dir ILIKE '%CF%'
  OR weather_wind_dir ILIKE '%LF%'
  OR weather_wind_dir ILIKE '%RF%'
  OR weather_wind_dir IN ('N','NE','E','SE','S','SW','W','NW')
`;

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step9_start', { task: 'fix_bad_wind_dir' });

  // Audit: count affected rows before patch
  const { rows: before } = await db.query(
    `SELECT weather_wind_dir, COUNT(*) AS n
     FROM games
     WHERE ${BAD_PATTERNS_SQL}
     GROUP BY 1 ORDER BY 1`
  );

  if (before.length === 0) {
    log('info', 'step9_no_bad_rows', { msg: 'No bad wind_dir values found. Already clean.' });
    console.log('=== STEP 9: No bad wind_dir rows found — already clean. ===');
    await db.end();
    return;
  }

  log('info', 'step9_bad_rows_found', {
    count: before.reduce((s, r) => s + parseInt(r.n, 10), 0),
    breakdown: before,
  });
  console.log('Bad wind_dir values found:');
  for (const r of before) {
    console.log(`  "${r.weather_wind_dir}": ${r.n} rows`);
  }

  // Patch: NULL out the bad values
  const { rowCount } = await db.query(
    `UPDATE games
     SET weather_wind_dir = NULL,
         updated_at       = now()
     WHERE ${BAD_PATTERNS_SQL}`
  );

  log('info', 'step9_patched', { rows_nulled: rowCount });

  // Verify: parity check — expected zero rows
  const { rows: after } = await db.query(
    `SELECT weather_wind_dir, COUNT(*) AS n
     FROM games
     WHERE ${BAD_PATTERNS_SQL}
     GROUP BY 1`
  );

  if (after.length === 0) {
    log('info', 'step9_parity_pass', { result: 'zero_bad_rows' });
    console.log(`\n=== STEP 9 COMPLETE: Fixed ${rowCount} bad wind_dir rows. Parity check: PASS ===`);
    console.log('wind_dir_parity_pass: true');
  } else {
    log('error', 'step9_parity_fail', { remaining: after });
    console.error(`\n=== STEP 9 PARTIAL: Parity check FAIL — ${after.length} bad patterns remain ===`);
    for (const r of after) console.error(`  "${r.weather_wind_dir}": ${r.n}`);
    process.exitCode = 1;
  }

  await db.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
