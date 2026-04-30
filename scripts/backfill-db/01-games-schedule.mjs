/**
 * Step 1 — MLB Stats API: Backfill 2022-2024 regular season games into `games` table.
 *
 * Source: MLB Stats API /schedule endpoint (free, public)
 * Cadence: one-time backfill
 * Idempotency: upsert ON CONFLICT mlb_game_id
 *
 * One call per season retrieves the full regular-season schedule.
 * Expected rows: ~2,430/season × 3 = ~7,290
 */

import { loadEnv, makeDbClient, sleep, log, mlbFetch, mapGameStatus, VENUE_STATES } from './shared.mjs';

loadEnv();

const SEASONS = [
  { year: 2022, start: '2022-04-07', end: '2022-11-05' },
  { year: 2023, start: '2023-03-30', end: '2023-11-02' },
  { year: 2024, start: '2024-03-28', end: '2024-10-31' },
];

const MLB_API = process.env.MLB_STATS_API_BASE ?? 'https://statsapi.mlb.com/api/v1';

async function upsertTeam(db, ref) {
  const safeName = ref.name ?? '';
  const parts = safeName.split(' ');
  const city = parts.length > 1 ? parts.slice(0, -1).join(' ') : safeName;
  const abbr = (ref.abbreviation ?? safeName.slice(0, 3) ?? 'UNK').toUpperCase().slice(0, 3);
  const { rows } = await db.query(
    `INSERT INTO teams (mlb_team_id, name, abbreviation, city, division, league, updated_at)
     VALUES ($1,$2,$3,$4,'Unknown','AL',now())
     ON CONFLICT (mlb_team_id) DO UPDATE SET name=EXCLUDED.name, updated_at=now()
     RETURNING id`,
    [ref.id, safeName, abbr, city]
  );
  return rows[0]?.id ?? null;
}

async function upsertPitcher(db, pitcher, teamUuid) {
  const { rows } = await db.query(
    `INSERT INTO players (mlb_player_id, full_name, position, team_id, active, updated_at)
     VALUES ($1,$2,'SP',$3,true,now())
     ON CONFLICT (mlb_player_id) DO UPDATE SET full_name=EXCLUDED.full_name, updated_at=now()
     RETURNING id`,
    [pitcher.id, pitcher.fullName, teamUuid ?? null]
  );
  return rows[0]?.id ?? null;
}

