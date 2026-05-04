// Investigate whether snap timestamps are wall-clock or fetch-time artifacts.
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

// Look at all distinct snap timestamps stored - is it 1 timestamp per fetch batch?
console.log('=== Distinct snapshotted_at values ===');
const r1 = await c.query(`
  SELECT snapshotted_at::text AS snap, COUNT(*)::int AS n
  FROM odds
  WHERE market = 'moneyline'
    AND snapshotted_at >= '2024-08-15' AND snapshotted_at <= '2024-08-17'
  GROUP BY snap
  ORDER BY snap
`);
console.table(r1.rows);

// What the entire table looks like for a single game
console.log('\n=== All odds rows for one specific 2024 game ===');
const r2 = await c.query(`
  SELECT g.id::text AS gid, g.game_time_utc::text AS gstart, sb.key AS book,
         o.home_price, o.away_price, o.snapshotted_at::text AS snap, o.source, o.closing_snapshot
  FROM odds o
  JOIN games g ON g.id = o.game_id
  JOIN sportsbooks sb ON sb.id = o.sportsbook_id
  WHERE g.id = (
    SELECT id FROM games WHERE game_date = '2024-08-15' AND status='final' ORDER BY game_time_utc LIMIT 1 OFFSET 1
  )
    AND o.market = 'moneyline'
  ORDER BY o.snapshotted_at, sb.key
`);
console.table(r2.rows);

// How are snap timestamps distributed? are there only a few discrete ones (suggesting they're fetch-time)?
console.log('\n=== Distinct snap timestamps in 2024 ===');
const r3 = await c.query(`
  SELECT COUNT(DISTINCT snapshotted_at)::int AS distinct_snaps,
         COUNT(*)::int AS total_rows
  FROM odds
  WHERE market = 'moneyline'
    AND snapshotted_at >= '2024-01-01' AND snapshotted_at <= '2024-12-31'
`);
console.table(r3.rows);

// Are there many fetch batches or just one?
console.log('\n=== Sample of 30 distinct snap timestamps in 2024 ===');
const r4 = await c.query(`
  SELECT snapshotted_at::text AS snap, COUNT(*)::int AS rows_at_this_snap
  FROM odds
  WHERE market = 'moneyline'
    AND snapshotted_at >= '2024-01-01' AND snapshotted_at <= '2024-12-31'
  GROUP BY snap ORDER BY snap LIMIT 30
`);
console.table(r4.rows);

await c.end();
