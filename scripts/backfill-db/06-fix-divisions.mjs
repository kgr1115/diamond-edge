/**
 * Step 6 — Fix team divisions and leagues from MLB Stats API.
 *
 * All 30 teams were seeded with division='Unknown', league='AL' as stubs.
 * This script fetches current team metadata from MLB Stats API and corrects them.
 * After correction, divisional_flag can be accurately backfilled on games rows.
 *
 * Idempotent: upserts on mlb_team_id.
 */

import { loadEnv, makeDbClient, sleep, log, mlbFetch } from './shared.mjs';

loadEnv();

const MLB_API = process.env.MLB_STATS_API_BASE ?? 'https://statsapi.mlb.com/api/v1';

// Division name normalization (MLB API returns e.g. "American League East")
function shortDivision(name) {
  if (!name) return 'Unknown';
  const map = {
    'American League East': 'AL East',
    'American League Central': 'AL Central',
    'American League West': 'AL West',
    'National League East': 'NL East',
    'National League Central': 'NL Central',
    'National League West': 'NL West',
  };
  return map[name] ?? name;
}

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step6_start');

  const startTs = Date.now();

  // Fetch all MLB teams (active + historical for 2022-2024 window)
  let teamsResp;
  try {
    teamsResp = await mlbFetch(`${MLB_API}/teams?sportId=1&activeStatus=Y`);
  } catch (err) {
    console.error(`[FATAL] Teams fetch failed: ${err.message}`);
    await db.end();
    process.exit(1);
  }

  const teams = teamsResp.teams ?? [];
  log('info', 'step6_teams_fetched', { count: teams.length });

  let updated = 0;
  const errors = [];

  for (const team of teams) {
    const division = shortDivision(team.division?.name);
    const league = team.league?.abbreviation === 'NL' ? 'NL' : 'AL';
    const city = team.locationName ?? '';
    const name = team.name ?? '';
    const abbr = (team.abbreviation ?? '').toUpperCase().slice(0, 3);

    try {
      await db.query(
        `UPDATE teams
         SET division = $1, league = $2, name = $3, abbreviation = $4, city = $5, updated_at = now()
         WHERE mlb_team_id = $6`,
        [division, league, name, abbr, city, team.id]
      );
      updated++;
    } catch (err) {
      errors.push(`Team ${team.id} (${name}): ${err.message}`);
    }
  }

  // Backfill divisional_flag now that divisions are correct
  const { rowCount: flagsUpdated } = await db.query(`
    UPDATE games g
    SET divisional_flag = true
    FROM teams ht, teams at
    WHERE ht.id = g.home_team_id
      AND at.id = g.away_team_id
      AND ht.division = at.division
      AND ht.division != 'Unknown'
  `);

  // Verify
  const { rows: divRows } = await db.query(
    `SELECT division, league, COUNT(*) AS n FROM teams GROUP BY division, league ORDER BY league, division`
  );

  const wallMs = Date.now() - startTs;

  log('info', 'step6_complete', {
    teams_updated: updated,
    divisional_flags_set: flagsUpdated,
    divisions: divRows,
    wall_ms: wallMs,
    errors,
  });

  console.log('\n=== STEP 6 COMPLETE: Team Divisions ===');
  console.log(`Teams updated: ${updated}`);
  console.log(`Divisional flags set: ${flagsUpdated}`);
  console.log('\nDivision distribution:');
  console.table(divRows);

  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length}):`);
    errors.forEach(e => console.error(`  ${e}`));
    process.exitCode = 1;
  }

  await db.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
