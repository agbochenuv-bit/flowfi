import { getRedisClient } from './redis';

/**
 * A single wallet authentication challenge.
 *
 * Challenges are bound to the wallet that requested them, the intended
 * audience (origin/domain), the network/chain, and an expiration timestamp.
 * The nonce itself is the key under which the record is stored.
 */
export interface ChallengeRecord {
  /** The wallet address the challenge was issued to. */
  wallet: string;
  /** The intended audience (e.g. origin/domain) the challenge is valid for. */
  audience: string;
  /** The network / chain identifier the challenge is valid for. */
  network: string;
  /** Unix epoch milliseconds at which the challenge expires. */
  expiresAt: number;
  /** Optional additional metadata (e.g. issued-at, request id). */
  [key: string]: unknown;
}

const KEY_PREFIX = 'auth:challenge:';

/**
 * In-process fallback store used when Redis is not configured. This keeps the
 * module functional for single-replica deployments and tests, but challenges
 * will NOT be shared across replicas in this mode.
 */
const memoryStore = new Map<string, ChallengeRecord>();

function redisKey(nonce: string): string {
  return `${KEY_PREFIX}${nonce}`;
}

function isExpired(record: ChallengeRecord, now: number = Date.now()): boolean {
  return typeof record.expiresAt === 'number' && record.expiresAt <= now;
}

/**
 * Persist a challenge record under the given nonce with a TTL.
 *
 * The TTL is derived from `record.expiresAt`. If the record is already expired
 * it is not stored. Returns `true` when the record was stored.
 */
export async function put(
  nonce: string,
  record: ChallengeRecord,
): Promise<boolean> {
  const now = Date.now();
  if (isExpired(record, now)) {
    return false;
  }

  const ttlMs = record.expiresAt - now;
  const redis = getRedisClient();

  if (redis) {
    // SET with PX ensures the key expires server-side even if never taken.
    const result = await redis.set(
      redisKey(nonce),
      JSON.stringify(record),
      'PX',
      ttlMs,
      'NX',
    );
    return result === 'OK';
  }

  // In-memory fallback: do not overwrite an existing live challenge.
  const existing = memoryStore.get(nonce);
  if (existing && !isExpired(existing, now)) {
    return false;
  }
  memoryStore.set(nonce, record);
  return true;
}

/**
 * Atomically retrieve and delete a challenge record. A given nonce can be
 * taken at most once, which is what makes challenges single-use and
 * replay-resistant.
 *
 * Returns the record if it existed and was not expired, otherwise `null`.
 */
export async function take(nonce: string): Promise<ChallengeRecord | null> {
  const redis = getRedisClient();

  if (redis) {
    // GETDEL is atomic on Redis >= 6.2. Fall back to a Lua script for older
    // servers so the read-and-delete is still atomic.
    let raw: string | null = null;
    try {
      raw = await redis.getdel(redisKey(nonce));
    } catch {
      const lua = `
        local v = redis.call('GET', KEYS[1])
        if v then redis.call('DEL', KEYS[1]) end
        return v
      `;
      raw = (await redis.eval(lua, 1, redisKey(nonce))) as string | null;
    }

    if (raw == null) {
      return null;
    }

    let record: ChallengeRecord;
    try {
      record = JSON.parse(raw) as ChallengeRecord;
    } catch {
      return null;
    }

    if (isExpired(record)) {
      return null;
    }
    return record;
  }

  // In-memory fallback: delete before returning so concurrent callers cannot
  // both observe the same record.
  const record = memoryStore.get(nonce);
  if (!record) {
    return null;
  }
  memoryStore.delete(nonce);

  if (isExpired(record)) {
    return null;
  }
  return record;
}

/**
 * Remove expired challenges. With Redis, keys expire automatically via TTL, so
 * this is a no-op there. With the in-memory fallback it prunes stale entries.
 *
 * Returns the number of entries removed.
 */
export async function sweep(now: number = Date.now()): Promise<number> {
  const redis = getRedisClient();
  if (redis) {
    // Redis handles expiry via TTL; nothing to do.
    return 0;
  }

  let removed = 0;
  for (const [nonce, record] of memoryStore.entries()) {
    if (isExpired(record, now)) {
      memoryStore.delete(nonce);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Test helper: clear the in-memory fallback store. Does not touch Redis.
 */
export function _clearMemoryStore(): void {
  memoryStore.clear();
}
```

Note: this module depends on `getRedisClient()` being exported from `./redis`. If the existing `lib/redis.ts` exports the client under a different name (e.g. a default export or `redis`), adjust the import accordingly.