/**
 * Step 9 — Baseball Savant: re-backfill pitcher_game_log.fb (total flyballs).
 *
 * Source: Baseball Savant statcast_search CSV
 *   https://baseballsavant.mlb.com/statcast_search/csv?type=details&player_type=pitcher
 *     &pitchers_lookup[]={mlb_player_id}&hfSea={year}|&min_pitches=0&min_results=0&min_pas=0
 *
 * Why this exists: migration 0030 added pitcher_game_log.fb sourced from MLB boxscore
 * pitching.flyOuts (outs-on-flyballs only). FanGraphs xFIP needs total flyballs (all
 * outcomes — outs, hits, HRs). Savant's pitch-by-pitch CSV exposes bb_type per batted
 * ball; aggregating bb_type='fly_ball' rows per (pitcher_id, game_pk) gives the right
 * count.
 *
 * Target: pitcher_game_log.fb + fb_source (after migration 0031)
 * Update mode: UPDATE only (rows must already exist from 07-pitcher-game-log.mjs).
 *              The companion surgery in 07-pitcher-game-log.mjs removes the boxscore
 *              flyOuts parse — only this script and the daily cron write fb going forward.
 *
 * Rate: 1 req / 3 s (conservative; Savant has shown lower tolerance than MLB API).
 *       ~2,000 (pitcher, season) requests across 2021-2024 → ~100 min net + parse/DB ≈ 2.5h.
 *
 * Idempotency: re-runs are safe. Re-fetching the same (pitcher, season) and re-aggregating
 *              produces identical counts; UPDATE ... WHERE pitcher_id, game_id is keyed.
 *
 * Dead-letter: any pitcher-season that fails after 5 retries lands in cron_runs with
 *              status='failure' and is skipped — does NOT abort the whole batch.
 *
 * Source proposal: docs/proposals/statcast-fb-ingestion-2026-05-04.yaml
 */

import { loadEnv, makeDbClient, sleep, log } from './shared.mjs';

loadEnv();

const SAVANT_BASE = 'https://baseballsavant.mlb.com/statcast_search/csv';
const REQ_INTERVAL_MS = 3000;
const SEASONS = [2021, 2022, 2023, 2024];

