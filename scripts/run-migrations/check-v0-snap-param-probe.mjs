// COO-mandated 200-credit probe: validate that The Odds API historical endpoint
// returns snapshots near `game_time_utc - 75min` when requested with that timestamp.
//
// Methodology:
//   1. Pick a representative night-heavy slate date (2024-07-23, 14 finals).
//   2. For each game on that date, request historical odds with date param =
//      game_time_utc - 75min.
//   3. Parse the response's top-level `timestamp` field — that is the actual archived
//      snap time the API returned.
//   4. PASS if >= 80% of games return a snap within ±15min of the requested target.
//   5. FAIL if the API just returns the same archived snap (e.g. 03:00 UTC next day)
//      regardless of the date param — meaning the bug fix won't help.
//
// Credit cost: 14 games × 30 credits/call = 420 credits worst case.
// Hard halt at 500 per Kyle's pause-point rule.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);

const apiKey = env.THE_ODDS_API_KEY;
if (!apiKey) {
  console.error('THE_ODDS_API_KEY missing in .env');
  process.exit(1);
}

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const HISTORICAL_ENDPOINT = `${ODDS_API_BASE}/historical/sports/baseball_mlb/odds`;
const PROBE_DATE = '2024-07-23';
const HARD_CREDIT_HALT = 500;
const PASS_PCT = 0.80;
const TOLERANCE_MIN = 15;

const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: games } = await c.query(`
  SELECT g.id::text AS gid, g.mlb_game_id::text AS mlb_id,
         g.game_time_utc::text AS gstart_iso,
         ht.name AS home, at.name AS away
  FROM games g
  JOIN teams ht ON ht.id = g.home_team_id
  JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date = $1 AND g.status = 'final'
  ORDER BY g.game_time_utc
`, [PROBE_DATE]);

await c.end();

if (games.length === 0) {
  console.error(`[FATAL] No finals found for ${PROBE_DATE}`);
  process.exit(1);
}

console.log(`\n=== SNAP-PARAM PROBE ===`);
console.log(`Probe date: ${PROBE_DATE}`);
console.log(`Games to probe: ${games.length}`);
console.log(`Hard halt at credit spend: ${HARD_CREDIT_HALT}`);
console.log(`Pass threshold: >= ${(PASS_PCT * 100).toFixed(0)}% of games within ±${TOLERANCE_MIN}min of T-75min target\n`);

let initialCredits = -1;
let lastCredits = -1;
const probeResults = [];

for (let i = 0; i < games.length; i++) {
  const g = games[i];
  const gameStart = new Date(g.gstart_iso);
  // Target = game_time_utc - 75min
  const targetSnap = new Date(gameStart.getTime() - 75 * 60 * 1000);
  // The Odds API historical endpoint REJECTS millisecond-precision ISO 8601
  // (returns 422 INVALID_HISTORICAL_TIMESTAMP). Strip .000 to match the format.
  const targetIso = targetSnap.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const url = new URL(HISTORICAL_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'h2h');
  url.searchParams.set('bookmakers', 'draftkings,fanduel');
  url.searchParams.set('date', targetIso);
  url.searchParams.set('oddsFormat', 'american');

  process.stdout.write(`[${i + 1}/${games.length}] ${g.away} @ ${g.home}  start=${g.gstart_iso}  target=${targetIso} ... `);

  const res = await fetch(url);
  const used = parseInt(res.headers.get('x-requests-used') ?? '-1', 10);
  const remaining = parseInt(res.headers.get('x-requests-remaining') ?? '-1', 10);

  if (initialCredits === -1) initialCredits = used;
  lastCredits = used;

  if (!res.ok) {
    console.log(`HTTP ${res.status}`);
    probeResults.push({
      game: `${g.away} @ ${g.home}`, gameStart: g.gstart_iso,
      target: targetIso, returnedSnap: null, deltaMinutes: null, status: 'HTTP_ERROR',
    });
    continue;
  }

  const body = await res.json();
  const returnedSnap = body.timestamp ?? null;

  let deltaMinutes = null;
  let status = 'NO_SNAP';
  if (returnedSnap) {
    const returnedDate = new Date(returnedSnap);
    deltaMinutes = (returnedDate.getTime() - targetSnap.getTime()) / 60000;
    status = Math.abs(deltaMinutes) <= TOLERANCE_MIN ? 'PASS' : 'FAIL';
  }

  console.log(`returned=${returnedSnap}  delta=${deltaMinutes !== null ? deltaMinutes.toFixed(1) : 'n/a'}min  ${status}  used=${used}  remaining=${remaining}`);

  probeResults.push({
    game: `${g.away} @ ${g.home}`,
    gameStart: g.gstart_iso,
    target: targetIso,
    returnedSnap,
    deltaMinutes,
    status,
    nGamesInResponse: Array.isArray(body.data) ? body.data.length : 0,
  });

  // Hard halt check
  const probeBurn = used - initialCredits;
  if (probeBurn >= HARD_CREDIT_HALT) {
    console.error(`\n[HARD HALT] Probe burn ${probeBurn} >= ${HARD_CREDIT_HALT}. Stopping.`);
    break;
  }

  // Polite delay
  await new Promise(r => setTimeout(r, 200));
}

