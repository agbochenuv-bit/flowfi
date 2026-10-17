import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache, cache } from '../src/lib/redis.js';
import {
  ANALYTICS_CACHE_TTL_SECONDS,
  analyticsCacheKey,
  invalidateAnalyticsCache,
} from '../src/lib/analytics-cache.js';

describe('MemoryCache', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MEMORY_CACHE_MAX_ITEMS;
  });

  it('set+get returns value', () => {
    const key = 'memory-cache-set-get';
    cache.set(key, 'value', 10);
    expect(cache.get(key)).toBe('value');
  });

  it('set with 0 TTL is immediately expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const key = 'memory-cache-zero-ttl';
    cache.set(key, 'value', 0);

    expect(cache.get(key)).toBeNull();
  });

  it('expired entries are pruned by cleanup()', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);

    const key = 'memory-cache-expired';
    const initialStats = cache.getStats();

    cache.set(key, 'value', 1);
    vi.advanceTimersByTime(1500);
    cache.cleanup();

    expect(cache.get(key)).toBeNull();
    expect(cache.getStats().itemCount).toBe(initialStats.itemCount);
  });

  it('del() removes an entry', () => {
    const key = 'memory-cache-delete';
    cache.set(key, 'value', 10);
    cache.del(key);
    expect(cache.get(key)).toBeNull();
  });

  it('getStats() reflects hits, misses, and itemCount', () => {
    const key = 'memory-cache-stats';
    const missingKey = 'memory-cache-stats-missing';
    const initialStats = cache.getStats();

    cache.set(key, 'value', 10);
    cache.get(key);
    cache.get(missingKey);

    const finalStats = cache.getStats();
    expect(finalStats.hits).toBe(initialStats.hits + 1);
    expect(finalStats.misses).toBe(initialStats.misses + 1);
    expect(finalStats.itemCount).toBe(initialStats.itemCount + 1);
  });

  it('getMetadata() returns ISO timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);

    const key = 'memory-cache-metadata';
    cache.set(key, 'value', 10);

    const metadata = cache.getMetadata(key);
    expect(metadata).not.toBeNull();
    expect(metadata).toEqual({
      createdAt: new Date(3000).toISOString(),
      expiresAt: new Date(13000).toISOString(),
    });
  });
});

describe('analytics cache layer', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MEMORY_CACHE_MAX_ITEMS;
  });

  it('builds distinct cache keys per network and per filter set', () => {
    const base = { network: 'testnet', from: 100, to: 200, filters: { asset: 'XLM' } };
    const otherNetwork = { ...base, network: 'mainnet' };
    const otherFilters = { ...base, filters: { asset: 'USDC' } };
    const otherRange = { ...base, to: 300 };

    const keys = new Set([
      analyticsCacheKey(base),
      analyticsCacheKey(otherNetwork),
      analyticsCacheKey(otherFilters),
      analyticsCacheKey(otherRange),
    ]);

    expect(keys.size).toBe(4);
    // Key construction is deterministic for identical inputs.
    expect(analyticsCacheKey({ ...base })).toBe(analyticsCacheKey(base));
  });

  it('does not serve one network\'s cached aggregate to another network', () => {
    const store = new MemoryCache({ maxItems: 10 });
    const testnetKey = analyticsCacheKey({ network: 'testnet', from: 0, to: 10, filters: {} });
    const mainnetKey = analyticsCacheKey({ network: 'mainnet', from: 0, to: 10, filters: {} });

    store.set(testnetKey, { total: 1 }, 60);

    expect(store.get(testnetKey)).toEqual({ total: 1 });
    expect(store.get(mainnetKey)).toBeNull();
  });

  it('expires cached aggregates after the documented staleness window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    const store = new MemoryCache({ maxItems: 10 });
    const key = analyticsCacheKey({ network: 'testnet', from: 0, to: 10, filters: {} });

    store.set(key, { total: 5 }, ANALYTICS_CACHE_TTL_SECONDS);
    expect(store.get(key)).toEqual({ total: 5 });

    // Just before the window closes the value is still served.
    vi.advanceTimersByTime(ANALYTICS_CACHE_TTL_SECONDS * 1000 - 1);
    expect(store.get(key)).toEqual({ total: 5 });

    // At/after the window the entry is stale and must not be served.
    vi.advanceTimersByTime(1);
    expect(store.get(key)).toBeNull();
  });

  it('invalidation clears only entries for the targeted network', () => {
    const store = new MemoryCache({ maxItems: 10 });
    const testnetKey = analyticsCacheKey({ network: 'testnet', from: 0, to: 10, filters: {} });
    const testnetOther = analyticsCacheKey({ network: 'testnet', from: 10, to: 20, filters: {} });
    const mainnetKey = analyticsCacheKey({ network: 'mainnet', from: 0, to: 10, filters: {} });

    store.set(testnetKey, { total: 1 }, 60);
    store.set(testnetOther, { total: 2 }, 60);
    store.set(mainnetKey, { total: 3 }, 60);

    invalidateAnalyticsCache(store, 'testnet');

    expect(store.get(testnetKey)).toBeNull();
    expect(store.get(testnetOther)).toBeNull();
    expect(store.get(mainnetKey)).toEqual({ total: 3 });
  });

  it('stays bounded under sustained key churn across networks and ranges', () => {
    const store = new MemoryCache({ maxItems: 50 });

    for (let i = 0; i < 500; i += 1) {
      const key = analyticsCacheKey({
        network: i % 2 === 0 ? 'testnet' : 'mainnet',
        from: i,
        to: i + 10,
        filters: { asset: `asset-${i}` },
      });
      store.set(key, { total: i }, 60);
      expect(store.getStats().itemCount).toBeLessThanOrEqual(50);
    }

    expect(store.getStats().itemCount).toBeLessThanOrEqual(50);
  });
});

