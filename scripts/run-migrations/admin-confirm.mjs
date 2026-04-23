// One-off admin utility: confirm email + grant Elite tier + mark age-verified
// Usage: node admin-confirm.mjs <email>
// Uses SUPABASE_DB_URL from .env (service-role equivalent — bypasses RLS)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const envText = readFileSync(join(repoRoot, '.env'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
    const eq = l.indexOf('=');
    return [l.slice(0, eq).trim(), l.slice(eq + 1).trim()];
  })
);

const email = process.argv[2];
if (!email) {
  console.error('Usage: node admin-confirm.mjs <email>');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const { rows: users } = await client.query(
  `SELECT id, email, email_confirmed_at FROM auth.users WHERE email = $1`,
  [email]
);

if (users.length === 0) {
  console.error(`No auth user with email ${email}`);
  await client.end();
  process.exit(1);
}

const user = users[0];
console.log(`Found user: ${user.email} (id=${user.id})`);
console.log(`  email_confirmed_at (before): ${user.email_confirmed_at ?? 'null'}`);

await client.query('BEGIN');
try {
  // 1. Confirm email (confirmed_at is a generated column in newer Supabase — don't touch)
  if (!user.email_confirmed_at) {
    await client.query(
      `UPDATE auth.users SET email_confirmed_at = NOW() WHERE id = $1`,
      [user.id]
    );
  }

  // 2. Grant Elite tier + mark age-verified
  const { rows: profileRows } = await client.query(
    `UPDATE public.profiles
     SET subscription_tier = 'elite',
         age_verified = true,
         age_verified_at = NOW()
     WHERE id = $1
     RETURNING id, email, subscription_tier, age_verified, age_verified_at`,
    [user.id]
  );

  if (profileRows.length === 0) {
    console.log('  (no profile row found — inserting one)');
    await client.query(
      `INSERT INTO public.profiles (id, email, subscription_tier, age_verified, age_verified_at)
       VALUES ($1, $2, 'elite', true, NOW())`,
      [user.id, user.email]
    );
  }

  await client.query('COMMIT');
  console.log('\n✓ Email confirmed');
  console.log('✓ Profile set to tier=elite, age_verified=true');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('FAILED:', err.message);
  process.exit(1);
}

// Verify
const { rows: after } = await client.query(
  `SELECT u.email, u.email_confirmed_at, p.subscription_tier, p.age_verified, p.age_verified_at
   FROM auth.users u
   LEFT JOIN public.profiles p ON p.id = u.id
   WHERE u.id = $1`,
  [user.id]
);
console.log('\nFinal state:');
console.log(after[0]);

await client.end();
