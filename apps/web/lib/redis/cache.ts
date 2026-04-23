import { Redis } from '@upstash/redis';

// Redis is constructed lazily so the module can be imported without env vars
// during type-checking or test setup.
let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

/**
 * Retrieve a cached value. Returns null on miss or Redis failure.
 * Redis failures are caught and logged — callers should always fall through
 * to the authoritative data source on a null return.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const value = await getRedis().get<T>(key);
    return value ?? null;
  } catch (err) {
    console.error({ event: 'redis_get_error', key, err });
    return null;
  }
}

/**
 * Store a value in Redis with a TTL in seconds.
 * Failures are caught and logged — the caller's response is unaffected.
 */
export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, value, { ex: ttlSeconds });
  } catch (err) {
    console.error({ event: 'redis_set_error', key, err });
    // intentionally swallowed — cache write failure is non-fatal
  }
}

/**
 * Delete one or more exact cache keys.
 * Use for targeted invalidation (e.g., single pick, single game).
 */
export async function cacheInvalidate(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await getRedis().del(...keys);
  } catch (err) {
    console.error({ event: 'redis_invalidate_error', keys, err });
  }
}

/**
 * Delete all keys matching a glob pattern using SCAN + DEL.
 * Use for wildcard invalidation (e.g., all tier variants of today's picks).
 *
 * WARNING: SCAN is O(N) over the keyspace. Only call this from cron/pipeline completion
 * hooks, never on the hot request path.
 */
export async function cacheInvalidatePattern(pattern: string): Promise<void> {
  try {
    const redis = getRedis();
    let cursor = 0;
    const keysToDelete: string[] = [];

    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
      cursor = Number(nextCursor);
      keysToDelete.push(...keys);
    } while (cursor !== 0);

    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
    }
    console.info({ event: 'redis_pattern_invalidated', pattern, count: keysToDelete.length });
  } catch (err) {
    console.error({ event: 'redis_invalidate_pattern_error', pattern, err });
  }
}

// ------ Typed key builders (keeps key format changes in one place) ------

export const CacheKeys = {
  picksToday: (date: string, tier: string) => `de:picks:today:${date}:${tier}`,
  pickDetail: (pickId: string, tier: string) => `de:pick:${pickId}:${tier}`,
  oddsGame: (gameId: string) => `de:odds:game:${gameId}`,
  scheduleDate: (date: string) => `de:schedule:${date}`,
  historyAgg: (market: string, from: string, to: string) =>
    `de:history:agg:${market}:${from}:${to}`,
  historyList: (market: string, from: string, to: string, page: number, perPage: number) =>
    `de:history:list:${market}:${from}:${to}:${page}:${perPage}`,
  statsPlayer: (playerId: string, season: number, split: string) =>
    `de:stats:player:${playerId}:${season}:${split}`,
  statsTeam: (teamId: string, season: number, split: string) =>
    `de:stats:team:${teamId}:${season}:${split}`,
} as const;

// TTLs in seconds (sourced from caching-strategy.md)
export const CacheTTL = {
  PICKS_TODAY: 900,       // 15 min
  PICK_DETAIL: 1800,      // 30 min
  ODDS_GAME: 600,         // 10 min
  SCHEDULE: 3600,         // 1 hour
  HISTORY: 3600,          // 1 hour
  STATS_PLAYER: 10800,    // 3 hours
  STATS_TEAM: 10800,      // 3 hours
} as const;
