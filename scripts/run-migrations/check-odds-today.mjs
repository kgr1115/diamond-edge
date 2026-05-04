import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const env = Object.fromEntries(
  readFileSync(join(repoRoot, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const e = l.indexOf('=');
      return [l.slice(0, e).trim(), l.slice(e + 1).trim()];
    }),
);
const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
console.log(`Today (ET): ${todayET}`);
console.log(`Now (UTC):  ${new Date().toISOString()}\n`);

// Most recent snapshot in odds table for today's games
const recent = await client.query(`
  SELECT MAX(o.snapshotted_at) AS last_snap,
         MIN(o.snapshotted_at) AS first_snap_today,
         COUNT(*)::int AS rows
  FROM odds o
  JOIN games g ON g.id = o.game_id
  WHERE g.game_date = $1
`, [todayET]);
console.log('Snapshot freshness (today):');
console.table(recent.rows);

// Newest snapshot per (game, book, market) for today
const latest = await client.query(`
  WITH latest AS (
    SELECT DISTINCT ON (o.game_id, o.sportsbook_id, o.market)
      o.game_id, o.sportsbook_id, o.market,
      o.home_price, o.away_price, o.over_price, o.under_price,
      o.total_line, o.run_line_spread, o.snapshotted_at
    FROM odds o
    JOIN games g ON g.id = o.game_id
    WHERE g.game_date = $1
    ORDER BY o.game_id, o.sportsbook_id, o.market, o.snapshotted_at DESC
  )
  SELECT at.abbreviation AS away,
         ht.abbreviation AS home,
         sb.key AS book,
         l.market,
         l.home_price, l.away_price,
         l.over_price, l.under_price, l.total_line,
         l.run_line_spread,
         to_char(l.snapshotted_at AT TIME ZONE 'America/New_York', 'HH24:MI ET') AS snap_et
  FROM latest l
  JOIN games g ON g.id = l.game_id
  JOIN sportsbooks sb ON sb.id = l.sportsbook_id
  LEFT JOIN teams ht ON ht.id = g.home_team_id
  LEFT JOIN teams at ON at.id = g.away_team_id
  ORDER BY g.game_time_utc, away, book, l.market
`, [todayET]);

console.log(`\nLatest odds per (game, book, market) — ${latest.rows.length} rows:`);
for (const r of latest.rows) {
  if (r.market === 'moneyline') {
    console.log(`${r.away}@${r.home} ${r.book.padEnd(11)} ML  away ${r.away_price ?? '—'}  home ${r.home_price ?? '—'}  [${r.snap_et}]`);
  } else if (r.market === 'run_line') {
    console.log(`${r.away}@${r.home} ${r.book.padEnd(11)} RL  spread ${r.run_line_spread}  away ${r.away_price ?? '—'}  home ${r.home_price ?? '—'}  [${r.snap_et}]`);
  } else if (r.market === 'total') {
    console.log(`${r.away}@${r.home} ${r.book.padEnd(11)} OU  total ${r.total_line}  over ${r.over_price ?? '—'}  under ${r.under_price ?? '—'}  [${r.snap_et}]`);
  }
}

// What's pinned to today's picks
const pinned = await client.query(`
  SELECT p.id::text AS pick_id,
         p.market, p.pick_side, p.best_line_price,
         sb.key AS book,
         at.abbreviation AS away, ht.abbreviation AS home,
         to_char(p.generated_at AT TIME ZONE 'America/New_York', 'HH24:MI ET') AS gen_et
  FROM picks p
  JOIN games g ON g.id = p.game_id
  LEFT JOIN sportsbooks sb ON sb.id = p.best_line_book_id
  LEFT JOIN teams ht ON ht.id = g.home_team_id
  LEFT JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date = $1 AND p.visibility = 'live'
  ORDER BY g.game_time_utc, p.market
`, [todayET]);
console.log(`\nTODAY'S PICKS (${pinned.rows.length}):`);
for (const p of pinned.rows) {
  console.log(`${p.away}@${p.home} ${p.market} ${p.pick_side} @ ${p.best_line_price} (${p.book ?? '—'})  gen=${p.gen_et}`);
}

await client.end();
