/**
 * Weather client — fetches forecast data for MLB game venues.
 *
 * Source: Open-Meteo (https://api.open-meteo.com)
 * Cost: Free, no API key required.
 * Rate limit: Not documented; 1 call per venue per sync run is well within limits.
 *
 * Usage:
 *   Called by the schedule-sync job to populate games.weather_* columns for
 *   games where the MLB Stats API does not yet have weather data (typically
 *   tomorrow's games and early schedule lookups).
 *
 * Freshness:
 *   Weather is fetched once per schedule-sync run. The schedule-sync runs 2x/day.
 *   For games <24h out, weather is also available from the MLB Stats API directly
 *   via the schedule hydration endpoint (handled in schedule.ts).
 */

import { OPEN_METEO_BASE } from '@/lib/ingestion/config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VenueCoordinates {
  name: string;
  lat: number;
  lon: number;
}

export interface GameWeather {
  condition: string | null;
  temp_f: number | null;
  wind_mph: number | null;
  wind_dir: string | null;
}

// ---------------------------------------------------------------------------
// Open-Meteo response types
// ---------------------------------------------------------------------------

interface OpenMeteoHourly {
  time: string[];
  temperature_2m: number[];
  weathercode: number[];
  windspeed_10m: number[];
  winddirection_10m: number[];
}

interface OpenMeteoResponse {
  hourly: OpenMeteoHourly;
}

// ---------------------------------------------------------------------------
// WMO weather interpretation codes → human-readable condition string
// https://open-meteo.com/en/docs#weathervariables
// ---------------------------------------------------------------------------

function wmoCodeToCondition(code: number): string {
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
  if (code <= 84) return 'snow';
  if (code <= 86) return 'heavy snow';
  if (code <= 94) return 'thunderstorm';
  return 'thunderstorm';
}

// degreesToWindDir removed — weather_wind_dir stores raw numeric degrees (0–360,
// Open-Meteo winddirection_10m convention) as a string. Feature construction
// handles compass/stadium-relative derivation downstream.

/**
 * Fetch weather forecast for a venue at a specific UTC game time.
 *
 * @param venue   - Venue name + lat/lon
 * @param gameTimeUtc - ISO 8601 UTC string, e.g. '2026-04-22T23:10:00Z'
 * @returns Weather conditions at game time, or all-null if unavailable
 */
export async function fetchVenueWeather(
  venue: VenueCoordinates,
  gameTimeUtc: string
): Promise<GameWeather> {
  const nullResult: GameWeather = {
    condition: null,
    temp_f: null,
    wind_mph: null,
    wind_dir: null,
  };

  try {
    const gameDate = gameTimeUtc.slice(0, 10); // 'YYYY-MM-DD'

    const url = new URL(`${OPEN_METEO_BASE}/forecast`);
    url.searchParams.set('latitude', venue.lat.toString());
    url.searchParams.set('longitude', venue.lon.toString());
    url.searchParams.set('hourly', 'temperature_2m,weathercode,windspeed_10m,winddirection_10m');
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('windspeed_unit', 'mph');
    url.searchParams.set('start_date', gameDate);
    url.searchParams.set('end_date', gameDate);
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('forecast_days', '1');

    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'DiamondEdge/1.0 (MLB picks app)' },
    });

    if (!response.ok) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'weather_fetch_error',
          venue: venue.name,
          status: response.status,
        })
      );
      return nullResult;
    }

    const data: OpenMeteoResponse = await response.json();
    if (!data?.hourly?.time?.length) return nullResult;

    // Find the hour index closest to game time
    const gameHourUtc = gameTimeUtc.slice(0, 13); // 'YYYY-MM-DDTHH'
    const hourIndex = data.hourly.time.findIndex(t => t.startsWith(gameHourUtc));
    const idx = hourIndex >= 0 ? hourIndex : 0; // Fall back to first hour if exact match not found

    const temp_f = data.hourly.temperature_2m[idx] ?? null;
    const wmoCode = data.hourly.weathercode[idx] ?? 0;
    const windSpeed = data.hourly.windspeed_10m[idx] ?? null;
    const windDir = data.hourly.winddirection_10m[idx] ?? null;

    return {
      condition: wmoCodeToCondition(wmoCode),
      temp_f: temp_f !== null ? Math.round(temp_f) : null,
      wind_mph: windSpeed !== null ? Math.round(windSpeed) : null,
      wind_dir: windDir !== null ? String(Math.round(windDir)) : null,
    };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'weather_fetch_exception',
        venue: venue.name,
        err: err instanceof Error ? err.message : String(err),
      })
    );
    return nullResult;
  }
}
