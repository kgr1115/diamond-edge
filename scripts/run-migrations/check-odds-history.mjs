import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const e = l.indexOf('=');
      return [l.slice(0, e).trim(), l.slice(e + 1).trim()];
    }),
);
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// Show full snapshot history for PHI@ATL (the most damning game)
const r = await c.query(`
  SELECT to_char(o.snapshotted_at AT TIME ZONE 'America/New_York', 'MM-DD HH24:MI ET') AS t,
         g.game_time_utc,
         sb.key AS book,
         o.market,
         o.home_price, o.away_price, o.over_price, o.under_price,
         o.total_line, o.run_line_spread
  FROM odds o
  JOIN games g ON g.id = o.game_id
  JOIN sportsbooks sb ON sb.id = o.sportsbook_id
  JOIN teams ht ON ht.id = g.home_team_id
  JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date = $1 AND ht.abbreviation = 'ATL' AND at.abbreviation = 'PHI'
  ORDER BY o.snapshotted_at, sb.key, o.market
`, ['2026-04-26']);

console.log(`PHI @ ATL — full snapshot history (game_time_utc=${r.rows[0]?.game_time_utc}):`);
for (const row of r.rows) {
  if (row.market === 'moneyline') {
    console.log(`${row.t}  ${row.book.padEnd(11)} ML  away ${row.away_price}  home ${row.home_price}`);
  } else if (row.market === 'run_line') {
    console.log(`${row.t}  ${row.book.padEnd(11)} RL  spread ${row.run_line_spread}  away ${row.away_price}  home ${row.home_price}`);
  } else {
    console.log(`${row.t}  ${row.book.padEnd(11)} OU  total ${row.total_line}  over ${row.over_price}  under ${row.under_price}`);
  }
}
await c.end();
