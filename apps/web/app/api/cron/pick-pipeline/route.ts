import { NextRequest, NextResponse } from 'next/server';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { buildMoneylineV0Row, type GameSeed } from '@/lib/features/moneyline-v0';
import {
  predictHomeWinProb,
  evFromAmericanPrice,
  tierFromEv,
} from '@/lib/models/moneyline-v0';
import { impliedProb } from '@/lib/picks/line-movement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Vercel Cron handler: GET /api/cron/pick-pipeline
 *
 * Runs the moneyline-v0 pick generator end-to-end against today's slate:
 *   1. find scheduled games starting in the next ~12 hours
 *   2. seed each game's feature row at as_of = game_time_utc - 60min
 *   3. predict P(home wins) via the v0 logistic
 *   4. compute EV vs the best available DK/FD price for both home and away
 *   5. apply the +2% EV publish floor and tier mapping
 *   6. upsert one pick row per (game_id, market='moneyline') with conflict
 *      resolution on the unique constraint
 *
 * Idempotent on the (game_id, market) unique constraint introduced by
 * migration 0021_picks_unique_constraint. Re-running the cron the same day
 * updates the model probability + best line if the line moved without
 * creating duplicates.
 *
 * v0 ships at visibility='live' for the personal-tool phase. Tier ladder is
 * in `lib/models/moneyline-v0.ts`. CEng's two yellow conditions
 * (n=3,282 vs 3,500 floor; ECE bootstrap upper bound 0.0747) are not
 * blockers here — they apply to the next-cycle retrain and to a live-slate
 * ECE re-check at 200-400 graded picks.
 */

const PICK_HORIZON_HOURS = 12;

interface GameRow {
  id: string;
  game_time_utc: string;
  home_team_id: string;
  away_team_id: string;
  probable_home_pitcher_id: string | null;
  probable_away_pitcher_id: string | null;
  venue_name: string | null;
  weather_temp_f: number | null;
  weather_wind_mph: number | null;
  weather_wind_dir: string | null;
}

interface BestPriceRow {
  game_id: string;
  sportsbook_id: string;
  home_price: number | null;
  away_price: number | null;
  snapshotted_at: string;
  sportsbooks: { key: string } | { key: string }[] | null;
}

interface PipelineResult {
  considered: number;
  feature_built: number;
  skipped_no_anchor: number;
  skipped_no_best_price: number;
  picks_inserted: number;
  picks_updated: number;
  ev_floor_misses: number;
  errors: string[];
  durationMs: number;
}

function bookKeyOf(row: BestPriceRow): string | null {
  const b = row.sportsbooks;
  if (!b) return null;
  return Array.isArray(b) ? (b[0]?.key ?? null) : b.key;
}

/**
 * Pick the best (highest EV for the model's preferred side) DK/FD price for
 * one game's moneyline. Returns the side ('home' | 'away'), American price,
 * book key + id, and EV.
 *
 * Uses the latest pre-as_of snapshot per book; mirrors the anchor logic so
 * pricing the pick uses the same snapshot the model fed on.
 */
function chooseBestSide(
  modelProbHome: number,
  bestRows: BestPriceRow[],
): {
  pick_side: 'home' | 'away';
  best_line_price: number;
  best_line_book_id: string;
  expected_value: number;
  implied_probability: number;
} | null {
  let best:
    | {
        pick_side: 'home' | 'away';
        best_line_price: number;
        best_line_book_id: string;
        expected_value: number;
        implied_probability: number;
      }
    | null = null;

  for (const row of bestRows) {
    const bk = bookKeyOf(row);
    if (bk !== 'draftkings' && bk !== 'fanduel') continue;
    if (row.home_price != null) {
      const ev = evFromAmericanPrice(modelProbHome, row.home_price);
      if (!best || ev > best.expected_value) {
        best = {
          pick_side: 'home',
          best_line_price: row.home_price,
          best_line_book_id: row.sportsbook_id,
          expected_value: ev,
          implied_probability: impliedProb(row.home_price),
        };
      }
    }
    if (row.away_price != null) {
      const ev = evFromAmericanPrice(1 - modelProbHome, row.away_price);
      if (!best || ev > best.expected_value) {
        best = {
          pick_side: 'away',
          best_line_price: row.away_price,
          best_line_book_id: row.sportsbook_id,
          expected_value: ev,
          implied_probability: impliedProb(row.away_price),
        };
      }
    }
  }
  return best;
}