describe('MemoryCache LRU eviction', () => {
  it('evicts least-recently-used entries once maxItems is exceeded, without waiting for cleanup', () => {
    const lru = new MemoryCache({ maxItems: 3 });

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    // Fourth set pushes the oldest entry ('a') out immediately.
    lru.set('d', 4, 10);

    expect(lru.get('a')).toBeNull();
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
    expect(lru.get('d')).toBe(4);
    expect(lru.getStats().itemCount).toBe(3);
  });

  it('get() refreshes recency so recently read entries survive eviction', () => {
    const lru = new MemoryCache({ maxItems: 3 });

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    // Reading 'a' makes it most-recently-used, so 'b' becomes the LRU entry.
    expect(lru.get('a')).toBe(1);
    lru.set('d', 4, 10);

    expect(lru.get('b')).toBeNull();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.get('d')).toBe(4);
  });

  it('overwriting an existing key refreshes its recency', () => {
    const lru = new MemoryCache({ maxItems: 3 });

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    // Refreshing 'a' (delete + set) makes it MRU; 'b' is now the LRU entry.
    lru.set('a', 10, 10);
    lru.set('d', 4, 10);

    expect(lru.get('b')).toBeNull();
    expect(lru.get('a')).toBe(10);
    expect(lru.get('c')).toBe(3);
    expect(lru.get('d')).toBe(4);
  });

  it('cleanup() also enforces the max-size cap after pruning expired entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const lru = new MemoryCache({ maxItems: 3 });
    lru.set('expired', 'x', 0); // immediately expired
    lru.set('a', 1, 60);
    lru.set('b', 2, 60);
    lru.set('c', 3, 60);

    lru.cleanup();

    expect(lru.getStats().itemCount).toBe(3);
    expect(lru.get('expired')).toBeNull();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
  });

  it('maxItems can be configured via MEMORY_CACHE_MAX_ITEMS env var', () => {
    process.env.MEMORY_CACHE_MAX_ITEMS = '2';
    const lru = new MemoryCache();

    lru.set('a', 1, 10);
    lru.set('b', 2, 10);
    lru.set('c', 3, 10);

    expect(lru.get('a')).toBeNull();
    expect(lru.get('b')).toBe(2);
    expect(lru.get('c')).toBe(3);
    expect(lru.getStats().maxItems).toBe(2);
  });

  it('getStats() reports the configured maxItems', () => {
    const lru = new MemoryCache({ maxItems: 42 });
    expect(lru.getStats().maxItems).toBe(42);
  });

  it('keeps memory bounded under sustained load across many keys (Issue #1249 acceptance criteria)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const lru = new MemoryCache({ maxItems: 100 });

    // Simulate sustained polling across many streams, generating far more
    // unique keys (one per stream per timestamp bucket) than the cap.
    for (let tick = 0; tick < 500; tick += 1) {
      for (let stream = 0; stream < 50; stream += 1) {
        const key = `claimable:${stream}:state:${tick}`;
        lru.set(key, `value-${tick}-${stream}`, 5);
      }
      // Occasionally read an older key to exercise recency refresh.
      if (tick % 7 === 0) {
        lru.get(`claimable:0:state:${tick - 3}`);
      }
      expect(lru.getStats().itemCount).toBeLessThanOrEqual(100);
      vi.advanceTimersByTime(100);
    }

    // Never grows linearly with the number of requests — always bounded by cap.
    expect(lru.getStats().itemCount).toBeLessThanOrEqual(100);
  });
});
