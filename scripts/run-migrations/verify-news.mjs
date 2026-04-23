import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const envText = readFileSync(join(repoRoot, '.env'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
    const e = l.indexOf('=');
    return [l.slice(0, e).trim(), l.slice(e + 1).trim()];
  })
);

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const rls = await client.query(`SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('news_events','news_signals','market_priors') ORDER BY tablename`);
console.log('RLS on new tables:');
console.table(rls.rows);

const counts = await client.query(`
  SELECT 'news_events' AS t, count(*)::int FROM news_events
  UNION ALL SELECT 'news_signals', count(*)::int FROM news_signals
  UNION ALL SELECT 'market_priors', count(*)::int FROM market_priors
`);
console.log('\nRow counts:');
console.table(counts.rows);

await client.end();
