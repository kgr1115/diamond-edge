/**
 * Step 2 — Open-Meteo Historical Archive: Backfill weather for 2022-2024 games.
 *
 * Source: https://archive-api.open-meteo.com/v1/archive (free, no auth)
 * Target: games.weather_temp_f, weather_wind_mph, weather_wind_dir (numeric degrees), weather_condition
 * Rate limit: 10,000 calls/day. ~7,290 games across 3 seasons = well within limit.
 * Idempotency: skip games where weather_wind_dir IS NOT NULL (already populated).
 *
 * weather_wind_dir stores raw numeric degrees (0-360 as string), NOT compass/field labels.
 * This matches the live weather client patch (2026-04-30).
 */

import { loadEnv, makeDbClient, sleep, log } from './shared.mjs';

loadEnv();

// Full stadium coordinate map (from apps/web/lib/ingestion/weather/stadiums.ts)
const STADIUMS = {
  'Yankee Stadium':              { lat: 40.8296, lon: -73.9262 },
  'Fenway Park':                 { lat: 42.3467, lon: -71.0972 },
  'Oriole Park at Camden Yards': { lat: 39.2838, lon: -76.6218 },
  'Tropicana Field':             { lat: 27.7683, lon: -82.6534 },
  'Rogers Centre':               { lat: 43.6414, lon: -79.3894 },
  'Guaranteed Rate Field':       { lat: 41.8300, lon: -87.6339 },
  'Progressive Field':           { lat: 41.4954, lon: -81.6854 },
  'Comerica Park':               { lat: 42.3390, lon: -83.0485 },
  'Target Field':                { lat: 44.9817, lon: -93.2781 },
  'Kauffman Stadium':            { lat: 39.0517, lon: -94.4803 },
  'Minute Maid Park':            { lat: 29.7572, lon: -95.3552 },
  'Angel Stadium':               { lat: 33.8003, lon: -117.8827 },
  'Oakland Coliseum':            { lat: 37.7516, lon: -122.2007 },
  'T-Mobile Park':               { lat: 47.5914, lon: -122.3326 },
  'Globe Life Field':            { lat: 32.7473, lon: -97.0831 },
  'Citizens Bank Park':          { lat: 39.9061, lon: -75.1665 },
  'Citi Field':                  { lat: 40.7571, lon: -73.8458 },
  'Nationals Park':              { lat: 38.8730, lon: -77.0074 },
  'Truist Park':                 { lat: 33.8907, lon: -84.4677 },
  'loanDepot park':              { lat: 25.7781, lon: -80.2195 },
  'Wrigley Field':               { lat: 41.9484, lon: -87.6553 },
  'American Family Field':       { lat: 43.0280, lon: -87.9712 },
  'PNC Park':                    { lat: 40.4469, lon: -80.0057 },
  'Great American Ball Park':    { lat: 39.0975, lon: -84.5086 },
  'Busch Stadium':               { lat: 38.6226, lon: -90.1928 },
  'Dodger Stadium':              { lat: 34.0739, lon: -118.2400 },
  'Oracle Park':                 { lat: 37.7786, lon: -122.3893 },
  'Chase Field':                 { lat: 33.4453, lon: -112.0667 },
  'Coors Field':                 { lat: 39.7559, lon: -104.9942 },
  'Petco Park':                  { lat: 32.7076, lon: -117.1570 },
  // Dome venues (still fetched; park_factor_runs.is_dome=true causes view to output 0)
  'Sutter Health Park':          { lat: 38.5802, lon: -121.5005 },
  'LoanDepot Park':              { lat: 25.7781, lon: -80.2195 },
};

// Dome venues — we still fetch weather for records but game_wind_features view zeroes wind
const DOMES = new Set([
  'Tropicana Field',
  'Rogers Centre',
  'Chase Field',
  'Minute Maid Park',
  'American Family Field',
]);

const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const DAILY_CAP = 10000;
const CALLS_PAUSE_THRESHOLD = 8000; // log warning if we approach cap

function wmoCodeToCondition(code) {
  if (code === 0) return 'clear';
  if (code <= 3) return 'partly cloudy';
  if (code <= 9) return 'foggy';
  if (code <= 19) return 'drizzle';
  if (code <= 29) return 'rain';
  if (code <= 39) return 'snow';
  if (code <= 49) return 'foggy';
  if (code <= 59) return 'drizzle';
  if (code <= 69) return 'rain';
  if (code <= 79) return 'snow';
  if (code <= 82) return 'rain';
  if (code <= 86) return 'snow';
  if (code <= 94) return 'thunderstorm';
  return 'thunderstorm';
}

