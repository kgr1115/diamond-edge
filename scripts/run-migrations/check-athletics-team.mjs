import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const env = Object.fromEntries(
  readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);

const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

// Check team names
const { rows } = await c.query(`SELECT id, name FROM teams WHERE name LIKE '%Athletic%' OR name = 'Athletics' ORDER BY name`);
console.log('Teams with Athletic in name:');
console.table(rows);

// How the normTeam function works
function normTeam(name) {
  if (!name) return '';
  const clean = name.trim().replace(/^the\s+/i, '');
  const parts = clean.split(' ');
  const franchise = parts.length >= 3
    ? parts.slice(-2).join('').toLowerCase().replace(/[^a-z]/g, '')
    : parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  return franchise;
}

for (const r of rows) {
  console.log(`"${r.name}" -> normTeam: "${normTeam(r.name)}"`);
}

// What the API returns for Oakland/Athletics
const apiNames = ['Oakland Athletics', 'Athletics', 'Oakland A\'s'];
for (const n of apiNames) {
  console.log(`API "${n}" -> normTeam: "${normTeam(n)}"`);
}

// Now check actual game rows
const { rows: gameRows } = await c.query(`
  SELECT g.id::text, g.game_date::text, ht.name AS home, at.name AS away
  FROM games g
  JOIN teams ht ON ht.id = g.home_team_id
  JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date = '2024-03-29'
    AND (ht.name LIKE '%Athletic%' OR at.name LIKE '%Athletic%')
    AND g.status = 'final'
  LIMIT 3
`);
console.log('\nGame rows for Athletics on 2024-03-29:');
for (const g of gameRows) {
  console.log(`  ${g.away} @ ${g.home}`);
  console.log(`    normTeam(home)="${normTeam(g.home)}" normTeam(away)="${normTeam(g.away)}"`);
}

await c.end();
