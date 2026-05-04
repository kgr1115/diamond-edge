import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const env = Object.fromEntries(
  readFileSync(join(repoRoot, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const e = l.indexOf('=');
      return [l.slice(0, e).trim(), l.slice(e + 1).trim()];
    }),
);

const apiKey = env.THE_ODDS_API_KEY ?? env.ODDS_API_KEY;
if (!apiKey) {
  console.error('THE_ODDS_API_KEY missing');
  process.exit(1);
}

const url = new URL('https://api.the-odds-api.com/v4/sports/baseball_mlb/odds');
url.searchParams.set('apiKey', apiKey);
url.searchParams.set('regions', 'us');
url.searchParams.set('markets', 'h2h,spreads,totals');
url.searchParams.set('bookmakers', 'draftkings,fanduel');
url.searchParams.set('oddsFormat', 'american');

const res = await fetch(url);
console.log('Status:', res.status, 'used:', res.headers.get('x-requests-used'), 'remaining:', res.headers.get('x-requests-remaining'));

const games = await res.json();
console.log(`\nTotal games: ${games.length}\n`);

// Flag implausible MLB lines that come straight from the API
const ABBR = {};
let bad = 0;
for (const g of games) {
  const label = `${g.away_team?.split(' ').pop() ?? '???'} @ ${g.home_team?.split(' ').pop() ?? '???'}`;
  const t = g.commence_time?.slice(11, 16) ?? '';
  for (const bk of g.bookmakers ?? []) {
    for (const m of bk.markets ?? []) {
      if (m.key === 'h2h') {
        const home = m.outcomes.find((o) => o.name === g.home_team);
        const away = m.outcomes.find((o) => o.name === g.away_team);
        if (home?.price && Math.abs(home.price) > 2000) {
          bad++;
          console.log(`ML EXTREME: ${label} ${bk.key} home ${home.price} away ${away?.price} (${t}Z)`);
        }
      }
      if (m.key === 'spreads') {
        const home = m.outcomes.find((o) => o.name === g.home_team);
        if (home?.point && Math.abs(home.point) > 2.5) {
          bad++;
          console.log(`SPREAD EXTREME: ${label} ${bk.key} home ${home.point} (${t}Z)`);
        }
      }
      if (m.key === 'totals') {
        const o = m.outcomes[0];
        if (o?.point && (o.point < 5.5 || o.point > 13)) {
          bad++;
          console.log(`TOTAL EXTREME: ${label} ${bk.key} total ${o.point} (${t}Z)`);
        }
      }
    }
  }
}
console.log(`\nImplausible markets: ${bad}`);

console.log('\n=== All games (commence times) ===');
for (const g of games) {
  console.log(`${g.commence_time}  ${g.away_team} @ ${g.home_team}  id=${g.id}`);
}
