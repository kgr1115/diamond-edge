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
  SELECT job_name, status, started_at::text AS started, finished_at::text AS finished
  FROM cron_runs
  WHERE job_name LIKE '%backfill%' OR job_name LIKE 'backfill_%' OR job_name LIKE '%batter%' OR job_name LIKE '%game_log%'
  ORDER BY started_at DESC
  LIMIT 30
`);
console.table(r.rows);
await c.end();