async function fetchWeather(lat, lon, gameDate, gameTimeUtc) {
  const url = new URL(OPEN_METEO_ARCHIVE);
  url.searchParams.set('latitude', lat.toString());
  url.searchParams.set('longitude', lon.toString());
  url.searchParams.set('start_date', gameDate);
  url.searchParams.set('end_date', gameDate);
  url.searchParams.set('hourly', 'temperature_2m,weathercode,windspeed_10m,winddirection_10m');
  url.searchParams.set('temperature_unit', 'fahrenheit');
  url.searchParams.set('windspeed_unit', 'mph');
  url.searchParams.set('timezone', 'UTC');

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'DiamondEdge/1.0 (backfill)' },
    });
  } catch (err) {
    return null;
  }

  if (!res.ok) {
    // Retry once after 10s
    await sleep(10000);
    try {
      res = await fetch(url.toString(), { headers: { 'User-Agent': 'DiamondEdge/1.0 (backfill)' } });
    } catch {
      return null;
    }
    if (!res.ok) return null;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  if (!data?.hourly?.time?.length) return null;

  // Find the hour index closest to game time
  const gameHourUtc = gameTimeUtc.slice(0, 13); // 'YYYY-MM-DDTHH'
  let hourIndex = data.hourly.time.findIndex(t => t.startsWith(gameHourUtc));
  if (hourIndex < 0) hourIndex = 0;

  const temp_f = data.hourly.temperature_2m[hourIndex] ?? null;
  const wmoCode = data.hourly.weathercode[hourIndex] ?? 0;
  const windSpeed = data.hourly.windspeed_10m[hourIndex] ?? null;
  const windDir = data.hourly.winddirection_10m[hourIndex] ?? null;

  return {
    condition: wmoCodeToCondition(wmoCode),
    temp_f: temp_f !== null ? Math.round(temp_f) : null,
    wind_mph: windSpeed !== null ? Math.round(windSpeed) : null,
    wind_dir: windDir !== null ? String(Math.round(windDir)) : null,
  };
}

async function main() {
  const db = makeDbClient();
  await db.connect();
  log('info', 'step2_start');

  const startTs = Date.now();

  // Fetch all games 2022-2024 that need weather
  const { rows: games } = await db.query(
    `SELECT id, mlb_game_id, game_date::text, game_time_utc::text, venue_name,
            weather_wind_dir
     FROM games
     WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
       AND status IN ('final', 'cancelled', 'postponed', 'scheduled')
     ORDER BY game_date`
  );

  const total = games.length;
  let updated = 0;
  let skipped = 0;
  let missing_venue = 0;
  let fetch_null = 0;
  let callCount = 0;
  const errors = [];

  log('info', 'step2_games_to_process', {
    total,
    already_have_wind_dir: games.filter(g => g.weather_wind_dir !== null).length,
  });

  for (const game of games) {
    // Idempotency: skip if already has numeric wind_dir
    if (game.weather_wind_dir !== null && /^\d+$/.test(game.weather_wind_dir)) {
      skipped++;
      continue;
    }

    if (!game.venue_name) {
      missing_venue++;
      continue;
    }

    const coords = STADIUMS[game.venue_name];
    if (!coords) {
      // Unknown venue — log once, skip
      if (!errors.find(e => e.includes(game.venue_name))) {
        errors.push(`Unknown venue: ${game.venue_name} (game ${game.mlb_game_id})`);
      }
      missing_venue++;
      continue;
    }

    if (callCount >= CALLS_PAUSE_THRESHOLD) {
      log('warn', 'step2_approaching_daily_cap', { callCount, DAILY_CAP });
    }

    const weather = await fetchWeather(
      coords.lat,
      coords.lon,
      game.game_date,
      game.game_time_utc ?? `${game.game_date}T23:00:00Z`
    );
    callCount++;

    if (!weather) {
      fetch_null++;
      log('warn', 'step2_weather_null', { game_id: game.id, mlb_game_id: game.mlb_game_id });
      continue;
    }

    await db.query(
      `UPDATE games
       SET weather_condition = $1,
           weather_temp_f = $2,
           weather_wind_mph = $3,
           weather_wind_dir = $4,
           updated_at = now()
       WHERE id = $5`,
      [weather.condition, weather.temp_f, weather.wind_mph, weather.wind_dir, game.id]
    );
    updated++;

    // Progress log every 500 games
    if (updated % 500 === 0) {
      log('info', 'step2_progress', {
        updated,
        skipped,
        missing_venue,
        fetch_null,
        calls: callCount,
      });
    }

    // 60 req/min = 1s/req — stay well within daily cap
    await sleep(1000);
  }

  // Verify no field-relative strings remain
  const { rows: badWindDir } = await db.query(
    `SELECT COUNT(*) AS n FROM games
     WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
       AND weather_wind_dir IS NOT NULL
       AND weather_wind_dir !~ '^\\d+$'`
  );
  const badCount = parseInt(badWindDir[0].n, 10);

  const wallMs = Date.now() - startTs;

  log('info', 'step2_complete', {
    total,
    updated,
    skipped,
    missing_venue,
    fetch_null,
    api_calls: callCount,
    bad_wind_dir_format: badCount,
    wall_ms: wallMs,
    errors,
  });

  console.log('\n=== STEP 2 COMPLETE: Weather ===');
  console.log(`Games in range:  ${total}`);
  console.log(`Updated:         ${updated}`);
  console.log(`Skipped (had data): ${skipped}`);
  console.log(`Missing venue:   ${missing_venue}`);
  console.log(`Fetch returned null: ${fetch_null}`);
  console.log(`API calls made:  ${callCount} / ${DAILY_CAP} daily cap`);
  console.log(`Bad wind_dir format remaining: ${badCount} (expected: 0)`);
  console.log(`Wall time:       ${(wallMs / 1000).toFixed(1)}s`);
  if (errors.length > 0) {
    console.error(`\nErrors/warnings (${errors.length}):`);
    errors.slice(0, 20).forEach(e => console.error(`  ${e}`));
    if (errors.length > 20) console.error(`  ... and ${errors.length - 20} more`);
  }

  await db.end();
  if (badCount > 0 || errors.length > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
