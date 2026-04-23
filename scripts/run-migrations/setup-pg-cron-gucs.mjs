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

const vercelUrl = 'https://diamond-edge.co';
const supabaseUrl = env.SUPABASE_URL;
const cronSecret = env.CRON_SECRET;
const anonKey = env.SUPABASE_ANON_KEY;

// Try ALTER DATABASE syntax
console.log('Trying ALTER DATABASE approach...');
const sqls = [
  `ALTER DATABASE postgres SET app.vercel_url TO '${vercelUrl}'`,
  `ALTER DATABASE postgres SET app.supabase_url TO '${supabaseUrl}'`,
  `ALTER DATABASE postgres SET app.cron_secret TO '${cronSecret}'`,
  `ALTER DATABASE postgres SET app.supabase_anon_key TO '${anonKey}'`,
];

let success = 0;
for (const sql of sqls) {
  try {
    await client.query(sql);
    const key = sql.match(/SET (app\.\w+)/)[1];
    console.log(`✓ ${key} set via ALTER DATABASE`);
    success++;
  } catch (err) {
    console.error(`✗ ${err.message}`);
  }
}

if (success === 0) {
  console.log('\n⚠ ALTER DATABASE also denied. Falling back to Supabase Vault for secrets, embedded for non-secret URLs.');

  // Supabase provides a `vault` schema for secrets. Check if it exists.
  try {
    const v = await client.query(`SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='vault'`);
    const hasVault = v.rows[0].count !== '0';
    console.log(`Supabase Vault schema present: ${hasVault}`);

    if (hasVault) {
      // Vault approach: store secrets, reference via vault.decrypted_secrets view
      console.log('Storing cron_secret and anon_key in Supabase Vault...');
      await client.query(`INSERT INTO vault.secrets (name, secret) VALUES ('cron_secret', $1) ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret`, [cronSecret]);
      await client.query(`INSERT INTO vault.secrets (name, secret) VALUES ('supabase_anon_key', $1) ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret`, [anonKey]);
      console.log('✓ Secrets stored in vault');
    }
  } catch (err) {
    console.log(`Vault check failed: ${err.message}`);
  }
}

await client.end();
