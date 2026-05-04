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
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const r = await c.query(`
  SELECT g.id, g.game_time_utc, ht.abbreviation AS home, at.abbreviation AS away
  FROM games g
  LEFT JOIN teams ht ON ht.id = g.home_team_id
  LEFT JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date = $1
  ORDER BY g.game_time_utc, ht.abbreviation
`, ['2026-04-26']);

console.log(`Games today (${r.rows.length}):`);
for (const g of r.rows) {
  console.log(`${g.game_time_utc?.toISOString()} ${g.away}@${g.home} id=${g.id.slice(0, 8)}`);
}

// Check duplicates by (home, away, date)
const dupes = await c.query(`
  SELECT home_team_id, away_team_id, game_date, COUNT(*)::int AS n
  FROM games
  WHERE game_date = $1
  GROUP BY home_team_id, away_team_id, game_date
  HAVING COUNT(*) > 1
`, ['2026-04-26']);
console.log(`\nDuplicate (home, away, date) groups today: ${dupes.rows.length}`);
for (const d of dupes.rows) console.log(d);

await c.end();
