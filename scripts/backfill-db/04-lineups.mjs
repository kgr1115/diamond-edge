/**
 * Step 4 — MLB Stats API: Backfill historical lineups 2022-2024.
 *
 * Source: MLB Stats API /game/{gamePk}/boxscore (free, public)
 * Target: lineup_entries
 * Idempotency: skip games with >= 18 lineup entries already present.
 * Rate: 2 req/sec. Wall time: ~6 hours for ~7,290 games (2 calls/game).
 *
 * Historical training note:
 *   MLB Stats API stores the actual batting order from the boxscore, not
 *   the T-60min pin. For training data this is acceptable — it is the actual
 *   lineup that played. The T-60min pin requirement applies only to serve-time
 *   feature construction. pinned_at is set to game_time_utc - 60min as an
 *   approximation for feature-layer use.
 *
 * Only inserts 'final' games — postponed/cancelled games have no boxscore.
 */

import { loadEnv, makeDbClient, sleep, log, mlbFetch } from './shared.mjs';

loadEnv();

const MLB_API = process.env.MLB_STATS_API_BASE ?? 'https://statsapi.mlb.com/api/v1';

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step4_start');

  const startTs = Date.now();

  // Fetch all final games 2022-2024
  const { rows: games } = await db.query(
    `SELECT g.id, g.mlb_game_id, g.game_time_utc::text,
            g.home_team_id, g.away_team_id
     FROM games g
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     ORDER BY g.game_date`
  );

  log('info', 'step4_games_to_process', { count: games.length });

  if (games.length === 0) {
    log('warn', 'step4_no_final_games', { msg: 'No final games found — run step 1 first' });
    await db.end();
    return;
  }

  // Games that already have full lineups
  const { rows: alreadyFull } = await db.query(
    `SELECT game_id FROM lineup_entries
     WHERE game_id = ANY($1::uuid[])
     GROUP BY game_id
     HAVING COUNT(*) >= 18`,
    [games.map(g => g.id)]
  );
  const fullSet = new Set(alreadyFull.map(r => r.game_id));
  log('info', 'step4_already_complete', { count: fullSet.size });

  // Player resolution cache
  const playerCache = new Map();

  async function resolvePlayer(mlbPlayerId, fullName, teamId) {
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

  let totalUpserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let gamesProcessed = 0;
  const errors = [];

  for (const game of games) {
    if (fullSet.has(game.id)) {
      totalSkipped++;
      continue;
    }

    // Fetch boxscore
    let boxscore;
    try {
      boxscore = await mlbFetch(
        `${MLB_API}/game/${game.mlb_game_id}/boxscore`
      );
    } catch (err) {
      errors.push(`Game ${game.mlb_game_id}: boxscore fetch failed: ${err.message}`);
      totalErrors++;
      await sleep(500);
      continue;
    }

    // Parse batting orders for home and away
    const sides = [
      { side: 'home', teamId: game.home_team_id },
      { side: 'away', teamId: game.away_team_id },
    ];

    let gameInserted = 0;

    for (const { side, teamId } of sides) {
      const teamData = boxscore?.teams?.[side];
      if (!teamData) continue;

      // batters: array of mlb_player_id in batting order
      const batters = teamData.batters ?? [];
      const players = teamData.players ?? {};

      for (let i = 0; i < batters.length && i < 9; i++) {
        const mlbPlayerId = batters[i];
        const playerKey = `ID${mlbPlayerId}`;
        const playerInfo = players[playerKey]?.person ?? { id: mlbPlayerId, fullName: 'Unknown' };
        const batSide = players[playerKey]?.person?.batSide?.code ?? null;

        const playerUuid = await resolvePlayer(
          playerInfo.id,
          playerInfo.fullName,
          teamId
        );
        if (!playerUuid) continue;

        // pinned_at = game_time_utc - 60 min (approximation for training data)
        const pinnedAt = game.game_time_utc
          ? new Date(new Date(game.game_time_utc).getTime() - 60 * 60 * 1000).toISOString()
          : null;

        try {
          await db.query(
            `INSERT INTO lineup_entries (game_id, team_id, batting_order, player_id, bat_side, confirmed, pinned_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,true,$6,now())
             ON CONFLICT (game_id, team_id, batting_order) DO UPDATE SET
               player_id = EXCLUDED.player_id,
               bat_side = EXCLUDED.bat_side,
               confirmed = true,
               pinned_at = COALESCE(lineup_entries.pinned_at, EXCLUDED.pinned_at),
               updated_at = now()`,
            [game.id, teamId, i + 1, playerUuid, batSide, pinnedAt]
          );
          gameInserted++;
          totalUpserted++;
        } catch (err) {
          errors.push(`Lineup ${game.mlb_game_id}/${side}/pos${i+1}: ${err.message}`);
          totalErrors++;
        }
      }
    }

    gamesProcessed++;

    if (gamesProcessed % 200 === 0) {
      log('info', 'step4_progress', {
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

  // Coverage check
  const { rows: covRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
            COUNT(DISTINCT g.id) AS total_games,
            COUNT(DISTINCT le.game_id) AS games_with_lineups,
            ROUND(100.0 * COUNT(DISTINCT le.game_id) / NULLIF(COUNT(DISTINCT g.id),0), 1) AS pct
     FROM games g
     LEFT JOIN (
       SELECT game_id FROM lineup_entries GROUP BY game_id HAVING COUNT(*) >= 18
     ) le ON le.game_id = g.id
     WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
       AND g.status = 'final'
     GROUP BY 1 ORDER BY 1`
  );

  log('info', 'step4_complete', {
    games_processed: gamesProcessed,
    total_upserted: totalUpserted,
    total_skipped: totalSkipped,
    total_errors: totalErrors,
    coverage: covRows,
    wall_ms: wallMs,
  });

  console.log('\n=== STEP 4 COMPLETE: Lineups ===');
  console.log(`Games processed:  ${gamesProcessed}`);
  console.log(`Rows upserted:    ${totalUpserted}`);
  console.log(`Games skipped:    ${totalSkipped} (already complete)`);
  console.log(`Errors:           ${totalErrors}`);
  console.log(`Wall time:        ${(wallMs / 1000).toFixed(1)}s`);
  console.log('\nCoverage by season:');
  for (const r of covRows) {
    console.log(`  ${r.season}: ${r.games_with_lineups}/${r.total_games} final games (${r.pct}%)`);
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
