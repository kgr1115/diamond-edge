// Pick a representative all-night-game date in the 2022-09 → 2024 window for the snap probe.
// We want a date where most games are night starts (after 22:00 UTC = 6pm ET) so the
// API behavior we test is the night-game case where the bug manifests.
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

// Target: a Tuesday or Wednesday in mid-summer 2024 with 10-15 finals all starting after 23:00 UTC
const r = await c.query(`
  SELECT g.game_date::text AS d,
         COUNT(*)::int AS n_games,
         COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM g.game_time_utc) >= 23
                            OR EXTRACT(HOUR FROM g.game_time_utc) < 4)::int AS n_night,
         to_char(MIN(g.game_time_utc), 'HH24:MI') AS earliest_utc,
         to_char(MAX(g.game_time_utc), 'HH24:MI') AS latest_utc
  FROM games g
  WHERE g.game_date >= '2024-06-01' AND g.game_date <= '2024-08-15'
    AND g.status = 'final'
  GROUP BY g.game_date
  HAVING COUNT(*) >= 10
     AND COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM g.game_time_utc) >= 22
                            OR EXTRACT(HOUR FROM g.game_time_utc) < 4)::float / COUNT(*) >= 0.70
  ORDER BY n_night DESC, n_games DESC
  LIMIT 15
`);

console.log('Candidate night-heavy slate dates (2024, mid-summer):');
console.table(r.rows);

await c.end();
