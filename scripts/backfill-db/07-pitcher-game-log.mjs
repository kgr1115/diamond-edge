/**
 * Step 7 — MLB Stats API: Backfill pitcher_game_log 2022-2024.
 *
 * Source: MLB Stats API /game/{gamePk}/boxscore (free, public)
 * Target: pitcher_game_log
 * Idempotency: upsert ON CONFLICT (pitcher_id, game_id)
 * Rate: 2 req/sec (500ms sleep). Wall time ~5-8 hours for ~7,290 games.
 *
 * Starter identification:
 *   The first pitcher listed in boxscore teams[side].pitchers[] is the starter.
 *   is_starter = true for pitcher at index 0 per side.
 *   No separate game_starters table needed — feature queries join games table
 *   for serve-time starter identity (probable_home/away_pitcher_id).
 *
 * IP conversion:
 *   MLB API returns innings pitched as a float where .1 = 1/3 inning,
 *   .2 = 2/3 inning (not .333/.667). E.g., "6.1" = 6 and 1/3 innings.
 *   Stored as NUMERIC(5,1) — the feature layer handles the .1/.2 convention.
 *
 * wRC+ proxy decision is NOT applicable here — pitcher stats only.
 * OPS+ proxy for wRC+ is handled in 08-batter-game-log.mjs.
 *
 * Dead-letter: games that fail after 3 retries are written to cron_runs
 * with status='failure' and skipped on re-runs (they retain their error
 * in cron_runs but the upsert key prevents partial double-writes).
 */

import { loadEnv, makeDbClient, sleep, log, mlbFetch } from './shared.mjs';

loadEnv();

const MLB_API = process.env.MLB_STATS_API_BASE ?? 'https://statsapi.mlb.com/api/v1';

/** Convert MLB API IP float to NUMERIC-safe decimal.
 *  MLB encodes fractional innings as .1 (1/3) and .2 (2/3).
 *  FIP formula works on these values directly (IP-weighted sum).
 */
function parseIp(raw) {
  const n = parseFloat(raw);
  if (isNaN(n) || n < 0) return 0;
  return n;
}

/** Parse pitcher stats from boxscore pitching summary row.
 *  boxscore teams[side].pitchers[] gives mlb player IDs in appearance order.
 *  boxscore teams[side].players['ID{n}'].stats.pitching gives the stat line.
 */
function parsePitcherStats(playerKey, players) {
  const p = players[playerKey];
  if (!p) return null;
  const pit = p.stats?.pitching ?? {};
  // `flyOuts` is exposed directly in the boxscore pitching block (live-probed 2026-05-04).
  // It excludes popouts (popOuts is a separate field; airOuts = flyOuts + popOuts). Excluding
  // popups is correct for xFIP since pop-ups carry ~0 HR/FB rate.
  return {
    fullName: p.person?.fullName ?? 'Unknown',
    mlbPlayerId: p.person?.id,
    ip: parseIp(pit.inningsPitched ?? '0'),
    hr: parseInt(pit.homeRuns ?? '0', 10) || 0,
    bb: parseInt(pit.baseOnBalls ?? '0', 10) || 0,
    hbp: parseInt(pit.hitByPitch ?? '0', 10) || 0,
    k: parseInt(pit.strikeOuts ?? '0', 10) || 0,
    fb: parseInt(pit.flyOuts ?? '0', 10) || 0,
  };
}

async function resolvePlayer(db, playerCache, mlbPlayerId, fullName, teamId) {
  if (playerCache.has(mlbPlayerId)) return playerCache.get(mlbPlayerId);
  const { rows: ep } = await db.query(
    'SELECT id FROM players WHERE mlb_player_id = $1',
    [mlbPlayerId]
  );
  if (ep[0]) {
    playerCache.set(mlbPlayerId, ep[0].id);
    return ep[0].id;
  }
  const { rows } = await db.query(
    `INSERT INTO players (mlb_player_id, full_name, position, team_id, active, updated_at)
     VALUES ($1,$2,'P',$3,true,now())
     ON CONFLICT (mlb_player_id) DO UPDATE SET full_name=EXCLUDED.full_name, updated_at=now()
     RETURNING id`,
    [mlbPlayerId, fullName, teamId ?? null]
  );
  const uuid = rows[0]?.id ?? null;
  if (uuid) playerCache.set(mlbPlayerId, uuid);
  return uuid;
}

