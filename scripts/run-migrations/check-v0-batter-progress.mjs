// Quick progress check on batter_game_log backfill.
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
const r = await c.query(`SELECT COUNT(*)::int n_rows, COUNT(DISTINCT game_id)::int n_games, MAX(updated_at)::text last_write FROM batter_game_log`);
console.log('batter_game_log:', r.rows[0]);

const r2 = await c.query(`
  SELECT EXTRACT(YEAR FROM g.game_date)::int yr, COUNT(DISTINCT bgl.game_id)::int games_with_batters
  FROM games g LEFT JOIN batter_game_log bgl ON bgl.game_id = g.id
  WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31' AND g.status='final'
  GROUP BY yr ORDER BY yr
`);
console.log('coverage by year:'); console.table(r2.rows);

await c.end();
