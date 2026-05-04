// What date range is the batter backfill ACTUALLY processing?
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);

const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const r = await c.query(`
  SELECT EXTRACT(YEAR FROM g.game_date)::int yr,
         EXTRACT(MONTH FROM g.game_date)::int mo,
         COUNT(DISTINCT bgl.game_id)::int games
  FROM games g JOIN batter_game_log bgl ON bgl.game_id = g.id
  GROUP BY yr, mo ORDER BY yr, mo
`);
console.table(r.rows);

const r2 = await c.query(`SELECT MIN(g.game_date)::text mn, MAX(g.game_date)::text mx FROM games g JOIN batter_game_log bgl ON bgl.game_id = g.id`);
console.log('range:', r2.rows[0]);

await c.end();
