import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log('=== pick-pipeline cron_runs (latest 6) ===');
const r = await c.query(`
  SELECT job_name, started_at::text, finished_at::text, status, error_msg
  FROM cron_runs WHERE job_name = 'pick-pipeline'
  ORDER BY started_at DESC LIMIT 6
`);
console.table(r.rows);

console.log('\n=== picks generated today ===');
const r2 = await c.query(`
  SELECT id, market, pick_side, confidence_tier, expected_value, model_probability, generated_at::text
  FROM picks WHERE generated_at::date = CURRENT_DATE
  ORDER BY generated_at DESC LIMIT 20
`);
console.table(r2.rows);

console.log('\n=== games table game_date column? + status distribution ===');
const r3 = await c.query(`
  SELECT status, COUNT(*) AS n
  FROM games
  WHERE game_time_utc >= NOW() AND game_time_utc <= NOW() + INTERVAL '24 hours'
  GROUP BY status
`);
console.table(r3.rows);

await c.end();
