/**
 * Step 5 — Seed park_factor_runs reference table.
 *
 * 30 rows, one per MLB venue. Data sourced from:
 *   - runs_factor: Baseball Reference multi-year park factors (2022-2024 average, normalized to 100)
 *   - outfield_bearing_deg: compass bearing from home plate toward center field (0-359)
 *     sourced from public stadium orientation data (Google Maps, SABR stadium database)
 *   - is_dome: retractable or fixed dome
 *
 * Idempotent: INSERT ... ON CONFLICT (venue_name) DO UPDATE
 *
 * Notes on outfield_bearing_deg:
 *   This is the compass heading from home plate toward center field, used by the
 *   game_wind_features view to compute weather_wind_out_mph:
 *     wind_out = wind_speed * cos(wind_dir_deg - (bearing + 180))
 *   A wind blowing FROM the direction the outfield faces = blowing OUT.
 *   Values are approximate (nearest 5 degrees); feature engineer should document
 *   sensitivity to this parameter.
 */

import { loadEnv, makeDbClient, log } from './shared.mjs';

loadEnv();

// Park factor source: Baseball Reference 3-year normalized (2022-2024), factor 100 = league avg
// Outfield bearing: compass bearing from HP to CF (degrees, 0=N, 90=E, 180=S, 270=W)
// Sources: SABR stadium orientation, Google Maps satellite view measurements
const PARK_FACTORS = [
  // AL East
  { venue_name: 'Yankee Stadium',               runs_factor: 103, outfield_bearing_deg: 300, is_dome: false }, // CF faces NW (~300°)
  { venue_name: 'Fenway Park',                  runs_factor: 100, outfield_bearing_deg: 85,  is_dome: false }, // CF faces E (~85°)
  { venue_name: 'Oriole Park at Camden Yards',  runs_factor: 100, outfield_bearing_deg: 30,  is_dome: false }, // CF faces NNE (~30°)
  { venue_name: 'Tropicana Field',              runs_factor: 97,  outfield_bearing_deg: 0,   is_dome: true  }, // dome
  { venue_name: 'Rogers Centre',                runs_factor: 98,  outfield_bearing_deg: 0,   is_dome: true  }, // dome (retractable)

  // AL Central
  { venue_name: 'Guaranteed Rate Field',        runs_factor: 100, outfield_bearing_deg: 25,  is_dome: false }, // CF faces NNE
  { venue_name: 'Progressive Field',            runs_factor: 96,  outfield_bearing_deg: 10,  is_dome: false }, // CF faces N
  { venue_name: 'Comerica Park',                runs_factor: 93,  outfield_bearing_deg: 25,  is_dome: false }, // CF faces NNE
  { venue_name: 'Target Field',                 runs_factor: 101, outfield_bearing_deg: 350, is_dome: false }, // CF faces N (~350°)
  { venue_name: 'Kauffman Stadium',             runs_factor: 96,  outfield_bearing_deg: 0,   is_dome: false }, // CF faces N

  // AL West
  { venue_name: 'Minute Maid Park',             runs_factor: 106, outfield_bearing_deg: 25,  is_dome: true  }, // retractable
  { venue_name: 'Angel Stadium',                runs_factor: 98,  outfield_bearing_deg: 5,   is_dome: false }, // CF faces N
  { venue_name: 'Oakland Coliseum',             runs_factor: 95,  outfield_bearing_deg: 5,   is_dome: false }, // CF faces N — A's venue 2022-2024
  { venue_name: 'T-Mobile Park',                runs_factor: 96,  outfield_bearing_deg: 30,  is_dome: true  }, // retractable
  { venue_name: 'Globe Life Field',             runs_factor: 100, outfield_bearing_deg: 340, is_dome: true  }, // retractable

  // NL East
  { venue_name: 'Citizens Bank Park',           runs_factor: 104, outfield_bearing_deg: 15,  is_dome: false }, // CF faces NNE
  { venue_name: 'Citi Field',                   runs_factor: 99,  outfield_bearing_deg: 30,  is_dome: false }, // CF faces NNE
  { venue_name: 'Nationals Park',               runs_factor: 101, outfield_bearing_deg: 30,  is_dome: false }, // CF faces NNE
  { venue_name: 'Truist Park',                  runs_factor: 101, outfield_bearing_deg: 35,  is_dome: false }, // CF faces NE
  { venue_name: 'loanDepot park',               runs_factor: 96,  outfield_bearing_deg: 5,   is_dome: true  }, // retractable

  // NL Central
  { venue_name: 'Wrigley Field',                runs_factor: 104, outfield_bearing_deg: 0,   is_dome: false }, // CF faces N
  { venue_name: 'American Family Field',        runs_factor: 103, outfield_bearing_deg: 5,   is_dome: true  }, // retractable
  { venue_name: 'PNC Park',                     runs_factor: 97,  outfield_bearing_deg: 355, is_dome: false }, // CF faces N
  { venue_name: 'Great American Ball Park',     runs_factor: 108, outfield_bearing_deg: 15,  is_dome: false }, // CF faces NNE
  { venue_name: 'Busch Stadium',                runs_factor: 97,  outfield_bearing_deg: 30,  is_dome: false }, // CF faces NNE

  // NL West
  { venue_name: 'Dodger Stadium',               runs_factor: 99,  outfield_bearing_deg: 0,   is_dome: false }, // CF faces N
  { venue_name: 'Oracle Park',                  runs_factor: 92,  outfield_bearing_deg: 100, is_dome: false }, // CF faces E (unique orientation)
  { venue_name: 'Chase Field',                  runs_factor: 109, outfield_bearing_deg: 350, is_dome: true  }, // retractable
  { venue_name: 'Coors Field',                  runs_factor: 119, outfield_bearing_deg: 15,  is_dome: false }, // CF faces NNE
  { venue_name: 'Petco Park',                   runs_factor: 92,  outfield_bearing_deg: 300, is_dome: false }, // CF faces NW
];

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step5_start', { rows: PARK_FACTORS.length });

  const startTs = Date.now();
  let upserted = 0;
  const errors = [];

  for (const row of PARK_FACTORS) {
    try {
      await db.query(
        `INSERT INTO park_factor_runs (venue_name, runs_factor, outfield_bearing_deg, is_dome, season_years, source, updated_at)
         VALUES ($1,$2,$3,$4,'2022-2024','baseball_reference_fangraphs',now())
         ON CONFLICT (venue_name) DO UPDATE SET
           runs_factor = EXCLUDED.runs_factor,
           outfield_bearing_deg = EXCLUDED.outfield_bearing_deg,
           is_dome = EXCLUDED.is_dome,
           season_years = EXCLUDED.season_years,
           source = EXCLUDED.source,
           updated_at = now()`,
        [row.venue_name, row.runs_factor, row.outfield_bearing_deg, row.is_dome]
      );
      upserted++;
    } catch (err) {
      errors.push(`${row.venue_name}: ${err.message}`);
    }
  }

  const wallMs = Date.now() - startTs;

  const { rows: countRow } = await db.query('SELECT COUNT(*) AS n FROM park_factor_runs');
  const { rows: domesRow } = await db.query(
    'SELECT venue_name, runs_factor, outfield_bearing_deg, is_dome FROM park_factor_runs ORDER BY venue_name'
  );

  log('info', 'step5_complete', {
    upserted,
    total_in_table: countRow[0].n,
    wall_ms: wallMs,
    errors,
  });

  console.log('\n=== STEP 5 COMPLETE: Park Factors ===');
  console.log(`Rows upserted: ${upserted}`);
  console.log(`Total in table: ${countRow[0].n}`);
  console.log(`Wall time: ${(wallMs / 1000).toFixed(1)}s`);
  console.log('\nAll rows:');
  console.table(domesRow);

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
