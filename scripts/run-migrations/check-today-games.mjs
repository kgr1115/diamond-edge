// One-off: inspect today's MLB game schedule + odds + pick state.
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

console.log(`Now (UTC): ${new Date().toISOString()}`);

console.log('\n=== Games scheduled in next 24h ===');
const r1 = await c.query(`
  SELECT id, game_time_utc::text, status,
         home_team_id IS NOT NULL AS has_home_team,
         probable_home_pitcher_id IS NOT NULL AS has_home_p,
         probable_away_pitcher_id IS NOT NULL AS has_away_p,
         venue_name
  FROM games
  WHERE game_time_utc >= NOW()
    AND game_time_utc <= NOW() + INTERVAL '24 hours'
  ORDER BY game_time_utc
`);
console.log(`Count: ${r1.rows.length}`);
console.table(r1.rows.slice(0, 20));

console.log('\n=== Most-recent schedule-sync run ===');
const r2 = await c.query(`
  SELECT job_name, started_at::text, finished_at::text, status, error_msg
  FROM cron_runs
  WHERE job_name = 'schedule-sync'
  ORDER BY started_at DESC LIMIT 5
`);
console.table(r2.rows);

console.log('\n=== Most-recent odds-refresh run ===');
const r3 = await c.query(`
  SELECT job_name, started_at::text, finished_at::text, status
  FROM cron_runs
  WHERE job_name = 'odds-refresh'
  ORDER BY started_at DESC LIMIT 3
`);
console.table(r3.rows);

console.log('\n=== Latest live odds rows ===');
const r4 = await c.query(`
  SELECT g.game_time_utc::text, COUNT(o.id) AS rows, MAX(o.snapshotted_at)::text AS latest
  FROM games g
  LEFT JOIN odds o ON o.game_id = g.id AND o.market='moneyline'
  WHERE g.game_time_utc >= NOW() AND g.game_time_utc <= NOW() + INTERVAL '24 hours'
  GROUP BY g.game_time_utc ORDER BY g.game_time_utc LIMIT 20
`);
console.table(r4.rows);

await c.end();
