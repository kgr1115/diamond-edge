/**
 * Moneyline-v0 — serving feature construction.
 *
 * Mirror of `scripts/features/build-moneyline-v0.py` but for online/serving.
 *
 * SOURCE-OF-TRUTH INVARIANT:
 *   training source = serving source = CLV-grading source = DK+FD via The Odds API.
 *   Same vendor, same books, same h2h moneyline market, same snapshot pin
 *   (game_time_utc - 60min). The drop predicate is identical: rows where
 *   neither DK nor FD has a usable closing price at T-60 are NOT served.
 *
 * Train/serve parity contract:
 *   The 12-feature payload here MUST be byte-identical to the training-time
 *   row built by build-moneyline-v0.py for the same game at the same as_of.
 *   Any divergence (different anchor formula, different FIP constant, different
 *   imputation values) is a parity break and the model will mis-weight.
 *   The parity test fixture is at tests/integration/feature-parity-moneyline-v0.spec.ts.
 *
 * Drop semantics:
 *   - If anchor (DK+FD consensus log-odds) is null at T-60, return null. The
 *     pick must NOT be generated for this game. Log + skip in the cron.
 *   - All other features fall back to documented null handling (league avg,
 *     neutral park factor, dome wind = 0, etc.) — the row is still served.
 *
 * Spec source of truth: docs/features/moneyline-v0-feature-spec.md
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type MoneylineV0Features = {
  market_log_odds_home: number;
  starter_fip_home: number;
  starter_fip_away: number;
  starter_days_rest_home: number;
  starter_days_rest_away: number;
  bullpen_fip_l14_home: number;
  bullpen_fip_l14_away: number;
  team_wrcplus_l30_home: number;
  team_wrcplus_l30_away: number;
  park_factor_runs: number;
  weather_temp_f: number;
  weather_wind_out_mph: number;
};

export type MoneylineV0Row = MoneylineV0Features & {
  game_id: string;
  game_time_utc: string;
  as_of: string;
  feature_flags: number;
  // Diagnostic — surfaces which book(s) contributed to the anchor.
  anchor_books_used: ('draftkings' | 'fanduel')[];
};

// Constants must match the training script byte-for-byte.
const FIP_CONSTANT = 3.10;
const LEAGUE_AVG_FIP = 4.20;
const LEAGUE_AVG_BULLPEN_FIP = 4.30;
const LEAGUE_AVG_WRC_PLUS = 100;
const DAYS_REST_CAP = 60;
// League-avg temperature for night-game NULL imputation. Mirrors the value
// computed by the training script from games.weather_temp_f over 2023-2024.
// Updated whenever the training script's league_avg_temp recomputes — keep
// these in sync via the build-summary.json check.
const LEAGUE_AVG_TEMP_F = 72;

// ---------------------------------------------------------------------------
// Helpers — must mirror training byte-for-byte
// ---------------------------------------------------------------------------

function americanToImpliedProb(price: number): number {
  if (price >= 100) return 100 / (price + 100);
  return Math.abs(price) / (Math.abs(price) + 100);
}

function devigProportional(pHome: number, pAway: number): { pHome: number; pAway: number } | null {
  const s = pHome + pAway;
  if (s <= 0) return null;
  return { pHome: pHome / s, pAway: pAway / s };
}

function safeLogOdds(p: number): number | null {
  if (!(p > 0 && p < 1) || Number.isNaN(p)) return null;
  return Math.log(p / (1 - p));
}

function fipFromComponents(hr: number, bb: number, hbp: number, k: number, ip: number): number | null {
  if (ip <= 0) return null;
  return ((13 * hr + 3 * (bb + hbp) - 2 * k) / ip) + FIP_CONSTANT;
}

// ---------------------------------------------------------------------------
// Feature 1 — anchor (DK+FD consensus log-odds, de-vigged)
// ---------------------------------------------------------------------------

export async function fetchAnchor(
  db: SupabaseClient,
  gameId: string,
  asOfIso: string,
): Promise<{ logOdds: number | null; books: ('draftkings' | 'fanduel')[] }> {
  const { data: rows, error } = await db
    .from('odds')
    .select(`
      home_price, away_price, snapshotted_at,
      sportsbooks!inner(key)
    `)
    .eq('game_id', gameId)
    .eq('market', 'moneyline')
    .lte('snapshotted_at', asOfIso)
    .in('sportsbooks.key', ['draftkings', 'fanduel'])
    .order('snapshotted_at', { ascending: false });

  if (error) throw error;
  if (!rows || rows.length === 0) return { logOdds: null, books: [] };

  // Latest per book at or before as_of
  const byBook = new Map<string, { home_price: number | null; away_price: number | null; snapshotted_at: string }>();
  for (const r of rows) {
    const bookRow = (r as { sportsbooks: { key: string } | { key: string }[] }).sportsbooks;
    const key = Array.isArray(bookRow) ? bookRow[0]?.key : bookRow?.key;
    if (key && !byBook.has(key)) {
      byBook.set(key, {
        home_price: r.home_price as number | null,
        away_price: r.away_price as number | null,
        snapshotted_at: r.snapshotted_at as string,
      });
    }
  }

  const consensusList: number[] = [];
  const books: ('draftkings' | 'fanduel')[] = [];
  for (const bookKey of ['draftkings', 'fanduel'] as const) {
    const v = byBook.get(bookKey);
    if (!v || v.home_price == null || v.away_price == null) continue;
    const pHomeRaw = americanToImpliedProb(v.home_price);
    const pAwayRaw = americanToImpliedProb(v.away_price);
    const dev = devigProportional(pHomeRaw, pAwayRaw);
    if (dev) {
      consensusList.push(dev.pHome);
      books.push(bookKey);
    }
  }
  if (consensusList.length === 0) return { logOdds: null, books: [] };
  const pConsensus = consensusList.reduce((a, b) => a + b, 0) / consensusList.length;
  return { logOdds: safeLogOdds(pConsensus), books };
}

// ---------------------------------------------------------------------------
// Features 2-5 — starter FIP + days rest
// ---------------------------------------------------------------------------

export async function fetchStarterFip(db: SupabaseClient, pitcherId: string | null, asOfIso: string): Promise<number> {
  if (!pitcherId) return LEAGUE_AVG_FIP;
  const asOfDate = asOfIso.slice(0, 10);
  const { data, error } = await db
    .from('pitcher_game_log')
    .select('ip, hr, bb, hbp, k')
    .eq('pitcher_id', pitcherId)
    .gte('game_date', subtractDays(asOfDate, 30))
    .lt('game_date', asOfDate);
  if (error) throw error;
  if (!data || data.length === 0) return LEAGUE_AVG_FIP;
  let sumIp = 0, sumNum = 0;
  for (const r of data) {
    const ip = Number(r.ip ?? 0);
    sumIp += ip;
    sumNum += 13 * Number(r.hr ?? 0) + 3 * (Number(r.bb ?? 0) + Number(r.hbp ?? 0)) - 2 * Number(r.k ?? 0);
  }
  if (sumIp < 3) return LEAGUE_AVG_FIP;
  return sumNum / sumIp + FIP_CONSTANT;
}

export async function fetchStarterDaysRest(db: SupabaseClient, pitcherId: string | null, asOfIso: string): Promise<number> {
  if (!pitcherId) return DAYS_REST_CAP;
  const asOfDate = asOfIso.slice(0, 10);
  const { data, error } = await db
    .from('pitcher_game_log')
    .select('game_date')
    .eq('pitcher_id', pitcherId)
    .lt('game_date', asOfDate)
    .order('game_date', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return DAYS_REST_CAP;
  const last = new Date(data[0].game_date as string);
  const asOf = new Date(asOfDate);
  const days = Math.floor((asOf.getTime() - last.getTime()) / (24 * 60 * 60 * 1000));
  return Math.min(days, DAYS_REST_CAP);
}

// ---------------------------------------------------------------------------
// Features 6-7 — bullpen FIP
// ---------------------------------------------------------------------------

export async function fetchBullpenFip(
  db: SupabaseClient, teamId: string, starterId: string | null, asOfIso: string,
): Promise<number> {
  const asOfDate = asOfIso.slice(0, 10);
  let q = db
    .from('pitcher_game_log')
    .select('ip, hr, bb, hbp, k')
    .eq('team_id', teamId)
    .gte('game_date', subtractDays(asOfDate, 14))
    .lt('game_date', asOfDate);
  if (starterId) q = q.neq('pitcher_id', starterId);
  const { data, error } = await q;
  if (error) throw error;
  if (!data || data.length === 0) return LEAGUE_AVG_BULLPEN_FIP;
  let sumIp = 0, sumNum = 0;
  for (const r of data) {
    const ip = Number(r.ip ?? 0);
    sumIp += ip;
    sumNum += 13 * Number(r.hr ?? 0) + 3 * (Number(r.bb ?? 0) + Number(r.hbp ?? 0)) - 2 * Number(r.k ?? 0);
  }
  if (sumIp < 10) return LEAGUE_AVG_BULLPEN_FIP;
  return sumNum / sumIp + FIP_CONSTANT;
}

// ---------------------------------------------------------------------------
// Features 8-9 — team wRC+ (PA-weighted)
// ---------------------------------------------------------------------------

export async function fetchTeamWrcPlus(db: SupabaseClient, teamId: string, asOfIso: string): Promise<number> {
  const asOfDate = asOfIso.slice(0, 10);
  const { data, error } = await db
    .from('batter_game_log')
    .select('pa, wrc_plus')
    .eq('team_id', teamId)
    .gte('game_date', subtractDays(asOfDate, 30))
    .lt('game_date', asOfDate)
    .not('wrc_plus', 'is', null);
  if (error) throw error;
  if (!data || data.length === 0) return LEAGUE_AVG_WRC_PLUS;
  let num = 0, denom = 0;
  for (const r of data) {
    const pa = Number(r.pa ?? 0);
    const wrc = Number(r.wrc_plus ?? 0);
    num += pa * wrc;
    denom += pa;
  }
  if (denom < 50) return LEAGUE_AVG_WRC_PLUS;
  return num / denom;
}

// ---------------------------------------------------------------------------
// Feature 10 — park factor (static lookup)
// ---------------------------------------------------------------------------

export async function fetchParkFactor(
  db: SupabaseClient, venueName: string | null,
): Promise<{ runsFactor: number; outfieldBearingDeg: number | null; isDome: boolean }> {
  if (!venueName) return { runsFactor: 100, outfieldBearingDeg: null, isDome: false };
  const { data, error } = await db
    .from('park_factor_runs')
    .select('runs_factor, outfield_bearing_deg, is_dome')
    .eq('venue_name', venueName)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { runsFactor: 100, outfieldBearingDeg: null, isDome: false };
  return {
    runsFactor: Number(data.runs_factor),
    outfieldBearingDeg: data.outfield_bearing_deg != null ? Number(data.outfield_bearing_deg) : null,
    isDome: Boolean(data.is_dome),
  };
}

// ---------------------------------------------------------------------------
// Features 11-12 — weather temp + wind out
// ---------------------------------------------------------------------------

export function computeWindOutMph(
  windMph: number | null,
  windDir: number | null,
  outfieldBearingDeg: number | null,
  isDome: boolean,
): number {
  if (isDome) return 0;
  if (windMph == null || windDir == null) return 0;
  if (outfieldBearingDeg == null) return 0;
  const angleRad = ((windDir - (outfieldBearingDeg + 180)) * Math.PI) / 180;
  return windMph * Math.cos(angleRad);
}

// ---------------------------------------------------------------------------
// Top-level — build the full payload for one game at as_of.
// ---------------------------------------------------------------------------

export type GameSeed = {
  game_id: string;
  game_time_utc: string;
  home_team_id: string;
  away_team_id: string;
  home_pitcher_id: string | null;
  away_pitcher_id: string | null;
  venue_name: string | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: number | null;
};

export async function buildMoneylineV0Row(
  db: SupabaseClient,
  game: GameSeed,
): Promise<MoneylineV0Row | null> {
  const gameTime = new Date(game.game_time_utc);
  const asOf = new Date(gameTime.getTime() - 60 * 60 * 1000);
  const asOfIso = asOf.toISOString();

  const { logOdds: anchor, books } = await fetchAnchor(db, game.game_id, asOfIso);
  if (anchor == null) return null;

  const [
    starter_fip_home, starter_fip_away,
    starter_days_rest_home, starter_days_rest_away,
    bullpen_fip_l14_home, bullpen_fip_l14_away,
    team_wrcplus_l30_home, team_wrcplus_l30_away,
    parkFactor,
  ] = await Promise.all([
    fetchStarterFip(db, game.home_pitcher_id, asOfIso),
    fetchStarterFip(db, game.away_pitcher_id, asOfIso),
    fetchStarterDaysRest(db, game.home_pitcher_id, asOfIso),
    fetchStarterDaysRest(db, game.away_pitcher_id, asOfIso),
    fetchBullpenFip(db, game.home_team_id, game.home_pitcher_id, asOfIso),
    fetchBullpenFip(db, game.away_team_id, game.away_pitcher_id, asOfIso),
    fetchTeamWrcPlus(db, game.home_team_id, asOfIso),
    fetchTeamWrcPlus(db, game.away_team_id, asOfIso),
    fetchParkFactor(db, game.venue_name),
  ]);

  const weather_temp_f = game.weather_temp_f != null
    ? Number(game.weather_temp_f)
    : (parkFactor.isDome ? 72 : LEAGUE_AVG_TEMP_F);

  const weather_wind_out_mph = computeWindOutMph(
    game.weather_wind_mph, game.weather_wind_dir,
    parkFactor.outfieldBearingDeg, parkFactor.isDome,
  );

  return {
    game_id: game.game_id,
    game_time_utc: game.game_time_utc,
    as_of: asOfIso,
    feature_flags: 0,
    anchor_books_used: books,
    market_log_odds_home: anchor,
    starter_fip_home,
    starter_fip_away,
    starter_days_rest_home,
    starter_days_rest_away,
    bullpen_fip_l14_home,
    bullpen_fip_l14_away,
    team_wrcplus_l30_home,
    team_wrcplus_l30_away,
    park_factor_runs: parkFactor.runsFactor,
    weather_temp_f,
    weather_wind_out_mph,
  };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function subtractDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
