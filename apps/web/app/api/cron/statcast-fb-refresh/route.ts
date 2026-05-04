import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const maxDuration = 180;

/**
 * Vercel Cron handler: GET /api/cron/statcast-fb-refresh
 * Scheduled: 11:00 UTC daily (07:00 ET).
 *
 * Refreshes pitcher_game_log.fb (total flyballs) for yesterday's starters using
 * Baseball Savant pitch-by-pitch CSV bb_type='fly_ball' aggregation. Replaces the
 * MLB-boxscore-flyOuts source (outs-only, semantically wrong for FanGraphs xFIP).
 *
 * Scope: yesterday's starters only (is_starter = true). Reliever fb backfill is
 * handled offline by scripts/backfill-db/09-pitcher-fb-statcast.mjs.
 *
 * Source proposal: docs/proposals/statcast-fb-ingestion-2026-05-04.yaml
 *
 * Security: CRON_SECRET bearer required. Vercel Cron auto-adds the header.
 */

const SAVANT_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';
const REQ_INTERVAL_MS = 3000;
const FETCH_RETRIES = 3;

interface SavantPair {
  pitcher_id: string;
  mlb_player_id: number;
  game_id: string;
  mlb_game_id: number;
}

function buildSavantUrl(mlbPlayerId: number, dateIso: string): string {
  const params = new URLSearchParams({
    all: 'true',
    game_date_gt: dateIso,
    game_date_lt: dateIso,
    player_type: 'pitcher',
    type: 'details',
    min_pitches: '0',
    min_results: '0',
    min_pas: '0',
    group_by: 'name',
    sort_col: 'pitches',
    sort_order: 'desc',
  });
  params.append('pitchers_lookup[]', String(mlbPlayerId));
  return `${SAVANT_BASE}?${params.toString()}`;
}

function parseCsv(text: string): Array<Record<string, string>> {
  if (!text || !text.trim()) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  const out: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue;
    const obj: Record<string, string> = {};
    for (let h = 0; h < header.length; h++) obj[header[h]] = cells[h] ?? '';
    out.push(obj);
  }
  return out;
}