const totalBurn = lastCredits - initialCredits;

// Compute pass rate
const passes = probeResults.filter(r => r.status === 'PASS').length;
const fails = probeResults.filter(r => r.status === 'FAIL').length;
const noSnaps = probeResults.filter(r => r.status === 'NO_SNAP').length;
const errors = probeResults.filter(r => r.status === 'HTTP_ERROR').length;
const probedTotal = probeResults.length;
const passRate = probedTotal > 0 ? passes / probedTotal : 0;

// Distribution of returned snap timestamps - if all the same, the API is ignoring our param
const distinctSnaps = new Set(probeResults.map(r => r.returnedSnap).filter(Boolean));

console.log('\n=== PROBE RESULTS ===');
console.log(`Probed games: ${probedTotal}`);
console.log(`PASS (within ±${TOLERANCE_MIN}min): ${passes}`);
console.log(`FAIL (outside tolerance): ${fails}`);
console.log(`NO_SNAP (API returned no timestamp): ${noSnaps}`);
console.log(`HTTP errors: ${errors}`);
console.log(`Pass rate: ${(passRate * 100).toFixed(1)}%`);
console.log(`Distinct returned snap timestamps: ${distinctSnaps.size}`);
if (distinctSnaps.size <= 3) {
  console.log(`Distinct snaps: ${[...distinctSnaps].join(', ')}`);
}
console.log(`Total credit burn: ${totalBurn}`);
console.log(`Initial credits: ${initialCredits}, final used: ${lastCredits}`);

const PROBE_PASSED = passRate >= PASS_PCT && distinctSnaps.size >= Math.floor(probedTotal * 0.5);

console.log(`\n=== VERDICT: ${PROBE_PASSED ? 'PASS' : 'FAIL'} ===`);
if (PROBE_PASSED) {
  console.log('Option B (full 2022-09 → 2024 re-pull) is viable.');
} else {
  console.log('Falling back to Option C (2024-only re-pull) per CSO verdict.');
  if (distinctSnaps.size <= 3) {
    console.log('Note: API appears to return a single archived snap regardless of date param,');
    console.log('which means even Option C will struggle. Escalate before C fallback.');
  }
}

// Persist probe artifact for the bundled report
const fs = await import('node:fs/promises');
const probeArtifact = {
  probe_date: PROBE_DATE,
  probed_at_utc: new Date().toISOString(),
  initial_credits_used: initialCredits,
  final_credits_used: lastCredits,
  total_burn: totalBurn,
  hard_halt_threshold: HARD_CREDIT_HALT,
  tolerance_minutes: TOLERANCE_MIN,
  pass_threshold_pct: PASS_PCT,
  results: probeResults,
  summary: {
    probed_total: probedTotal,
    passes, fails, no_snaps: noSnaps, http_errors: errors,
    pass_rate: passRate,
    distinct_returned_snaps: distinctSnaps.size,
    distinct_snap_samples: [...distinctSnaps],
  },
  verdict: PROBE_PASSED ? 'PASS' : 'FAIL',
  next_step: PROBE_PASSED ? 'execute_option_b' : 'fallback_to_option_c',
};
await fs.writeFile(
  join(__dirname, '..', '..', 'docs', 'audits', 'moneyline-v0-snap-param-probe-2026-05-03.json'),
  JSON.stringify(probeArtifact, null, 2),
);
console.log('\nProbe artifact written to docs/audits/moneyline-v0-snap-param-probe-2026-05-03.json');

process.exit(PROBE_PASSED ? 0 : 1);
