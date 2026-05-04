/**
 * Sample 20 of the unloaded 2024 games to understand why they're not matching.
 * Shows DB team names vs API team names in the disk files.
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

// Get 20 unloaded 2024 games
const { rows: missing } = await c.query(`
  SELECT g.id::text AS game_id,
         g.game_date::text AS game_date,
         ht.name AS home_name,
         at.name AS away_name
  FROM games g
  JOIN teams ht ON ht.id = g.home_team_id
  JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date >= '2024-01-01' AND g.game_date <= '2024-12-31'
    AND g.status = 'final' AND g.game_time_utc IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM odds o
      WHERE o.game_id = g.id AND o.market = 'moneyline'
        AND o.closing_snapshot = true AND o.source = $1
    )
  ORDER BY g.game_date
  LIMIT 20
`, [SOURCE_TAG]);

function normTeam(name) {
  if (!name) return '';
  const clean = name.trim().replace(/^the\s+/i, '');
  const parts = clean.split(' ');
  const franchise = parts.length >= 3
    ? parts.slice(-2).join('').toLowerCase().replace(/[^a-z]/g, '')
    : parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  return franchise;
}

console.log('=== Team match analysis for 20 unloaded 2024 games ===\n');

for (const g of missing) {
  const filePath = join(PERGAME_ROOT, '2024', `${g.game_id}.json`);
  if (!existsSync(filePath)) {
    console.log(`[${g.game_date}] ${g.away_name} @ ${g.home_name} -- FILE MISSING`);
    continue;
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.log(`[${g.game_date}] ${g.away_name} @ ${g.home_name} -- PARSE ERROR`);
    continue;
  }

  const dbHomeNorm = normTeam(g.home_name);
  const dbAwayNorm = normTeam(g.away_name);

  const apiGames = raw.data ?? [];

  // Try to find a match
  const matched = apiGames.find(ag =>
    ag.home_team && ag.away_team &&
    normTeam(ag.home_team) === dbHomeNorm &&
    normTeam(ag.away_team) === dbAwayNorm
  );

  if (matched) {
    // Matched but still not loaded — check if bookmakers have h2h
    const dkBook = (matched.bookmakers ?? []).find(b => b.key === 'draftkings');
    const fdBook = (matched.bookmakers ?? []).find(b => b.key === 'fanduel');
    console.log(`[${g.game_date}] ${g.away_name} @ ${g.home_name}`);
    console.log(`  MATCHED but not loaded. DK: ${dkBook ? 'yes' : 'no'}, FD: ${fdBook ? 'yes' : 'no'}`);
    if (dkBook) {
      const h2h = (dkBook.markets ?? []).find(m => m.key === 'h2h');
      console.log(`  DK h2h outcomes: ${JSON.stringify(h2h?.outcomes ?? [])}`);
    }
  } else {
    // No match — show API teams
    const apiTeams = apiGames.map(ag => `${ag.away_team} @ ${ag.home_team}`);
    console.log(`[${g.game_date}] DB: ${g.away_name} (${dbAwayNorm}) @ ${g.home_name} (${dbHomeNorm})`);
    console.log(`  API teams (${apiGames.length} games):`);
    if (apiGames.length === 0) {
      console.log(`    (empty data array)`);
    } else {
      for (const t of apiTeams.slice(0, 5)) {
        const ag = apiGames.find(g2 => `${g2.away_team} @ ${g2.home_team}` === t);
        const hn = normTeam(ag?.home_team ?? '');
        const an = normTeam(ag?.away_team ?? '');
        console.log(`    ${t}  [norms: ${an} @ ${hn}]`);
      }
    }
  }
}

await c.end();
