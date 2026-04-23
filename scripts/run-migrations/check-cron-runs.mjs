import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const env = Object.fromEntries(
  readFileSync(join(repoRoot, '.env'), 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);
const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const r = await client.query(`SELECT j.jobname, d.start_time, d.status, d.return_message
  FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
  ORDER BY d.start_time DESC LIMIT 15`);
console.log(`Recent cron runs (${r.rows.length} rows):`);
console.table(r.rows.map(x => ({
  job: x.jobname,
  when: String(x.start_time).slice(5, 19),
  status: x.status,
  msg: (x.return_message || '').slice(0, 70)
})));

await client.end();