// Savant sits behind Cloudflare bot detection — a bespoke UA returns 403.
// A recent Chrome UA passes (same trick pybaseball uses).
const SAVANT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Build a Savant CSV URL for one (pitcher, season). */
function buildSavantUrl(mlbPlayerId, season) {
  const params = new URLSearchParams({
    all: 'true',
    hfSea: `${season}|`,
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

/** Minimal RFC 4180 CSV parser. Returns array of row objects keyed by header.
 *  Handles quoted fields with embedded commas and escaped double-quotes ("").
 */
function parseCsv(text) {
  if (!text || !text.trim()) return [];
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      // Skip; handled by \n on the next iteration if CRLF.
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Trailing field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue;
    const obj = {};
    for (let h = 0; h < header.length; h++) {
      obj[header[h]] = cells[h] ?? '';
    }
    out.push(obj);
  }
  return out;
}

/** Aggregate bb_type='fly_ball' rows by game_pk for a single pitcher.
 *  Returns Map<game_pk_string, fly_ball_count>. */
function aggregateFlyBalls(rows) {
  const counts = new Map();
  for (const row of rows) {
    if ((row.bb_type ?? '').trim() !== 'fly_ball') continue;
    const gamePk = (row.game_pk ?? '').trim();
    if (!gamePk) continue;
    counts.set(gamePk, (counts.get(gamePk) ?? 0) + 1);
  }
  return counts;
}

/** Fetch with exponential backoff for 429/5xx. Throws on terminal failure. */
async function savantFetch(url, label, maxAttempts = 5) {
  let lastErr = new Error('unknown');
  let backoffMs = 5000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(backoffMs, 120000));
      backoffMs *= 2;
    }
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': SAVANT_UA } });
    } catch (err) {
      lastErr = err;
      log('warn', 'savant_fetch_network_error', { label, attempt, err: err.message });
      continue;
    }
    if (res.status === 429) {
      log('warn', 'savant_fetch_429', { label, attempt });
      lastErr = new Error('429');
      continue;
    }
    if (res.status >= 500) {
      log('warn', 'savant_fetch_5xx', { label, status: res.status, attempt });
      lastErr = new Error(`5xx:${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`Savant ${res.status}: ${url}`);
    return res.text();
  }
  throw lastErr;
}

async function deadLetter(db, label, reason) {
  try {
    await db.query(
      `INSERT INTO cron_runs (job_name, status, error_msg, started_at, finished_at)
       VALUES ($1,'failure',$2,now(),now())`,
      [`backfill_statcast_fb_${label}`, reason.slice(0, 500)]
    );
  } catch (_) { /* non-fatal */ }
  log('error', 'dead_letter', { label, reason });
}

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step9_start', { seasons: SEASONS });

  const startTs = Date.now();

  // Distinct (mlb_player_id, season) pairs we need to refresh.
  // Source: every pitcher_game_log row for a final game in the target seasons.
  const { rows: pairs } = await db.query(
    `SELECT DISTINCT
       p.mlb_player_id,
       p.full_name,
       EXTRACT(YEAR FROM g.game_date)::int AS season
     FROM pitcher_game_log pgl
     JOIN players p ON p.id = pgl.pitcher_id
     JOIN games g   ON g.id = pgl.game_id
     WHERE EXTRACT(YEAR FROM g.game_date) = ANY($1::int[])
       AND g.status = 'final'
       AND p.mlb_player_id IS NOT NULL
     ORDER BY season, p.mlb_player_id`,
    [SEASONS]
  );

  log('info', 'step9_pairs_to_process', { count: pairs.length });

  if (pairs.length === 0) {
    log('warn', 'step9_no_pairs', { msg: 'No pitcher_game_log rows in target seasons — run step 7 first' });
    await db.end();
    return;
  }

  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let pairsProcessed = 0;
  let savantRequests = 0;
  const errors = [];

  for (const pair of pairs) {
    const label = `${pair.mlb_player_id}_${pair.season}`;
    const url = buildSavantUrl(pair.mlb_player_id, pair.season);

    let csvText;
    try {
      csvText = await savantFetch(url, label);
      savantRequests++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Savant fetch ${label}: ${msg}`);
      totalErrors++;
      await deadLetter(db, label, msg);
      // Pace even on failure to keep cadence consistent
      await sleep(REQ_INTERVAL_MS);
      continue;
    }

    let rows;
    try {
      rows = parseCsv(csvText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Savant parse ${label}: ${msg}`);
      totalErrors++;
      await deadLetter(db, label, `parse_error: ${msg}`);
      await sleep(REQ_INTERVAL_MS);
      continue;
    }

    // Schema-drift sentinel: if bb_type is absent on every row, the column was renamed
    // or the endpoint returned an unexpected shape. Log and skip.
    if (rows.length > 0 && !('bb_type' in rows[0])) {
      const cols = Object.keys(rows[0]).slice(0, 20).join(',');
      const msg = `bb_type column missing — got: ${cols}`;
      errors.push(`Savant schema drift ${label}: ${msg}`);
      totalErrors++;
      await deadLetter(db, label, msg);
      await sleep(REQ_INTERVAL_MS);
      continue;
    }

    const fbByGamePk = aggregateFlyBalls(rows);

    // For each (game_pk, fb_count), update the matching pitcher_game_log row.
    // Match: players.mlb_player_id → pgl.pitcher_id; games.mlb_game_id → pgl.game_id.
    let upserted = 0;
    for (const [gamePk, fbCount] of fbByGamePk) {
      try {
        const { rowCount } = await db.query(
          `UPDATE pitcher_game_log AS pgl
             SET fb = $1,
                 fb_source = 'statcast_bb_type_v1',
                 updated_at = now()
           FROM players AS p, games AS g
           WHERE pgl.pitcher_id = p.id
             AND pgl.game_id = g.id
             AND p.mlb_player_id = $2
             AND g.mlb_game_id = $3`,
          [fbCount, pair.mlb_player_id, parseInt(gamePk, 10)]
        );
        if (rowCount > 0) upserted++;
      } catch (err) {
        errors.push(`PGL update ${label}/g${gamePk}: ${err.message}`);
        totalErrors++;
      }
    }
    totalUpdated += upserted;
    if (fbByGamePk.size === 0) totalSkipped++;
    pairsProcessed++;

    if (pairsProcessed % 50 === 0) {
      log('info', 'step9_progress', {
        processed: pairsProcessed,
        total: pairs.length,
        updated: totalUpdated,
        errors: totalErrors,
        savant_requests: savantRequests,
      });
    }

    // Pace next request
    await sleep(REQ_INTERVAL_MS);
  }

  const wallMs = Date.now() - startTs;

  // Coverage report: rows where fb_source landed at the new value, by season
  const { rows: covRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            COUNT(*) AS total_rows,
            SUM(CASE WHEN pgl.fb_source = 'statcast_bb_type_v1' THEN 1 ELSE 0 END) AS statcast_rows,
            SUM(CASE WHEN pgl.fb_source = 'mlb_boxscore_flyouts' THEN 1 ELSE 0 END) AS legacy_rows,
            ROUND(100.0 * SUM(CASE WHEN pgl.fb_source = 'statcast_bb_type_v1' THEN 1 ELSE 0 END)
                  / NULLIF(COUNT(*), 0), 1) AS statcast_pct
     FROM pitcher_game_log pgl
     JOIN games g ON g.id = pgl.game_id
     WHERE EXTRACT(YEAR FROM g.game_date) = ANY($1::int[])
       AND g.status = 'final'
     GROUP BY 1
     ORDER BY 1`,
    [SEASONS]
  );

  log('info', 'step9_complete', {
    pairs_processed: pairsProcessed,
    total_updated: totalUpdated,
    total_skipped_empty: totalSkipped,
    total_errors: totalErrors,
    savant_requests: savantRequests,
    coverage: covRows,
    wall_ms: wallMs,
  });

  console.log('\n=== STEP 9 COMPLETE: Statcast fb backfill ===');
  console.log(`Pairs processed:    ${pairsProcessed} / ${pairs.length}`);
  console.log(`Rows updated:       ${totalUpdated}`);
  console.log(`Pairs with 0 FB:    ${totalSkipped}`);
  console.log(`Errors:             ${totalErrors}`);
  console.log(`Savant requests:    ${savantRequests}`);
  console.log(`Wall time:          ${(wallMs / 1000 / 60).toFixed(1)} min`);
  console.log('\nCoverage by season:');
  for (const r of covRows) {
    console.log(`  ${r.season}: ${r.statcast_rows}/${r.total_rows} (${r.statcast_pct}%) statcast | ${r.legacy_rows} legacy`);
  }
  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length} — first 20):`);
    errors.slice(0, 20).forEach(e => console.error(`  ${e}`));
    process.exitCode = 1;
  }

  await db.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
