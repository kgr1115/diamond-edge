/**
 * Upstash Redis REST client for the pick pipeline Edge Function.
 *
 * Invalidates the 4 tier-variant picks:today cache keys after the pipeline
 * writes new picks to the DB. Key patterns match CacheKeys.picksToday()
 * in apps/web/lib/redis/cache.ts — they MUST stay in sync.
 *
 * Uses the Upstash REST API directly (no npm package in Deno — raw fetch).
 */

function getRedisConfig(): { url: string; token: string } {
  const url = Deno.env.get('UPSTASH_REDIS_REST_URL');
  const token = Deno.env.get('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) throw new Error('Upstash Redis env vars not set');
  return { url: url.replace(/\/$/, ''), token };
}

async function redisCommand(commands: unknown[][]): Promise<void> {
  const { url, token } = getRedisConfig();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Redis pipeline failed: ${res.status} ${body}`);
  }
}

/**
 * Invalidate all tier variants of the picks:today cache for a given date.
 * Keys: de:picks:today:{date}:anon, :free, :pro, :elite
 *
 * Matches CacheKeys.picksToday() in apps/web/lib/redis/cache.ts.
 * If the key prefix changes there, update it here too.
 */
export async function invalidatePicksCache(date: string): Promise<void> {
  const tiers = ['anon', 'free', 'pro', 'elite'];
  const keys = tiers.map((tier) => `de:picks:today:${date}:${tier}`);

  // Upstash pipeline: send all DEL commands in one request
  const commands = keys.map((key) => ['DEL', key]);
  await redisCommand(commands);
}
