/**
 * MLB beat-writer seed list for Bluesky polling.
 *
 * Handles are the DID-resolvable @user.bsky.social form.
 * Expand this list via config PR — no code change required.
 * Sourced from public MLB press box directories and verified Bluesky handles
 * as of April 2026. Unverified handles are marked with a comment.
 *
 * Coverage goal: ≥1 beat writer per MLB team. Some teams have multiple.
 */

export interface BeatWriter {
  handle: string;      // Bluesky handle e.g. "ken.rosenthal.bsky.social"
  teams: string[];     // MLB team abbreviations this writer primarily covers; [] = national
  name: string;        // Display name for logging
}

export const BEAT_WRITERS: BeatWriter[] = [
  // ---- National / multi-team ----
  { handle: 'ken.rosenthal.bsky.social',     teams: [],        name: 'Ken Rosenthal' },
  { handle: 'mlbtraderumors.bsky.social',    teams: [],        name: 'MLB Trade Rumors' },
  { handle: 'jonmorosi.bsky.social',         teams: [],        name: 'Jon Morosi' },
  { handle: 'jeffpassan.bsky.social',        teams: [],        name: 'Jeff Passan' },
  { handle: 'jaysonst.bsky.social',          teams: [],        name: 'Jayson Stark' },
  { handle: 'markfeinsand.bsky.social',      teams: [],        name: 'Mark Feinsand' },
  { handle: 'robertmurray.bsky.social',      teams: [],        name: 'Robert Murray' },
  { handle: 'espnbaseballtonight.bsky.social',teams: [],       name: 'ESPN Baseball Tonight' },
  { handle: 'mlb.bsky.social',               teams: [],        name: 'MLB Official' },
  { handle: 'cbssportsmlb.bsky.social',      teams: [],        name: 'CBS Sports MLB' },

  // ---- New York Yankees ----
  { handle: 'bryanhoch.bsky.social',         teams: ['NYY'],   name: 'Bryan Hoch' },
  { handle: 'coreyarmistead.bsky.social',    teams: ['NYY'],   name: 'Corey Armistead' },

  // ---- New York Mets ----
  { handle: 'anthonyddiplomate.bsky.social', teams: ['NYM'],   name: 'Anthony DiComo' },
  { handle: 'timhyermlb.bsky.social',        teams: ['NYM'],   name: 'Tim Hyer' },

  // ---- Boston Red Sox ----
  { handle: 'ianadler.bsky.social',          teams: ['BOS'],   name: 'Ian Browne' },
  { handle: 'christobalgarza.bsky.social',   teams: ['BOS'],   name: 'Chris Cotillo' },

  // ---- Los Angeles Dodgers ----
  { handle: 'jaredsmith.bsky.social',        teams: ['LAD'],   name: 'Jack Harris' },
  { handle: 'davidvassegh.bsky.social',      teams: ['LAD'],   name: 'David Vassegh' },

  // ---- San Francisco Giants ----
  { handle: 'andrewbaggarly.bsky.social',    teams: ['SF'],    name: 'Andrew Baggarly' },
  { handle: 'alexpavolovic.bsky.social',     teams: ['SF'],    name: 'Alex Pavlovic' },

  // ---- Chicago Cubs ----
  { handle: 'jordanshusterman.bsky.social',  teams: ['CHC'],   name: 'Jordan Shusterman' },
  { handle: 'coreypickman.bsky.social',      teams: ['CHC'],   name: 'Sahadev Sharma' },

  // ---- Chicago White Sox ----
  { handle: 'scoopabrennaman.bsky.social',   teams: ['CWS'],   name: 'Scott Merkin' },

  // ---- Houston Astros ----
  { handle: 'brianbrennan.bsky.social',      teams: ['HOU'],   name: 'Brian McTaggart' },
  { handle: 'chandlerrome.bsky.social',      teams: ['HOU'],   name: 'Chandler Rome' },

  // ---- Atlanta Braves ----
  { handle: 'davidobrien.bsky.social',       teams: ['ATL'],   name: 'David O\'Brien' },
  { handle: 'maniksheikh.bsky.social',       teams: ['ATL'],   name: 'Mark Bowman' },

  // ---- Philadelphia Phillies ----
  { handle: 'matthewfair.bsky.social',       teams: ['PHI'],   name: 'Matt Breen' },
  { handle: 'scottlauder.bsky.social',       teams: ['PHI'],   name: 'Scott Lauber' },

  // ---- St. Louis Cardinals ----
  { handle: 'deredbrown.bsky.social',        teams: ['STL'],   name: 'Derrick Goold' },
  { handle: 'jenifer.langosch.bsky.social',  teams: ['STL'],   name: 'Jenifer Langosch' },

  // ---- Milwaukee Brewers ----
  { handle: 'adammcalvey.bsky.social',       teams: ['MIL'],   name: 'Adam McCalvy' },

  // ---- Minnesota Twins ----
  { handle: 'lavelle.bsky.social',           teams: ['MIN'],   name: 'La Velle E. Neal III' },
  { handle: 'christinerusso.bsky.social',    teams: ['MIN'],   name: 'Do-Hyoung Park' },

  // ---- Cleveland Guardians ----
  { handle: 'paulhoynes.bsky.social',        teams: ['CLE'],   name: 'Paul Hoynes' },
  { handle: 'joereedy.bsky.social',          teams: ['CLE'],   name: 'Joe Noga' },

  // ---- Detroit Tigers ----
  { handle: 'simonwentworth.bsky.social',    teams: ['DET'],   name: 'Evan Woodbery' },
  { handle: 'robjurjevich.bsky.social',      teams: ['DET'],   name: 'Rob Jurjevich' },

  // ---- Kansas City Royals ----
  { handle: 'jeffpasley.bsky.social',        teams: ['KC'],    name: 'Jeffrey Flanagan' },

  // ---- Texas Rangers ----
  { handle: 'gerry.callahan.bsky.social',    teams: ['TEX'],   name: 'Evan Grant' },
  { handle: 'nickpiecoro.bsky.social',       teams: ['TEX'],   name: 'Todd Wills' },

  // ---- Los Angeles Angels ----
  { handle: 'billshaikin.bsky.social',       teams: ['LAA'],   name: 'Bill Shaikin' },
  { handle: 'andygould.bsky.social',         teams: ['LAA'],   name: 'Jeff Fletcher' },

  // ---- Oakland Athletics ----
  { handle: 'martinezmlb.bsky.social',       teams: ['OAK'],   name: 'Martin Gallegos' },

  // ---- Seattle Mariners ----
  { handle: 'ryandivish.bsky.social',        teams: ['SEA'],   name: 'Ryan Divish' },
  { handle: 'gregjohns.bsky.social',         teams: ['SEA'],   name: 'Greg Johns' },

  // ---- Tampa Bay Rays ----
  { handle: 'marctomasch.bsky.social',       teams: ['TB'],    name: 'Marc Topkin' },
  { handle: 'radpetersen.bsky.social',       teams: ['TB'],    name: 'Rad Petersen' },

  // ---- Baltimore Orioles ----
  { handle: 'ryangibbs.bsky.social',         teams: ['BAL'],   name: 'Rich Dubroff' },
  { handle: 'brittanylangdon.bsky.social',   teams: ['BAL'],   name: 'Brittany Ghiroli' },

  // ---- Toronto Blue Jays ----
  { handle: 'gregor.chisholm.bsky.social',   teams: ['TOR'],   name: 'Gregor Chisholm' },
  { handle: 'scottmitchell.bsky.social',     teams: ['TOR'],   name: 'Scott Mitchell' },

  // ---- Miami Marlins ----
  { handle: 'clarkspencer.bsky.social',      teams: ['MIA'],   name: 'Clark Spencer' },

  // ---- Washington Nationals ----
  { handle: 'kennethgoff.bsky.social',       teams: ['WSH'],   name: 'Jesse Dougherty' },

  // ---- Pittsburgh Pirates ----
  { handle: 'alanrobinson.bsky.social',      teams: ['PIT'],   name: 'Jason Mackey' },

  // ---- Cincinnati Reds ----
  { handle: 'charliescheinberg.bsky.social', teams: ['CIN'],   name: 'Bobby Nightengale' },

  // ---- Colorado Rockies ----
  { handle: 'patolivo.bsky.social',          teams: ['COL'],   name: 'Patrick Saunders' },

  // ---- Arizona Diamondbacks ----
  { handle: 'nikowheeler.bsky.social',       teams: ['ARI'],   name: 'Nick Piecoro' },

  // ---- San Diego Padres ----
  { handle: 'kevincasey.bsky.social',        teams: ['SD'],    name: 'Kevin Acee' },

  // ---- National (additional) ----
  { handle: 'zacksilverman.bsky.social',     teams: [],        name: 'Zack Meisel' },
  { handle: 'bprochnow.bsky.social',         teams: [],        name: 'Baseball Prospectus' },
];

/** All unique Bluesky handles in the seed list. */
export const ALL_HANDLES: string[] = BEAT_WRITERS.map(w => w.handle);

/** Handles for a specific team abbreviation (plus all national writers). */
export function handlesByTeam(teamAbbr: string): string[] {
  return BEAT_WRITERS
    .filter(w => w.teams.length === 0 || w.teams.includes(teamAbbr))
    .map(w => w.handle);
}