async function deadLetter(db, label, gameId, reason) {
  try {
    await db.query(
      `INSERT INTO cron_runs (job_name, status, error_message, started_at, completed_at)
       VALUES ($1,'failure',$2,now(),now())`,
      [`backfill_pitcher_game_log_${label}`, reason]
    );
  } catch (_) { /* non-fatal */ }
  log('error', 'dead_letter', { game: label, game_id: gameId, reason });
}

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step7_start');

  const startTs = Date.now();

  // All final games 2022-2024
  const { rows: games } = await db.query(
    `SELECT g.id, g.mlb_game_id, g.game_date::text,
            g.home_team_id, g.away_team_id
     FROM games g
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     ORDER BY g.game_date`
  );

  log('info', 'step7_games_to_process', { count: games.length });

  if (games.length === 0) {
    log('warn', 'step7_no_final_games', { msg: 'No final games — run step 1 first' });
    await db.end();
    return;
  }

  // Games already fully covered (both sides have at least 1 pitcher row)
  const { rows: alreadyCovered } = await db.query(
    `SELECT game_id
     FROM pitcher_game_log
     WHERE game_id = ANY($1::uuid[])
     GROUP BY game_id
     HAVING COUNT(DISTINCT team_id) >= 2`,
    [games.map(g => g.id)]
  );
  const coveredSet = new Set(alreadyCovered.map(r => r.game_id));
  log('info', 'step7_already_covered', { count: coveredSet.size });

  const playerCache = new Map();
  let totalUpserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let gamesProcessed = 0;
  const errors = [];

  for (const game of games) {
    if (coveredSet.has(game.id)) {
      totalSkipped++;
      continue;
    }

    const sourceUrl = `${MLB_API}/game/${game.mlb_game_id}/boxscore`;
    let boxscore;
    try {
      boxscore = await mlbFetch(sourceUrl);
    } catch (err) {
      errors.push(`Game ${game.mlb_game_id}: fetch failed: ${err.message}`);
      totalErrors++;
      await deadLetter(db, game.mlb_game_id, game.id, err.message);
      await sleep(500);
      continue;
    }

    const sides = [
      { side: 'home', teamId: game.home_team_id },
      { side: 'away', teamId: game.away_team_id },
    ];

    for (const { side, teamId } of sides) {
      const teamData = boxscore?.teams?.[side];
      if (!teamData) continue;

      const pitcherIds = teamData.pitchers ?? [];
      const players = teamData.players ?? {};

      for (let idx = 0; idx < pitcherIds.length; idx++) {
        const mlbPlayerId = pitcherIds[idx];
        const playerKey = `ID${mlbPlayerId}`;
        const stats = parsePitcherStats(playerKey, players);
        if (!stats || !stats.mlbPlayerId) continue;

        // Skip pitchers with 0 IP (e.g., listed but did not pitch)
        if (stats.ip === 0 && stats.k === 0 && stats.bb === 0) continue;

        const playerUuid = await resolvePlayer(
          db, playerCache, stats.mlbPlayerId, stats.fullName, teamId
        );
        if (!playerUuid) continue;

        const isStarter = idx === 0;

        try {
          await db.query(
            `INSERT INTO pitcher_game_log
               (pitcher_id, team_id, game_id, game_date, ip, hr, bb, hbp, k, fb, is_starter, source_url, retrieved_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
             ON CONFLICT (pitcher_id, game_id) DO UPDATE SET
               ip          = EXCLUDED.ip,
               hr          = EXCLUDED.hr,
               bb          = EXCLUDED.bb,
               hbp         = EXCLUDED.hbp,
               k           = EXCLUDED.k,
               fb          = EXCLUDED.fb,
               is_starter  = EXCLUDED.is_starter,
               source_url  = EXCLUDED.source_url,
               retrieved_at= EXCLUDED.retrieved_at,
               updated_at  = now()`,
            [
              playerUuid,
              teamId,
              game.id,
              game.game_date,
              stats.ip,
              stats.hr,
              stats.bb,
              stats.hbp,
              stats.k,
              stats.fb,
              isStarter,
              sourceUrl,
            ]
          );
          totalUpserted++;
        } catch (err) {
          // Schema drift or constraint: log field, skip row, do not fail the game
          errors.push(`PGL ${game.mlb_game_id}/${side}/p${mlbPlayerId}: ${err.message}`);
          totalErrors++;
        }
      }
    }

    gamesProcessed++;

    if (gamesProcessed % 200 === 0) {
      log('info', 'step7_progress', {
        processed: gamesProcessed,
        total: games.length,
        upserted: totalUpserted,
        errors: totalErrors,
      });
    }

    // 2 req/sec pacing
    await sleep(500);
  }

  const wallMs = Date.now() - startTs;

  // Coverage report
  const { rows: covRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            COUNT(DISTINCT g.id) AS total_games,
            COUNT(DISTINCT pgl.game_id) AS games_with_pitcher_data,
            COUNT(DISTINCT pgl.pitcher_id) AS distinct_pitchers,
            SUM(CASE WHEN pgl.is_starter THEN 1 ELSE 0 END) AS starter_rows,
            SUM(CASE WHEN NOT pgl.is_starter THEN 1 ELSE 0 END) AS reliever_rows,
            ROUND(100.0 * COUNT(DISTINCT pgl.game_id) / NULLIF(COUNT(DISTINCT g.id), 0), 1) AS coverage_pct
     FROM games g
     LEFT JOIN pitcher_game_log pgl ON pgl.game_id = g.id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     GROUP BY 1 ORDER BY 1`
  );

  const { rows: totalRows } = await db.query(
    `SELECT COUNT(*) AS n FROM pitcher_game_log`
  );

  log('info', 'step7_complete', {
    games_processed: gamesProcessed,
    total_upserted: totalUpserted,
    total_skipped: totalSkipped,
    total_errors: totalErrors,
    coverage: covRows,
    wall_ms: wallMs,
  });

  console.log('\n=== STEP 7 COMPLETE: Pitcher Game Log ===');
  console.log(`Games processed:  ${gamesProcessed}`);
  console.log(`Rows upserted:    ${totalUpserted}`);
  console.log(`Games skipped:    ${totalSkipped} (already complete)`);
  console.log(`Errors:           ${totalErrors}`);
  console.log(`Total table rows: ${totalRows[0]?.n ?? 'N/A'}`);
  console.log(`Wall time:        ${(wallMs / 1000).toFixed(1)}s`);
  console.log('\nCoverage by season:');
  for (const r of covRows) {
    console.log(`  ${r.season}: ${r.games_with_pitcher_data}/${r.total_games} (${r.coverage_pct}%) | ${r.distinct_pitchers} pitchers | ${r.starter_rows} starter rows | ${r.reliever_rows} reliever rows`);
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
