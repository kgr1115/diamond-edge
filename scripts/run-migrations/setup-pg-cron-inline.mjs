/**
 * Rewrite the pg_cron job SQL bodies to use inline URLs/secrets instead of
 * current_setting('app.*'). Supabase Free tier blocks custom GUCs via
 * ALTER DATABASE/ROLE — values must be embedded.
 *
 * Secrets live in .env (gitignored); we UPDATE cron.job bodies at runtime
 * from this script. Kyle runs this ONCE after first deploy; re-running is
 * safe (idempotent UPDATE).
 */
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

const VERCEL_URL = 'https://diamond-edge.co';
const SUPABASE_URL = env.SUPABASE_URL;
const CRON_SECRET = env.CRON_SECRET;
const ANON_KEY = env.SUPABASE_ANON_KEY;

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

// Build the new command bodies with hardcoded values.
const jobs = [
  {
    name: 'bluesky-poll',
    schedule: '*/5 * * * *',
    command: `
      SELECT net.http_post(
        url := '${VERCEL_URL}/api/cron/news-poll',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ${CRON_SECRET}'
        ),
        body := '{"source":"bluesky"}'::jsonb
      ) AS request_id;
    `,
  },
  {
    name: 'news-extraction-sweep',
    schedule: '*/15 * * * *',
    command: `
      SELECT net.http_post(
        url := '${SUPABASE_URL}/functions/v1/late-news-pipeline',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ${ANON_KEY}'
        ),
        body := '{}'::jsonb
      ) AS request_id;
    `,
  },
  {
    name: 'outcome-grader',
    schedule: '0 8 * * *',
    command: `
      SELECT net.http_post(
        url := '${VERCEL_URL}/api/cron/outcome-grader',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ${CRON_SECRET}'
        ),
        body := '{}'::jsonb
      ) AS request_id;
    `,
  },
  {
    // Runs 1 hour after outcome-grader — by then picks have outcomes + closing
    // line snapshots exist, so CLV can be computed per pick.
    name: 'clv-compute',
    schedule: '0 9 * * *',
    command: `
      SELECT net.http_post(
        url := '${VERCEL_URL}/api/cron/clv-compute',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ${CRON_SECRET}'
        ),
        body := '{}'::jsonb
      ) AS request_id;
    `,
  },
  {
    // Daily full stats-sync: pitcher season stats, bullpen, team batting, umpires.
    // 14:30 UTC = 10:30 AM ET — right after schedule-sync pulls today's games.
    name: 'stats-sync-daily',
    schedule: '30 14 * * *',
    command: `
      SELECT net.http_post(
        url := '${VERCEL_URL}/api/cron/stats-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ${CRON_SECRET}'
        ),
        body := '{}'::jsonb
      ) AS request_id;
    `,
  },
  {
    // Lineup refresh every 15 min during game-day evening window (17:00–23:00 UTC = 1–7 PM ET).
    name: 'lineup-sync-15min',
    schedule: '*/15 17-23 * * *',
    command: `
      SELECT net.http_post(
        url := '${VERCEL_URL}/api/cron/stats-sync?stage=lineup',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ${CRON_SECRET}'
        ),
        body := '{}'::jsonb
      ) AS request_id;
    `,
  },
];

console.log('Reschedule cron jobs with inline values...\n');
for (const j of jobs) {
  // cron.schedule is idempotent — if a job with the same name exists, the schedule+command replace it.
  try {
    await client.query(`SELECT cron.schedule($1, $2, $3)`, [j.name, j.schedule, j.command.trim()]);
    console.log(`✓ ${j.name} — ${j.schedule}`);
  } catch (err) {
    console.error(`✗ ${j.name}: ${err.message}`);
  }
}

console.log('\nFinal job state:');
const result = await client.query(`SELECT jobname, schedule, active FROM cron.job ORDER BY jobname`);
console.table(result.rows);

await client.end();
