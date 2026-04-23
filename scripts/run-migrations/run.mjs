import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');

// Load .env from repo root
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

const dbUrl = env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error('SUPABASE_DB_URL not set in .env');
  process.exit(1);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

console.log(`Found ${files.length} migration files:`);
for (const f of files) console.log(`  - ${f}`);

// Use SSL for Supabase; rejectUnauthorized false is fine for managed Supabase (their CA).
const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('\nConnecting...');
  await client.connect();
  console.log('Connected.\n');

  // Create a simple migration tracking table if it doesn't exist.
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._diamond_edge_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: already } = await client.query(
    'SELECT filename FROM public._diamond_edge_migrations'
  );
  const appliedSet = new Set(already.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`SKIP ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    console.log(`APPLY ${file} (${sql.length} bytes)`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO public._diamond_edge_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`  OK`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAILED: ${err.message}`);
      console.error(err);
      process.exit(1);
    }
  }

  // Verify: list tables
  const { rows: tables } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  console.log(`\nTables in public schema (${tables.length}):`);
  for (const t of tables) console.log(`  - ${t.table_name}`);

  await client.end();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
