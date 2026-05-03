/**
 * CLV (Closing Line Value) writer.
 *
 * Reads picks that don't yet have a `pick_clv` row, looks up the closing
 * snapshot from `odds WHERE closing_snapshot = true` (migration 0026),
 * computes the no-vig closing probability via the proportional method, and
 * writes one row per pick to `pick_clv`.
 *
 * Per migration 0011 the formula is:
 *   clv_edge = closing_novig_prob - pick_time_novig_prob
 * Positive `clv_edge` means the line moved toward our side after pick
 * generation (a real-edge signal).
 *
 * `pick_time_novig_prob` is sourced from `picks.implied_probability` —
 * already de-vigged at pick generation time (see picks schema 0005).
 *
 * Vig-removal: no shared helper exists in `apps/web/lib/`. The proportional
 * method is used here for v0:
 *   home_novig = home_implied / (home_implied + away_implied)
 * If a shared helper is introduced later, swap `proportionalNovig` for it.
 *
 * Eligibility:
 *   - Skip picks whose game is postponed/cancelled/suspended — voided by the
 *     outcome-grader; CLV is meaningless there.
 *   - Skip picks where `picks.implied_probability` is NULL — log warn,
 *     no row inserted (cannot compute clv_edge without it).
 *   - Picks whose game is final but no closing snapshot exists are still
 *     written: `closing_novig_prob` and `clv_edge` set to NULL so the
 *     downstream gate can distinguish "no signal" from "negative signal".
 *
 * RLS: `pick_clv` policy is `USING (false) WITH CHECK (false)`; only the
 * service-role client can write. Caller MUST pass the service-role client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { impliedProb } from '@/lib/picks/line-movement';
import { pickClvFrom, type PickClvInsert } from '@/lib/types/pick-clv';

export interface ClvComputeResult {
  considered: number;
  written: number;
  skippedNoImplied: number;
  skippedVoidGame: number;
  noClosingSnapshot: number;
  errors: string[];
  durationMs: number;
}

const VOID_STATUSES = ['postponed', 'cancelled', 'suspended'] as const;

interface PickRow {
  id: string;
  game_id: string;
  market: string;
  pick_side: string;
  implied_probability: number | null;
  best_line_book_id: string | null;
  games: { status: string };
}

interface ClosingSnapshotRow {
  game_id: string;
  sportsbook_id: string;
  market: string;
  home_price: number | null;
  away_price: number | null;
  over_price: number | null;
  under_price: number | null;
}

/**
 * Proportional no-vig conversion. Given two raw implied probs that sum to
 * >1 because of the bookmaker's overround, scale each so they sum to 1.
 * Returns the no-vig prob for the LEFT side.
 */
function proportionalNovig(leftImplied: number, rightImplied: number): number {
  const total = leftImplied + rightImplied;
  if (total <= 0) return 0;
  return leftImplied / total;
}

/**
 * Closing no-vig prob for the pick side given the snapshot row.
 * Returns null if the relevant prices are absent for the market.
 */
function closingNovigForPickSide(
  market: string,
  pickSide: string,
  snapshot: ClosingSnapshotRow,
): number | null {
  if (market === 'moneyline' || market === 'run_line') {
    if (snapshot.home_price === null || snapshot.away_price === null) return null;
    const homeImplied = impliedProb(snapshot.home_price);
    const awayImplied = impliedProb(snapshot.away_price);
    if (pickSide === 'home') return proportionalNovig(homeImplied, awayImplied);
    if (pickSide === 'away') return proportionalNovig(awayImplied, homeImplied);
    return null;
  }
  if (market === 'total') {
    if (snapshot.over_price === null || snapshot.under_price === null) return null;
    const overImplied = impliedProb(snapshot.over_price);
    const underImplied = impliedProb(snapshot.under_price);
    if (pickSide === 'over') return proportionalNovig(overImplied, underImplied);
    if (pickSide === 'under') return proportionalNovig(underImplied, overImplied);
    return null;
  }
  return null;
}

/**
 * Pick the closing snapshot best aligned with the pick. Prefers the same
 * sportsbook the pick was generated against; falls back to any book's
 * closing snapshot for the same (game, market).
 */
function chooseSnapshot(
  candidates: ClosingSnapshotRow[],
  preferredBookId: string | null,
): ClosingSnapshotRow | null {
  if (candidates.length === 0) return null;
  if (preferredBookId) {
    const sameBook = candidates.find((c) => c.sportsbook_id === preferredBookId);
    if (sameBook) return sameBook;
  }
  return candidates[0];
}