async function savantFetch(url: string, label: string): Promise<string> {
  let lastErr = new Error('unknown');
  let backoffMs = 5000;
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, Math.min(backoffMs, 60000)));
      backoffMs *= 2;
    }
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'DiamondEdge/1.0 (statcast-fb-refresh)' } });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(JSON.stringify({ level: 'warn', event: 'statcast_fb_fetch_network_error', label, attempt, err: lastErr.message }));
      continue;
    }
    if (res.status === 429) {
      console.warn(JSON.stringify({ level: 'warn', event: 'statcast_fb_fetch_429', label, attempt }));
      lastErr = new Error('429');
      continue;
    }
    if (res.status >= 500) {
      console.warn(JSON.stringify({ level: 'warn', event: 'statcast_fb_fetch_5xx', label, status: res.status, attempt }));
      lastErr = new Error(`5xx:${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`Savant ${res.status}`);
    return res.text();
  }
  throw lastErr;
}

function aggregateFlyBalls(rows: Array<Record<string, string>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if ((row.bb_type ?? '').trim() !== 'fly_ball') continue;
    const gamePk = (row.game_pk ?? '').trim();
    if (!gamePk) continue;
    counts.set(gamePk, (counts.get(gamePk) ?? 0) + 1);
  }
  return counts;
}

function yesterdayUtcIsoDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/statcast-fb-refresh' }));
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 },
    );
  }

  const runHandle = await startCronRun('statcast-fb-refresh');
  const startMs = Date.now();
  const yesterday = yesterdayUtcIsoDate();
  console.info(JSON.stringify({ level: 'info', event: 'cron_statcast_fb_refresh_start', yesterday, time: new Date().toISOString() }));

  // Loose-typed client: pitcher_game_log isn't in Database (matches moneyline-v0.ts convention).
  const supabase: SupabaseClient = createServiceRoleClient() as unknown as SupabaseClient;

  // Step 1: yesterday's final games.
  const { data: games, error: gamesErr } = await supabase
    .from('games')
    .select('id, mlb_game_id')
    .eq('game_date', yesterday)
    .eq('status', 'final');

  if (gamesErr) {
    const msg = gamesErr.message;
    console.error(JSON.stringify({ level: 'error', event: 'statcast_fb_games_query_failed', error: msg }));
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json({ error: { code: 'DB_ERROR', message: msg } }, { status: 500 });
  }

  const gameRows = (games ?? []) as Array<{ id: string; mlb_game_id: number }>;
  const gameIdToMlb = new Map(gameRows.map(g => [g.id, g.mlb_game_id]));
  const gameIds = gameRows.map(g => g.id);

  if (gameIds.length === 0) {
    const durationMs = Date.now() - startMs;
    console.info(JSON.stringify({ level: 'info', event: 'statcast_fb_no_final_games', yesterday, durationMs }));
    await finishCronRun(runHandle, { status: 'success', errorMsg: null });
    return NextResponse.json({ ok: true, yesterday, pitchers_processed: 0, rows_updated: 0, durationMs }, { status: 200 });
  }

  // Step 2: starters in those games, joined to players for mlb_player_id.
  const { data: rawPairs, error: pairsErr } = await supabase
    .from('pitcher_game_log')
    .select('pitcher_id, game_id, players!inner(mlb_player_id)')
    .eq('is_starter', true)
    .in('game_id', gameIds);

  if (pairsErr) {
    const msg = pairsErr.message;
    console.error(JSON.stringify({ level: 'error', event: 'statcast_fb_pairs_query_failed', error: msg }));
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json({ error: { code: 'DB_ERROR', message: msg } }, { status: 500 });
  }

  type PairRow = {
    pitcher_id: string;
    game_id: string;
    players: { mlb_player_id: number } | { mlb_player_id: number }[] | null;
  };

  const pairs: SavantPair[] = ((rawPairs ?? []) as PairRow[])
    .map(r => {
      const player = Array.isArray(r.players) ? r.players[0] : r.players;
      const mlbGameId = gameIdToMlb.get(r.game_id);
      if (!player || mlbGameId === undefined) return null;
      return {
        pitcher_id: r.pitcher_id,
        mlb_player_id: player.mlb_player_id,
        game_id: r.game_id,
        mlb_game_id: mlbGameId,
      } satisfies SavantPair;
    })
    .filter((p): p is SavantPair => p !== null);

  console.info(JSON.stringify({ level: 'info', event: 'statcast_fb_pairs_loaded', count: pairs.length, yesterday }));

  if (pairs.length === 0) {
    // No starters for yesterday — off-day, or stats-sync hasn't populated rows yet.
    // Either way: clean exit, no Savant calls, no DB writes.
    const durationMs = Date.now() - startMs;
    await finishCronRun(runHandle, { status: 'success', errorMsg: null });
    return NextResponse.json({ ok: true, yesterday, pitchers_processed: 0, rows_updated: 0, durationMs }, { status: 200 });
  }

  let pitchersProcessed = 0;
  let rowsUpdated = 0;
  let errors = 0;
  const errorMessages: string[] = [];

  for (const pair of pairs) {
    const label = `${pair.mlb_player_id}_${yesterday}`;
    const url = buildSavantUrl(pair.mlb_player_id, yesterday);

    let csvText: string;
    try {
      csvText = await savantFetch(url, label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors++;
      errorMessages.push(`fetch ${label}: ${msg}`);
      console.warn(JSON.stringify({ level: 'warn', event: 'statcast_fb_fetch_failed', label, error: msg }));
      await new Promise(r => setTimeout(r, REQ_INTERVAL_MS));
      continue;
    }

    const rows = parseCsv(csvText);

    if (rows.length > 0 && !('bb_type' in rows[0])) {
      const cols = Object.keys(rows[0]).slice(0, 20).join(',');
      const msg = `bb_type column missing — got: ${cols}`;
      errors++;
      errorMessages.push(`schema ${label}: ${msg}`);
      console.warn(JSON.stringify({ level: 'warn', event: 'statcast_fb_schema_drift', label, columns: cols }));
      await new Promise(r => setTimeout(r, REQ_INTERVAL_MS));
      continue;
    }

    const fbByGamePk = aggregateFlyBalls(rows);
    const fbCount = fbByGamePk.get(String(pair.mlb_game_id)) ?? 0;

    const { error: updErr, count } = await supabase
      .from('pitcher_game_log')
      .update({ fb: fbCount, fb_source: 'statcast_bb_type_v1', updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('pitcher_id', pair.pitcher_id)
      .eq('game_id', pair.game_id);

    if (updErr) {
      errors++;
      errorMessages.push(`update ${label}: ${updErr.message}`);
      console.warn(JSON.stringify({ level: 'warn', event: 'statcast_fb_update_failed', label, error: updErr.message }));
    } else if ((count ?? 0) > 0) {
      rowsUpdated += count ?? 0;
    }

    pitchersProcessed++;
    await new Promise(r => setTimeout(r, REQ_INTERVAL_MS));
  }

  const durationMs = Date.now() - startMs;
  const ok = errors === 0;
  console.info(JSON.stringify({
    level: ok ? 'info' : 'warn',
    event: 'cron_statcast_fb_refresh_complete',
    yesterday,
    pitchers_processed: pitchersProcessed,
    rows_updated: rowsUpdated,
    errors,
    durationMs,
  }));

  await finishCronRun(runHandle, {
    status: ok ? 'success' : 'failure',
    errorMsg: ok ? null : errorMessages.slice(0, 3).join(' | '),
  });

  return NextResponse.json(
    { ok, yesterday, pitchers_processed: pitchersProcessed, rows_updated: rowsUpdated, errors, durationMs },
    { status: ok ? 200 : 207 },
  );
}

export const POST = GET;
