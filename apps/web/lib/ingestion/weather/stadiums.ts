/**
 * MLB stadium coordinates and state codes.
 * Used for:
 *   1. Weather API lookups (lat/lon → Open-Meteo forecast)
 *   2. Venue state assignment on game rows (venue_state column)
 *
 * Key = venue name as returned by MLB Stats API venue.name field.
 * These are the canonical names from the API — do not abbreviate.
 *
 * Coordinates sourced from public records. State code is the ISO 3166-2
 * US state code (2 letters), used for display and compliance checks.
 */

export interface StadiumInfo {
  lat: number;
  lon: number;
  state: string; // 2-letter state code
}

export const STADIUMS: Record<string, StadiumInfo> = {
  // AL East
  'Yankee Stadium':              { lat: 40.8296, lon: -73.9262, state: 'NY' },
  'Fenway Park':                 { lat: 42.3467, lon: -71.0972, state: 'MA' },
  'Oriole Park at Camden Yards': { lat: 39.2838, lon: -76.6218, state: 'MD' },
  'Tropicana Field':             { lat: 27.7683, lon: -82.6534, state: 'FL' },
  'Rogers Centre':               { lat: 43.6414, lon: -79.3894, state: 'ON' }, // Canada

  // AL Central
  'Guaranteed Rate Field':       { lat: 41.8300, lon: -87.6339, state: 'IL' },
  'Progressive Field':           { lat: 41.4954, lon: -81.6854, state: 'OH' },
  'Comerica Park':               { lat: 42.3390, lon: -83.0485, state: 'MI' },
  'Target Field':                { lat: 44.9817, lon: -93.2781, state: 'MN' },
  'Kauffman Stadium':            { lat: 39.0517, lon: -94.4803, state: 'MO' },

  // AL West
  'Minute Maid Park':            { lat: 29.7572, lon: -95.3552, state: 'TX' },
  'Angel Stadium':               { lat: 33.8003, lon: -117.8827, state: 'CA' },
  'Oakland Coliseum':            { lat: 37.7516, lon: -122.2007, state: 'CA' },
  'T-Mobile Park':               { lat: 47.5914, lon: -122.3326, state: 'WA' },
  'Globe Life Field':            { lat: 32.7473, lon: -97.0831, state: 'TX' },

  // NL East
  'Citizens Bank Park':          { lat: 39.9061, lon: -75.1665, state: 'PA' },
  'Citi Field':                  { lat: 40.7571, lon: -73.8458, state: 'NY' },
  'Nationals Park':              { lat: 38.8730, lon: -77.0074, state: 'DC' },
  'Truist Park':                 { lat: 33.8907, lon: -84.4677, state: 'GA' },
  'loanDepot park':              { lat: 25.7781, lon: -80.2195, state: 'FL' },

  // NL Central
  'Wrigley Field':               { lat: 41.9484, lon: -87.6553, state: 'IL' },
  'American Family Field':       { lat: 43.0280, lon: -87.9712, state: 'WI' },
  'PNC Park':                    { lat: 40.4469, lon: -80.0057, state: 'PA' },
  'Great American Ball Park':    { lat: 39.0975, lon: -84.5086, state: 'OH' },
  'Busch Stadium':               { lat: 38.6226, lon: -90.1928, state: 'MO' },

  // NL West
  'Dodger Stadium':              { lat: 34.0739, lon: -118.2400, state: 'CA' },
  'Oracle Park':                 { lat: 37.7786, lon: -122.3893, state: 'CA' },
  'Chase Field':                 { lat: 33.4453, lon: -112.0667, state: 'AZ' },
  'Coors Field':                 { lat: 39.7559, lon: -104.9942, state: 'CO' },
  'Petco Park':                  { lat: 32.7076, lon: -117.1570, state: 'CA' },
};

/**
 * Look up the 2-letter state code for a venue by name.
 * Returns null if the venue is not in the lookup table.
 */
export const VENUE_STATES: Record<string, string> = Object.fromEntries(
  Object.entries(STADIUMS).map(([name, info]) => [name, info.state])
);