function parseWeather(w) {
  if (!w) return null;
  const temp_f = w.temp ? parseInt(w.temp, 10) : null;
  const windMatch = w.wind?.match(/^(\d+)\s*mph/i);
  const wind_mph = windMatch ? parseInt(windMatch[1], 10) : null;
  return {
    condition: w.condition?.toLowerCase() ?? null,
    temp_f: isNaN(temp_f) ? null : temp_f,
    wind_mph: isNaN(wind_mph) ? null : wind_mph,
  };
}

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step1_start', { seasons: SEASONS.map(s => s.year) });

  const startTs = Date.now();
  let totalUpserted = 0;
  let totalSkipped = 0;
  const errors = [];

  const { rows: existingTeams } = await db.query('SELECT id, mlb_team_id FROM teams');
  const teamCache = new Map(existingTeams.map(t => [t.mlb_team_id, t.id]));
  log('info', 'step1_team_cache_loaded', { count: teamCache.size });

  for (const season of SEASONS) {
    log('info', 'step1_season_start', { year: season.year });

    const url = `${MLB_API}/schedule?sportId=1&gameType=R&startDate=${season.start}&endDate=${season.end}&hydrate=team,venue,probablePitcher(note),weather,linescore`;

    let scheduleResp;
    try {
      scheduleResp = await mlbFetch(url);
    } catch (err) {
      errors.push(`Season ${season.year} fetch failed: ${err.message}`);
      continue;
    }

    const allGames = (scheduleResp.dates ?? []).flatMap(d => d.games ?? []);
    log('info', 'step1_season_fetched', { year: season.year, games: allGames.length });

    if (allGames.length === 0) {
      errors.push(`Season ${season.year}: zero games — check date range`);
      continue;
    }

    // Resolve missing teams
    const missingTeamIds = [...new Set(
      allGames.flatMap(g => [g.teams?.home?.team?.id, g.teams?.away?.team?.id]).filter(Boolean)
    )].filter(id => !teamCache.has(id));

    for (const mlbId of missingTeamIds) {
      const game = allGames.find(g =>
        g.teams?.home?.team?.id === mlbId || g.teams?.away?.team?.id === mlbId
      );
      const side = game?.teams?.home?.team?.id === mlbId ? 'home' : 'away';
      const ref = { id: mlbId, ...game?.teams?.[side]?.team };
      const uuid = await upsertTeam(db, ref);
      if (uuid) teamCache.set(mlbId, uuid);
    }

    // Resolve probable pitchers
    const pitcherCache = new Map();
    const pitcherMlbIds = [...new Set(
      allGames.flatMap(g => [
        g.teams?.home?.probablePitcher?.id,
        g.teams?.away?.probablePitcher?.id,
      ]).filter(Boolean)
    )];

    if (pitcherMlbIds.length > 0) {
      const { rows: ep } = await db.query(
        'SELECT id, mlb_player_id FROM players WHERE mlb_player_id = ANY($1)',
        [pitcherMlbIds]
      );
      ep.forEach(p => pitcherCache.set(p.mlb_player_id, p.id));

      for (const pid of pitcherMlbIds.filter(id => !pitcherCache.has(id))) {
        const game = allGames.find(g =>
          g.teams?.home?.probablePitcher?.id === pid ||
          g.teams?.away?.probablePitcher?.id === pid
        );
        const side = game?.teams?.home?.probablePitcher?.id === pid ? 'home' : 'away';
        const pitcher = game?.teams?.[side]?.probablePitcher;
        if (!pitcher) continue;
        const teamUuid = teamCache.get(game.teams[side].team.id) ?? null;
        const uuid = await upsertPitcher(db, pitcher, teamUuid);
        if (uuid) pitcherCache.set(pitcher.id, uuid);
      }
    }

    // Upsert games one by one (season fetch is one round-trip; individual upserts are cheap)
    for (const game of allGames) {
      if (!game.gameDate) { totalSkipped++; continue; }
      const homeId = teamCache.get(game.teams?.home?.team?.id);
      const awayId = teamCache.get(game.teams?.away?.team?.id);
      if (!homeId || !awayId) {
        errors.push(`Game ${game.gamePk}: team UUID missing`);
        totalSkipped++;
        continue;
      }

      const venueName = game.venue?.name ?? null;
      const venueState = venueName ? (VENUE_STATES[venueName] ?? null) : null;
      const weather = parseWeather(game.weather);
      const status = mapGameStatus(
        game.status ?? { abstractGameState: 'Preview', detailedState: 'Scheduled' }
      );
      const homeScore = game.teams?.home?.score ?? game.linescore?.teams?.home?.runs ?? null;
      const awayScore = game.teams?.away?.score ?? game.linescore?.teams?.away?.runs ?? null;
      const homePitcherId = game.teams?.home?.probablePitcher
        ? (pitcherCache.get(game.teams.home.probablePitcher.id) ?? null)
        : null;
      const awayPitcherId = game.teams?.away?.probablePitcher
        ? (pitcherCache.get(game.teams.away.probablePitcher.id) ?? null)
        : null;

      await db.query(
        `INSERT INTO games (
           mlb_game_id, game_date, game_time_utc, status,
           home_team_id, away_team_id,
           home_score, away_score, inning,
           venue_name, venue_state,
           weather_condition, weather_temp_f, weather_wind_mph, weather_wind_dir,
           probable_home_pitcher_id, probable_away_pitcher_id,
           updated_at
         ) VALUES ($1,$2,$3,$4::game_status,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
         ON CONFLICT (mlb_game_id) DO UPDATE SET
           game_date = EXCLUDED.game_date,
           game_time_utc = EXCLUDED.game_time_utc,
           status = EXCLUDED.status,
           home_score = EXCLUDED.home_score,
           away_score = EXCLUDED.away_score,
           inning = EXCLUDED.inning,
           venue_name = EXCLUDED.venue_name,
           venue_state = EXCLUDED.venue_state,
           weather_condition = EXCLUDED.weather_condition,
           weather_temp_f = EXCLUDED.weather_temp_f,
           weather_wind_mph = EXCLUDED.weather_wind_mph,
           probable_home_pitcher_id = EXCLUDED.probable_home_pitcher_id,
           probable_away_pitcher_id = EXCLUDED.probable_away_pitcher_id,
           updated_at = now()`,
        [
          game.gamePk,
          game.gameDate.slice(0, 10),
          game.gameDate,
          status,
          homeId,
          awayId,
          typeof homeScore === 'number' ? homeScore : null,
          typeof awayScore === 'number' ? awayScore : null,
          game.linescore?.currentInning ?? null,
          venueName,
          venueState,
          weather?.condition ?? null,
          weather?.temp_f ?? null,
          weather?.wind_mph ?? null,
          null, // weather_wind_dir: Open-Meteo fills this in step 2
          homePitcherId,
          awayPitcherId,
        ]
      );
      totalUpserted++;
    }

    log('info', 'step1_season_done', {
      year: season.year,
      upserted: totalUpserted,
      errors_so_far: errors.length,
    });
    await sleep(500);
  }

  // Backfill divisional_flag for any teams that now have correct division
  await db.query(`
    UPDATE games g
    SET divisional_flag = true
    FROM teams ht, teams at
    WHERE ht.id = g.home_team_id
      AND at.id = g.away_team_id
      AND ht.division = at.division
      AND ht.division != 'Unknown'
  `);

  const wallMs = Date.now() - startTs;
  const { rows: countRows } = await db.query(
    `SELECT EXTRACT(YEAR FROM game_date)::int AS season, COUNT(*) AS n
     FROM games WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
     GROUP BY 1 ORDER BY 1`
  );

  log('info', 'step1_complete', {
    total_upserted: totalUpserted,
    total_skipped: totalSkipped,
    wall_ms: wallMs,
    season_counts: countRows,
    errors,
  });

  console.log('\n=== STEP 1 COMPLETE: MLB Schedule ===');
  console.log(`Rows upserted: ${totalUpserted}`);
  console.log(`Rows skipped:  ${totalSkipped}`);
  console.log(`Wall time:     ${(wallMs / 1000).toFixed(1)}s`);
  console.log('Season counts:');
  for (const r of countRows) console.log(`  ${r.season}: ${r.n} games`);
  if (errors.length > 0) {
    console.error(`\nErrors (${errors.length}):`);
    errors.forEach(e => console.error(`  ${e}`));
    process.exitCode = 1;
  }

  await db.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
