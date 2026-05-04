/**
 * Inspect a specific game file to understand the mismatch.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const PERGAME_ROOT = join(REPO_ROOT, 'data', 'historical-odds-pergame');

const env = Object.fromEntries(
  readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);

const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const SOURCE_TAG = 'odds_api_historical_pergame';

// Get a specific game to inspect - Athletics game from 2024-03-29
const { rows } = await c.query(`
  SELECT g.id::text AS game_id, g.game_date::text, ht.name AS home, at.name AS away
  FROM games g
  JOIN teams ht ON ht.id = g.home_team_id
  JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date = '2024-03-29'
    AND (ht.name LIKE '%Athletic%' OR at.name LIKE '%Athletic%')
    AND g.status = 'final'
  LIMIT 5
`);

for (const g of rows) {
  console.log(`Game: ${g.away} @ ${g.home} [${g.game_id}]`);
  const filePath = join(PERGAME_ROOT, '2024', `${g.game_id}.json`);
  if (!existsSync(filePath)) { console.log('  FILE MISSING'); continue; }
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const apiGames = raw.data ?? [];

  function normTeam(name) {
    if (!name) return '';
    const clean = name.trim().replace(/^the\s+/i, '');
    const parts = clean.split(' ');
    const franchise = parts.length >= 3
      ? parts.slice(-2).join('').toLowerCase().replace(/[^a-z]/g, '')
      : parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    return franchise;
  }

  const dbHomeNorm = normTeam(g.home);
  const dbAwayNorm = normTeam(g.away);

  const matched = apiGames.find(ag =>
    normTeam(ag.home_team) === dbHomeNorm &&
    normTeam(ag.away_team) === dbAwayNorm
  );

  if (matched) {
    console.log(`  API home_team: "${matched.home_team}"`);
    console.log(`  API away_team: "${matched.away_team}"`);
    const dk = (matched.bookmakers ?? []).find(b => b.key === 'draftkings');
    if (dk) {
      const h2h = (dk.markets ?? []).find(m => m.key === 'h2h');
      console.log(`  DK h2h outcomes:`, JSON.stringify(h2h?.outcomes?.map(o => o.name)));
      // The bug: outcome names vs matchedApiGame.home_team
      const homeOut = h2h?.outcomes?.find(o => o.name === matched.home_team);
      const awayOut = h2h?.outcomes?.find(o => o.name === matched.away_team);
      console.log(`  homeOutcome match: ${homeOut ? 'YES' : 'NO'} (looking for "${matched.home_team}")`);
      console.log(`  awayOutcome match: ${awayOut ? 'YES' : 'NO'} (looking for "${matched.away_team}")`);
    }
  }
}

await c.end();
