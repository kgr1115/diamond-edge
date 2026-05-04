// Compact overnight health check. Reports recent cron status + current
// time + any failures. Read-only.
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

const now = new Date().toISOString();
console.log(`Now (UTC): ${now}`);

console.log('\n=== cron_runs (last 24h) ===');
const r1 = await c.query(`
  SELECT job_name, started_at::text AS started,
         CASE WHEN finished_at IS NULL THEN '(running)' ELSE finished_at::text END AS finished,
         status,
         COALESCE(SUBSTRING(error_msg, 1, 60), '') AS error_excerpt
  FROM cron_runs
  WHERE started_at >= NOW() - INTERVAL '24 hours'
  ORDER BY started_at DESC LIMIT 30
`);
console.table(r1.rows);

console.log('\n=== Failures + still-running rows last 7d ===');
const r2 = await c.query(`
  SELECT job_name, started_at::text, status, COALESCE(SUBSTRING(error_msg,1,80),'') AS error_excerpt
  FROM cron_runs
  WHERE started_at >= NOW() - INTERVAL '7 days'
    AND (status != 'success' OR finished_at IS NULL)
  ORDER BY started_at DESC LIMIT 15
`);
console.table(r2.rows);

console.log('\n=== Picks generated since 2026-05-04 00:00 UTC ===');
const r3 = await c.query(`
  SELECT generated_at::date::text AS day, market, visibility,
         COUNT(*)::int AS picks,
         COUNT(*) FILTER (WHERE result='pending')::int AS pending,
         COUNT(*) FILTER (WHERE result='win')::int AS wins,
         COUNT(*) FILTER (WHERE result='loss')::int AS losses
  FROM picks
  WHERE generated_at >= '2026-05-04 00:00:00+00'
  GROUP BY day, market, visibility ORDER BY day DESC, market, visibility
`);
console.table(r3.rows);

await c.end();
