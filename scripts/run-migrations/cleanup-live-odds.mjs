/**
 * Cleanup script: delete `odds` rows that were snapshotted more than 15 minutes
 * after their game's first pitch. These are live in-game odds the previous
 * `runOddsPoll` ingested by accident; they corrupt any "latest snapshot"
 * lookup downstream.
 *
 * DEFAULT IS DRY-RUN. Pass `--apply` to actually delete.
 *
 *   node scripts/run-migrations/cleanup-live-odds.mjs            # counts only
 *   node scripts/run-migrations/cleanup-live-odds.mjs --apply    # deletes
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const e = l.indexOf('=');
      return [l.slice(0, e).trim(), l.slice(e + 1).trim()];
    }),
);
const apply = process.argv.includes('--apply');
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const PREDICATE = `o.snapshotted_at > g.game_time_utc + interval '15 minutes'`;

// 1. Total scope
const totalRow = (await c.query(`
  SELECT COUNT(*)::int AS n,
         MIN(o.snapshotted_at) AS earliest,
         MAX(o.snapshotted_at) AS latest
  FROM odds o
  JOIN games g ON g.id = o.game_id
  WHERE g.game_time_utc IS NOT NULL AND ${PREDICATE}
`)).rows[0];
console.log(`Live-odds rows in DB: ${totalRow.n}`);
console.log(`  earliest: ${totalRow.earliest?.toISOString?.() ?? totalRow.earliest}`);
console.log(`  latest:   ${totalRow.latest?.toISOString?.() ?? totalRow.latest}`);

// 2. Per-day breakdown for context
const perDay = await c.query(`
  SELECT g.game_date::text AS d, COUNT(*)::int AS n
  FROM odds o
  JOIN games g ON g.id = o.game_id
  WHERE g.game_time_utc IS NOT NULL AND ${PREDICATE}
  GROUP BY g.game_date
  ORDER BY g.game_date DESC
  LIMIT 30
`);
console.log(`\nPer-day breakdown (newest 30):`);
for (const r of perDay.rows) console.log(`  ${r.d}  ${r.n}`);

// 3. Sample 5 affected rows so Kyle can sanity-check before applying
const sample = await c.query(`
  SELECT to_char(o.snapshotted_at AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI ET') AS snap_et,
         to_char(g.game_time_utc AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI ET') AS first_pitch_et,
         at.abbreviation AS away, ht.abbreviation AS home,
         sb.key AS book, o.market,
         o.home_price, o.away_price, o.over_price, o.under_price,
         o.total_line, o.run_line_spread
  FROM odds o
  JOIN games g ON g.id = o.game_id
  JOIN sportsbooks sb ON sb.id = o.sportsbook_id
  LEFT JOIN teams ht ON ht.id = g.home_team_id
  LEFT JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_time_utc IS NOT NULL AND ${PREDICATE}
  ORDER BY ABS(o.home_price) DESC NULLS LAST
  LIMIT 5
`);
console.log(`\nSample of most-extreme affected rows:`);
for (const r of sample.rows) {
  if (r.market === 'moneyline') {
    console.log(`  ${r.away}@${r.home} ${r.book} ML  away ${r.away_price}  home ${r.home_price}  snap=${r.snap_et}  first_pitch=${r.first_pitch_et}`);
  } else if (r.market === 'run_line') {
    console.log(`  ${r.away}@${r.home} ${r.book} RL  spread ${r.run_line_spread}  away ${r.away_price}  home ${r.home_price}  snap=${r.snap_et}  first_pitch=${r.first_pitch_et}`);
  } else {
    console.log(`  ${r.away}@${r.home} ${r.book} OU  total ${r.total_line}  over ${r.over_price}  under ${r.under_price}  snap=${r.snap_et}  first_pitch=${r.first_pitch_et}`);
  }
}

if (!apply) {
  console.log(`\nDRY-RUN. Re-run with --apply to delete ${totalRow.n} rows.`);
  await c.end();
  process.exit(0);
}

console.log(`\nApplying delete...`);
const del = await c.query(`
  DELETE FROM odds
  WHERE id IN (
    SELECT o.id
    FROM odds o
    JOIN games g ON g.id = o.game_id
    WHERE g.game_time_utc IS NOT NULL AND ${PREDICATE}
  )
`);
console.log(`Deleted ${del.rowCount} rows.`);

await c.end();