async function runPickPipeline(): Promise<PipelineResult> {
  const start = Date.now();
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  const now = new Date();
  const horizon = new Date(now.getTime() + PICK_HORIZON_HOURS * 60 * 60 * 1000);

  const { data: gamesData, error: gamesErr } = await supabase
    .from('games')
    .select(`
      id, game_time_utc, home_team_id, away_team_id,
      probable_home_pitcher_id, probable_away_pitcher_id,
      venue_name, weather_temp_f, weather_wind_mph, weather_wind_dir
    `)
    .eq('status', 'scheduled')
    .gte('game_time_utc', now.toISOString())
    .lte('game_time_utc', horizon.toISOString())
    .order('game_time_utc', { ascending: true });

  if (gamesErr) {
    return {
      considered: 0, feature_built: 0, skipped_no_anchor: 0,
      skipped_no_best_price: 0, picks_inserted: 0, picks_updated: 0,
      ev_floor_misses: 0, errors: [`games read failed: ${gamesErr.message}`],
      durationMs: Date.now() - start,
    };
  }

  const games = (gamesData ?? []) as GameRow[];
  console.info(JSON.stringify({
    level: 'info',
    event: 'pick_pipeline_games_loaded',
    n_games: games.length,
    horizon_hours: PICK_HORIZON_HOURS,
  }));

  let featureBuilt = 0;
  let skippedNoAnchor = 0;
  let skippedNoBestPrice = 0;
  let picksInserted = 0;
  let picksUpdated = 0;
  let evFloorMisses = 0;

  for (const g of games) {
    try {
      const seed: GameSeed = {
        game_id: g.id,
        game_time_utc: g.game_time_utc,
        home_team_id: g.home_team_id,
        away_team_id: g.away_team_id,
        home_pitcher_id: g.probable_home_pitcher_id,
        away_pitcher_id: g.probable_away_pitcher_id,
        venue_name: g.venue_name,
        weather_temp_f: g.weather_temp_f,
        weather_wind_mph: g.weather_wind_mph,
        weather_wind_dir: g.weather_wind_dir != null ? Number(g.weather_wind_dir) : null,
      };

      const row = await buildMoneylineV0Row(supabase, seed);
      if (row === null) {
        skippedNoAnchor += 1;
        continue;
      }
      featureBuilt += 1;

      const probHome = predictHomeWinProb(row);

      // Best DK/FD line at as_of (mirrors the anchor's snapshot pin).
      const { data: priceData, error: priceErr } = await supabase
        .from('odds')
        .select(`
          game_id, sportsbook_id, home_price, away_price, snapshotted_at,
          sportsbooks!inner(key)
        `)
        .eq('game_id', g.id)
        .eq('market', 'moneyline')
        .lte('snapshotted_at', row.as_of)
        .in('sportsbooks.key', ['draftkings', 'fanduel'])
        .order('snapshotted_at', { ascending: false })
        .limit(20);

      if (priceErr) {
        errors.push(`price read failed for ${g.id}: ${priceErr.message}`);
        continue;
      }

      const seenBooks = new Set<string>();
      const latestPerBook: BestPriceRow[] = [];
      for (const p of (priceData ?? []) as BestPriceRow[]) {
        const bk = bookKeyOf(p);
        if (!bk || seenBooks.has(bk)) continue;
        seenBooks.add(bk);
        latestPerBook.push(p);
      }

      const best = chooseBestSide(probHome, latestPerBook);
      if (!best) {
        skippedNoBestPrice += 1;
        continue;
      }

      const tier = tierFromEv(best.expected_value);
      if (!tier) {
        evFloorMisses += 1;
        continue;
      }

      const modelProbForPickSide = best.pick_side === 'home' ? probHome : 1 - probHome;

      const pickRow = {
        game_id: g.id,
        pick_date: g.game_time_utc.slice(0, 10),
        market: 'moneyline' as const,
        pick_side: best.pick_side,
        model_probability: modelProbForPickSide,
        implied_probability: best.implied_probability,
        expected_value: best.expected_value,
        confidence_tier: tier.confidence_tier,
        best_line_price: best.best_line_price,
        best_line_book_id: best.best_line_book_id,
        required_tier: tier.required_tier,
        result: 'pending' as const,
        visibility: 'live' as const,
      };

      const { data: existing, error: existingErr } = await supabase
        .from('picks')
        .select('id')
        .eq('game_id', g.id)
        .eq('market', 'moneyline')
        .maybeSingle();
      if (existingErr) {
        errors.push(`existing-pick lookup failed for ${g.id}: ${existingErr.message}`);
        continue;
      }

      if (existing) {
        const { error: upErr } = await supabase
          .from('picks')
          .update({
            pick_side: pickRow.pick_side,
            model_probability: pickRow.model_probability,
            implied_probability: pickRow.implied_probability,
            expected_value: pickRow.expected_value,
            confidence_tier: pickRow.confidence_tier,
            best_line_price: pickRow.best_line_price,
            best_line_book_id: pickRow.best_line_book_id,
            required_tier: pickRow.required_tier,
          })
          .eq('id', existing.id);
        if (upErr) errors.push(`update failed for ${g.id}: ${upErr.message}`);
        else picksUpdated += 1;
      } else {
        const { error: insErr } = await supabase.from('picks').insert(pickRow);
        if (insErr) errors.push(`insert failed for ${g.id}: ${insErr.message}`);
        else picksInserted += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`game ${g.id} threw: ${msg}`);
    }
  }

  const durationMs = Date.now() - start;
  console.info(JSON.stringify({
    level: errors.length > 0 ? 'warn' : 'info',
    event: 'pick_pipeline_complete',
    considered: games.length,
    feature_built: featureBuilt,
    skipped_no_anchor: skippedNoAnchor,
    skipped_no_best_price: skippedNoBestPrice,
    picks_inserted: picksInserted,
    picks_updated: picksUpdated,
    ev_floor_misses: evFloorMisses,
    error_count: errors.length,
    durationMs,
  }));

  return {
    considered: games.length,
    feature_built: featureBuilt,
    skipped_no_anchor: skippedNoAnchor,
    skipped_no_best_price: skippedNoBestPrice,
    picks_inserted: picksInserted,
    picks_updated: picksUpdated,
    ev_floor_misses: evFloorMisses,
    errors,
    durationMs,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/pick-pipeline' }));
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 },
    );
  }

  const handle = await startCronRun('pick-pipeline');
  console.info(JSON.stringify({ level: 'info', event: 'cron_pick_pipeline_start', time: new Date().toISOString() }));

  let body: PipelineResult;
  try {
    body = await runPickPipeline();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'cron_pick_pipeline_threw', error: msg }));
    await finishCronRun(handle, { status: 'failure', errorMsg: msg });
    return NextResponse.json(
      {
        considered: 0, feature_built: 0, skipped_no_anchor: 0,
        skipped_no_best_price: 0, picks_inserted: 0, picks_updated: 0,
        ev_floor_misses: 0, errors: [msg], durationMs: 0,
      },
      { status: 500 },
    );
  }

  const hadErrors = body.errors.length > 0;
  await finishCronRun(handle, {
    status: hadErrors ? 'failure' : 'success',
    errorMsg: hadErrors ? body.errors.join(' | ') : null,
  });

  return NextResponse.json(body, { status: hadErrors ? 207 : 200 });
}

export const POST = GET;
