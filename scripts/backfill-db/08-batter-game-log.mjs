/**
 * Step 8 — MLB Stats API: Backfill batter_game_log 2022-2024.
 *
 * Source: MLB Stats API /game/{gamePk}/boxscore (free, public)
 * Target: batter_game_log
 * Idempotency: upsert ON CONFLICT (batter_id, game_id)
 * Rate: 2 req/sec (500ms sleep). Wall time ~5-8 hours for ~7,290 games.
 *
 * wRC+ proxy decision (v0, CEng-authorized):
 *   MLB Stats API does not return wRC+ directly. True wRC+ requires wOBA
 *   weights and park adjustments — high-effort for v0. Per feature spec
 *   authorization and task brief, this script uses OPS+ as a proxy.
 *
 *   OPS+ is available as seasonStats.opsPlus from the boxscore player object
 *   or from the season stats endpoint. However, the boxscore endpoint returns
 *   season-to-date stats for each player as of that game date, which is an
 *   acceptable rolling proxy. The value stored is the season-to-date OPS+ as
 *   of this game, weighted by PA when aggregating in the feature layer.
 *
 *   wrc_plus_source = 'ops_plus_proxy' is written for every row to make the
 *   substitution transparent to the feature layer and auditable in the model
 *   architecture.md.
 *
 *   Limitation: OPS+ is a season-cumulative stat, not a per-game value. Using
 *   it as a weight in a 30-day rolling window introduces mild look-ahead bias
 *   (the full-season OPS+ is not known at T-60 for early-season games). For
 *   v0, this is accepted as a known approximation. The feature spec notes this
 *   and mlb-feature-eng will handle the imputation boundary in the feature
 *   construction layer.
 *
 * PA parsing:
 *   MLB API boxscore per-player stats include atBats, walks, hitByPitch,
 *   sacrificeFlies, sacrificeHits which sum to plate appearances. PA is
 *   computed as: AB + BB + HBP + SF + SH + intentionalWalks (if not already
 *   included in BB). The simpler /boxscore endpoint returns summary stats;
 *   we use atBats + baseOnBalls + hitByPitch + sacrificeFlies + sacrificeHits.
 *
 * Dead-letter: same pattern as 07-pitcher-game-log.mjs.
 */

import { loadEnv, makeDbClient, sleep, log, mlbFetch } from './shared.mjs';

loadEnv();

const MLB_API = process.env.MLB_STATS_API_BASE ?? 'https://statsapi.mlb.com/api/v1';

/** Compute PA from batting stat components available in the boxscore. */
function computePa(batting) {
  if (!batting) return 0;
  const ab  = parseInt(batting.atBats        ?? '0', 10) || 0;
  const bb  = parseInt(batting.baseOnBalls   ?? '0', 10) || 0;
  const hbp = parseInt(batting.hitByPitch    ?? '0', 10) || 0;
  const sf  = parseInt(batting.sacFlies      ?? batting.sacrificeFlies ?? '0', 10) || 0;
  const sh  = parseInt(batting.sacBunts      ?? batting.sacrificeHits  ?? '0', 10) || 0;
  return ab + bb + hbp + sf + sh;
}

/** Extract OPS+ from player's season stats in the boxscore player object.
 *  Falls back to NULL if the field is absent (pitcher hitting, etc.).
 *  OPS+ = 100 × (OBP/lgOBP + SLG/lgSLG - 1), park-adjusted.
 *  MLB Stats API exposes this as seasonStats.ops or a computed opsPlus field.
 *  Practical note: the /boxscore endpoint frequently omits opsPlus from the
 *  seasonStats sub-object. When absent, we compute a simple OPS proxy from
 *  available components and leave wrc_plus as NULL for that row — the feature
 *  layer imputes from team average per the feature spec null handling rule.
 */
