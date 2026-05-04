// Drill into outcome-grader: latest runs across all time + check
// pick_outcomes write history to see if grader ran but didn't log.
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

console.log('=== outcome-grader: ALL cron_runs entries (any time) ===');
const r = await c.query(`
  SELECT started_at::text, finished_at::text, status,
         COALESCE(SUBSTRING(error_msg,1,80),'') AS error_excerpt
  FROM cron_runs WHERE job_name = 'outcome-grader'
  ORDER BY started_at DESC LIMIT 10
`);
console.table(r.rows);

console.log('\n=== pick_outcomes: most recent grading writes ===');
const r2 = await c.query(`
  SELECT graded_at::text, COUNT(*) AS n
  FROM pick_outcomes
  GROUP BY graded_at::text
  ORDER BY graded_at::text DESC LIMIT 10
`);
console.table(r2.rows);

console.log('\n=== Games eligible for grading today (final, ungraded) ===');
const r3 = await c.query(`
  SELECT g.id, g.game_time_utc::text, g.status,
         (SELECT COUNT(*) FROM picks WHERE picks.game_id = g.id AND picks.result = 'pending')::int AS pending_picks
  FROM games g
  WHERE g.status = 'final' AND g.game_time_utc >= NOW() - INTERVAL '7 days'
    AND EXISTS (SELECT 1 FROM picks WHERE picks.game_id = g.id AND picks.result = 'pending')
  ORDER BY g.game_time_utc DESC LIMIT 10
`);
console.table(r3.rows);

await c.end();
