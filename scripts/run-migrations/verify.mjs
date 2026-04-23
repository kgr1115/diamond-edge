import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const envText = readFileSync(join(repoRoot, '.env'), 'utf8');
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim()];
    })
);

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const checks = [
  ['sportsbooks', 'SELECT key, name FROM sportsbooks ORDER BY key'],
  ['geo_blocked_states (sample)', 'SELECT state_code, reason FROM geo_blocked_states ORDER BY state_code LIMIT 5'],
  ['geo_blocked_states (count)', 'SELECT COUNT(*)::int AS n FROM geo_blocked_states'],
  ['RLS on profiles', `SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('profiles','picks','subscriptions','bankroll_entries')`],
];

for (const [label, q] of checks) {
  console.log(`\n== ${label} ==`);
  const { rows } = await client.query(q);
  console.log(rows);
}

await client.end();
