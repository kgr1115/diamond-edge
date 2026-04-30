/**
 * Shared utilities for backfill scripts.
 * - Env loading from repo root .env
 * - Postgres client factory
 * - Sleep
 * - Structured log helper
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..', '..');

export function loadEnv() {
  const envPath = join(REPO_ROOT, '.env');
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

export function makeDbClient() {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function log(level, event, fields = {}) {
  console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields }));
}

export const MLB_API = process.env.MLB_STATS_API_BASE ?? 'https://statsapi.mlb.com/api/v1';

/** Fetch with exponential backoff on 429 / 5xx. Returns parsed JSON. */
export async function mlbFetch(url, maxAttempts = 3) {
  let lastErr = new Error('unknown');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
      await sleep(backoff);
    }
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'DiamondEdge/1.0 (backfill)' } });
    } catch (err) {
      lastErr = err;
      log('error', 'mlb_fetch_network_error', { url, attempt, err: err.message });
      continue;
    }
    if (res.status === 429) {
      log('error', 'mlb_fetch_429', { url, attempt });
      await sleep(30000);
      lastErr = new Error('429');
      continue;
    }
    if (res.status >= 500) {
      log('error', 'mlb_fetch_5xx', { url, status: res.status, attempt });
      lastErr = new Error(`5xx:${res.status}`);
      continue;
    }
    if (!res.ok) throw new Error(`MLB API ${res.status}: ${url}`);
    return res.json();
  }
  throw lastErr;
}

/** Map MLB abstractGameState / detailedState to our game_status enum. */
export function mapGameStatus(status) {
  const { abstractGameState, detailedState } = status;
  if (detailedState === 'Postponed') return 'postponed';
  if (detailedState === 'Cancelled' || detailedState === 'Canceled') return 'cancelled';
  if (abstractGameState === 'Final') return 'final';
  if (abstractGameState === 'Live') return 'live';
  return 'scheduled';
}

/** VENUE_STATES lookup for venue_state column. */
export const VENUE_STATES = {
  'Yankee Stadium': 'NY',
  'Fenway Park': 'MA',
  'Oriole Park at Camden Yards': 'MD',
  'Tropicana Field': 'FL',
  'Rogers Centre': 'ON',
  'Guaranteed Rate Field': 'IL',
  'Progressive Field': 'OH',
  'Comerica Park': 'MI',
  'Target Field': 'MN',
  'Kauffman Stadium': 'MO',
  'Minute Maid Park': 'TX',
  'Angel Stadium': 'CA',
  'Oakland Coliseum': 'CA',
  'T-Mobile Park': 'WA',
  'Globe Life Field': 'TX',
  'Citizens Bank Park': 'PA',
  'Citi Field': 'NY',
  'Nationals Park': 'DC',
  'Truist Park': 'GA',
  'loanDepot park': 'FL',
  'Wrigley Field': 'IL',
  'American Family Field': 'WI',
  'PNC Park': 'PA',
  'Great American Ball Park': 'OH',
  'Busch Stadium': 'MO',
  'Dodger Stadium': 'CA',
  'Oracle Park': 'CA',
  'Chase Field': 'AZ',
  'Coors Field': 'CO',
  'Petco Park': 'CA',
  'Sutter Health Park': 'CA',
  'RingCentral Coliseum': 'CA',
  'Oakland Coliseum': 'CA',
};