export async function runClvCompute(): Promise<ClvComputeResult> {
  const startMs = Date.now();
  const errors: string[] = [];

  const supabase = createServiceRoleClient();

  // Eligibility query: picks that don't yet have a pick_clv row.
  // PostgREST cannot express "anti-join" directly — fetch existing pick_ids
  // first and exclude. Bounded by `pick_clv` size (one row per pick once written).
  const { data: existingClvRows, error: existingErr } = await pickClvFrom(supabase)
    .select('pick_id');
  if (existingErr) {
    const msg = `pick_clv read failed: ${existingErr.message}`;
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_existing_read_failed', error: msg }));
    return {
      considered: 0, written: 0, skippedNoImplied: 0, skippedVoidGame: 0,
      noClosingSnapshot: 0, errors: [msg], durationMs: Date.now() - startMs,
    };
  }
  const alreadyComputed = new Set(((existingClvRows ?? []) as Array<{ pick_id: string }>).map((r) => r.pick_id));

  const { data: picksData, error: picksErr } = await supabase
    .from('picks')
    .select(`
      id, game_id, market, pick_side, implied_probability, best_line_book_id,
      games!inner ( status )
    `);

  if (picksErr) {
    const msg = `picks read failed: ${picksErr.message}`;
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_picks_read_failed', error: msg }));
    return {
      considered: 0, written: 0, skippedNoImplied: 0, skippedVoidGame: 0,
      noClosingSnapshot: 0, errors: [msg], durationMs: Date.now() - startMs,
    };
  }

  const picks = ((picksData ?? []) as unknown as PickRow[]).filter((p) => !alreadyComputed.has(p.id));

  console.info(JSON.stringify({
    level: 'info',
    event: 'clv_compute_picks_loaded',
    candidate_count: picks.length,
    already_computed: alreadyComputed.size,
  }));

  if (picks.length === 0) {
    const durationMs = Date.now() - startMs;
    console.info(JSON.stringify({ level: 'info', event: 'clv_compute_complete', written: 0, durationMs }));
    return {
      considered: 0, written: 0, skippedNoImplied: 0, skippedVoidGame: 0,
      noClosingSnapshot: 0, errors: [], durationMs,
    };
  }

  // Bulk-load closing snapshots for the relevant (game_id, market) pairs.
  const gameIds = Array.from(new Set(picks.map((p) => p.game_id)));
  const markets = Array.from(new Set(picks.map((p) => p.market)));

  // The `closing_snapshot` column was added in migration 0026 after the
  // last `supabase gen types` run; cast to a loose client so the query
  // type-checks until types are regenerated. Same pattern as pickClvFrom.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oddsLoose = (supabase as SupabaseClient<any>).from('odds');
  const { data: snapshotData, error: snapshotErr } = await oddsLoose
    .select('game_id, sportsbook_id, market, home_price, away_price, over_price, under_price')
    .eq('closing_snapshot', true)
    .in('game_id', gameIds)
    .in('market', markets);

  if (snapshotErr) {
    const msg = `closing snapshot read failed: ${snapshotErr.message}`;
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_snapshot_read_failed', error: msg }));
    return {
      considered: picks.length, written: 0, skippedNoImplied: 0, skippedVoidGame: 0,
      noClosingSnapshot: 0, errors: [msg], durationMs: Date.now() - startMs,
    };
  }

  const snapshots = (snapshotData ?? []) as unknown as ClosingSnapshotRow[];
  const snapshotsByKey = new Map<string, ClosingSnapshotRow[]>();
  for (const s of snapshots) {
    const key = `${s.game_id}::${s.market}`;
    if (!snapshotsByKey.has(key)) snapshotsByKey.set(key, []);
    snapshotsByKey.get(key)!.push(s);
  }

  const rowsToUpsert: PickClvInsert[] = [];
  let skippedNoImplied = 0;
  let skippedVoidGame = 0;
  let noClosingSnapshot = 0;

  for (const pick of picks) {
    if ((VOID_STATUSES as readonly string[]).includes(pick.games.status)) {
      skippedVoidGame += 1;
      continue;
    }

    if (pick.implied_probability === null) {
      skippedNoImplied += 1;
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'clv_compute_skip_null_implied',
        pick_id: pick.id,
        market: pick.market,
      }));
      continue;
    }

    const candidates = snapshotsByKey.get(`${pick.game_id}::${pick.market}`) ?? [];
    const snapshot = chooseSnapshot(candidates, pick.best_line_book_id);

    let closingNovig: number | null = null;
    if (snapshot) {
      closingNovig = closingNovigForPickSide(pick.market, pick.pick_side, snapshot);
    }

    if (closingNovig === null) {
      noClosingSnapshot += 1;
    }

    const pickTimeNovig = Number(pick.implied_probability);
    const clvEdge = closingNovig === null ? null : closingNovig - pickTimeNovig;

    rowsToUpsert.push({
      pick_id: pick.id,
      pick_time_novig_prob: pickTimeNovig,
      closing_novig_prob: closingNovig,
      clv_edge: clvEdge,
      computed_at: new Date().toISOString(),
    });
  }

  let written = 0;
  if (rowsToUpsert.length > 0) {
    const { error: upsertErr } = await pickClvFrom(supabase).upsert(rowsToUpsert, { onConflict: 'pick_id' });
    if (upsertErr) {
      const msg = `pick_clv upsert failed: ${upsertErr.message}`;
      console.error(JSON.stringify({ level: 'error', event: 'clv_compute_upsert_failed', error: msg, batch: rowsToUpsert.length }));
      errors.push(msg);
    } else {
      written = rowsToUpsert.length;
    }
  }

  const durationMs = Date.now() - startMs;

  console.info(JSON.stringify({
    level: errors.length > 0 ? 'warn' : 'info',
    event: 'clv_compute_complete',
    considered: picks.length,
    written,
    skipped_no_implied: skippedNoImplied,
    skipped_void_game: skippedVoidGame,
    no_closing_snapshot: noClosingSnapshot,
    errors: errors.length,
    durationMs,
  }));

  return {
    considered: picks.length,
    written,
    skippedNoImplied,
    skippedVoidGame,
    noClosingSnapshot,
    errors,
    durationMs,
  };
}