function parseOpsPlus(playerObj) {
  const ss = playerObj?.seasonStats?.batting ?? playerObj?.seasonStats ?? {};
  // opsPlus when present (integer, 100 = average)
  if (ss.opsPlus != null) return parseInt(ss.opsPlus, 10) || null;
  // fallback: MLB API sometimes puts it as 'ops' (raw OPS string like '.854')
  // We can't convert raw OPS to OPS+ without league constants, so return null.
  return null;
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
     VALUES ($1,$2,'POS',$3,true,now())
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
      [`backfill_batter_game_log_${label}`, reason]
    );
  } catch (_) { /* non-fatal */ }
  log('error', 'dead_letter', { game: label, game_id: gameId, reason });
}

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step8_start');

  const startTs = Date.now();

  const { rows: games } = await db.query(
    `SELECT g.id, g.mlb_game_id, g.game_date::text,
            g.home_team_id, g.away_team_id
     FROM games g
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     ORDER BY g.game_date`
  );

  log('info', 'step8_games_to_process', { count: games.length });

  if (games.length === 0) {
    log('warn', 'step8_no_final_games', { msg: 'No final games — run step 1 first' });
    await db.end();
    return;
  }

  // Games already fully covered: at least 16 batter rows (some games have DH, pinch hitters)
  // Use 16 as the floor (9 + 9 - 2 for possible joint boxscore edge cases)
  const { rows: alreadyCovered } = await db.query(
    `SELECT game_id
     FROM batter_game_log
     WHERE game_id = ANY($1::uuid[])
     GROUP BY game_id
     HAVING COUNT(*) >= 16`,
    [games.map(g => g.id)]
  );
  const coveredSet = new Set(alreadyCovered.map(r => r.game_id));
  log('info', 'step8_already_covered', { count: coveredSet.size });

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

      // batters[] is the batting-order array of mlb player IDs
      const batterIds = teamData.batters ?? [];
      const players   = teamData.players ?? {};

      for (const mlbPlayerId of batterIds) {
        const playerKey = `ID${mlbPlayerId}`;
        const playerObj = players[playerKey];
        if (!playerObj) continue;

        const batting = playerObj?.stats?.batting;
        const pa = computePa(batting);

        // Skip pitchers / players with no plate appearances at all
        if (pa === 0 && !batting?.atBats) continue;

        const fullName = playerObj?.person?.fullName ?? 'Unknown';
        const playerUuid = await resolvePlayer(db, playerCache, mlbPlayerId, fullName, teamId);
        if (!playerUuid) continue;

        const wrcPlus = parseOpsPlus(playerObj);

        try {
          await db.query(
            `INSERT INTO batter_game_log
               (batter_id, team_id, game_id, game_date, pa, wrc_plus, wrc_plus_source, source_url, retrieved_at)
             VALUES ($1,$2,$3,$4,$5,$6,'ops_plus_proxy',$7,now())
             ON CONFLICT (batter_id, game_id) DO UPDATE SET
               pa              = EXCLUDED.pa,
               wrc_plus        = EXCLUDED.wrc_plus,
               wrc_plus_source = EXCLUDED.wrc_plus_source,
               source_url      = EXCLUDED.source_url,
               retrieved_at    = EXCLUDED.retrieved_at,
               updated_at      = now()`,
            [
              playerUuid,
              teamId,
              game.id,
              game.game_date,
              pa,
              wrcPlus,  // may be null; feature layer imputes
              sourceUrl,
            ]
          );
          totalUpserted++;
        } catch (err) {
          // Schema drift: log and skip the row, do not fail the game
          errors.push(`BGL ${game.mlb_game_id}/${side}/b${mlbPlayerId}: ${err.message}`);
          totalErrors++;
        }
      }
    }

    gamesProcessed++;

    if (gamesProcessed % 200 === 0) {
      log('info', 'step8_progress', {
        processed: gamesProcessed,
        total: games.length,
        upserted: totalUpserted,
        errors: totalErrors,
      });
    }

    // 2 req/sec pacing — note: this script shares the boxscore endpoint with
    // step 7. If both run in parallel, halve the sleep to avoid double-pacing.
    // Recommended: run steps 7 and 8 sequentially (they hit the same endpoint).
    await sleep(500);
  }

  const wallMs = Date.now() - startTs;

  const { rows: covRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            COUNT(DISTINCT g.id) AS total_games,
            COUNT(DISTINCT bgl.game_id) AS games_with_batter_data,
            COUNT(DISTINCT bgl.batter_id) AS distinct_batters,
            COUNT(*) AS total_rows,
            COUNT(*) FILTER (WHERE bgl.wrc_plus IS NULL) AS null_wrc_plus_rows,
            ROUND(100.0 * COUNT(DISTINCT bgl.game_id) / NULLIF(COUNT(DISTINCT g.id), 0), 1) AS coverage_pct
     FROM games g
     LEFT JOIN batter_game_log bgl ON bgl.game_id = g.id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     GROUP BY 1 ORDER BY 1`
  );

  const { rows: totalRows } = await db.query(
    `SELECT COUNT(*) AS n FROM batter_game_log`
  );

  log('info', 'step8_complete', {
    games_processed: gamesProcessed,
    total_upserted: totalUpserted,
    total_skipped: totalSkipped,
    total_errors: totalErrors,
    coverage: covRows,
    wall_ms: wallMs,
  });

  console.log('\n=== STEP 8 COMPLETE: Batter Game Log ===');
  console.log(`Games processed:  ${gamesProcessed}`);
  console.log(`Rows upserted:    ${totalUpserted}`);
  console.log(`Games skipped:    ${totalSkipped} (already complete)`);
  console.log(`Errors:           ${totalErrors}`);
  console.log(`Total table rows: ${totalRows[0]?.n ?? 'N/A'}`);
  console.log(`Wall time:        ${(wallMs / 1000).toFixed(1)}s`);
  console.log('\nCoverage by season:');
  for (const r of covRows) {
    console.log(`  ${r.season}: ${r.games_with_batter_data}/${r.total_games} (${r.coverage_pct}%) | ${r.distinct_batters} batters | ${r.total_rows} rows | ${r.null_wrc_plus_rows} null wrc_plus`);
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
