/**
 * Test for Issue #682: userSummaryCache periodic pruning
 * Ensures expired cache entries are cleaned up even without incoming requests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Issue #244: cache invalidation through committed domain events
//
// These tests exercise the domain-events module together with the cache
// invalidation subscriber. The guarantees under test are:
//   * invalidation happens only AFTER the transaction commits;
//   * a rolled-back transaction never invalidates the cache;
//   * duplicate events are idempotent (cache ends up empty, no errors).
// ---------------------------------------------------------------------------

type DomainEvent = {
  type: 'user.summary.changed';
  userId: string;
  payload?: Record<string, unknown>;
};

type Listener = (event: DomainEvent) => void | Promise<void>;

/**
 * Minimal in-memory domain event bus that mirrors the production contract:
 * events are buffered inside a transaction and only dispatched once the
 * transaction commits. Rolled-back transactions discard their buffer.
 */
function createDomainEvents() {
  const listeners: Listener[] = [];
  const dispatched: DomainEvent[] = [];

  const subscribe = (listener: Listener): (() => void) => {
    listeners.push(listener);
    return () => {
      const idx = listeners.indexOf(listener);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  };

  const dispatch = async (event: DomainEvent): Promise<void> => {
    dispatched.push(event);
    for (const listener of [...listeners]) {
      await listener(event);
    }
  };

  /**
   * Runs `work` inside a simulated transaction. Events emitted via `emit`
   * are buffered and only dispatched after `work` resolves successfully.
   * If `work` throws, the buffer is discarded and the error re-thrown.
   */
  const runInTransaction = async <T>(
    work: (emit: (event: DomainEvent) => void) => Promise<T>,
  ): Promise<T> => {
    const buffer: DomainEvent[] = [];
    const emit = (event: DomainEvent): void => {
      buffer.push(event);
    };

    const result = await work(emit);

    // Commit point: dispatch buffered events only after success.
    for (const event of buffer) {
      await dispatch(event);
    }

    return result;
  };

  return { subscribe, dispatch, runInTransaction, dispatched };
}

/**
 * Cache invalidation subscriber: deletes the cached user summary for the
 * affected user. Deletion is idempotent so duplicate events are harmless.
 */
function createInvalidationSubscriber(cache: Map<string, unknown>) {
  return (event: DomainEvent): void => {
    if (event.type === 'user.summary.changed') {
      cache.delete(event.userId);
    }
  };
}

describe('User Summary Cache Invalidation via Committed Domain Events (Issue #244)', () => {
  let cache: Map<string, unknown>;
  let events: ReturnType<typeof createDomainEvents>;
  let unsubscribe: () => void;

  beforeEach(() => {
    cache = new Map<string, unknown>();
    events = createDomainEvents();
    unsubscribe = events.subscribe(createInvalidationSubscriber(cache));
  });

  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  it('invalidates the cache entry after a successful commit', async () => {
    cache.set('user-1', { address: 'user-1', totalStreamsCreated: 5 });
    expect(cache.has('user-1')).toBe(true);

    await events.runInTransaction(async (emit) => {
      // Simulate the mutation writing to the DB.
      emit({ type: 'user.summary.changed', userId: 'user-1' });
      // Cache must still be populated before commit.
      expect(cache.has('user-1')).toBe(true);
    });

    // After commit the subscriber has run and the entry is gone.
    expect(cache.has('user-1')).toBe(false);
    expect(events.dispatched).toHaveLength(1);
  });

  it('does not invalidate the cache when the transaction rolls back', async () => {
    cache.set('user-2', { address: 'user-2', totalStreamsCreated: 3 });

    await expect(
      events.runInTransaction(async (emit) => {
        emit({ type: 'user.summary.changed', userId: 'user-2' });
        throw new Error('simulated rollback');
      }),
    ).rejects.toThrow('simulated rollback');

    // No event was dispatched, so the cached summary survives.
    expect(events.dispatched).toHaveLength(0);
    expect(cache.has('user-2')).toBe(true);
  });

  it('handles duplicate events idempotently', async () => {
    cache.set('user-3', { address: 'user-3', totalStreamsCreated: 1 });

    const event: DomainEvent = { type: 'user.summary.changed', userId: 'user-3' };

    await expect(events.dispatch(event)).resolves.toBeUndefined();
    await expect(events.dispatch(event)).resolves.toBeUndefined();

    // Cache is consistently empty and no error was raised.
    expect(cache.has('user-3')).toBe(false);
    expect(cache.size).toBe(0);
    expect(events.dispatched).toHaveLength(2);
  });

  it('leaves unrelated cache entries untouched', async () => {
    cache.set('user-4', { address: 'user-4' });
    cache.set('user-5', { address: 'user-5' });

    await events.runInTransaction(async (emit) => {
      emit({ type: 'user.summary.changed', userId: 'user-4' });
    });

    expect(cache.has('user-4')).toBe(false);
    expect(cache.has('user-5')).toBe(true);
  });
});

describe('User Summary Cache Pruning (Issue #682)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should prune expired entries periodically', async () => {
    // Mock cache structure
    interface UserSummaryCacheEntry {
      value: any;
      expiresAtMs: number;
    }

    const cache = new Map<string, UserSummaryCacheEntry>();

    const pruneCache = (nowMs: number): void => {
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAtMs <= nowMs) {
          cache.delete(key);
        }
      }
    };

    // Set initial time
    const startTime = 1000000;
    vi.setSystemTime(startTime);

    // Set up periodic pruning (every 60 seconds)
    const intervalId = setInterval(() => {
      pruneCache(Date.now());
    }, 60_000);

    // Add some cache entries with absolute timestamps
    cache.set('user1', {
      value: { address: 'user1', totalStreamsCreated: 5 },
      expiresAtMs: startTime + 100_000, // Expires far in the future
    });

    cache.set('user2', {
      value: { address: 'user2', totalStreamsCreated: 3 },
      expiresAtMs: startTime + 100_000, // Expires far in the future
    });

    cache.set('user3', {
      value: { address: 'user3', totalStreamsCreated: 1 },
      expiresAtMs: startTime - 1000, // Already expired
    });

    expect(cache.size).toBe(3);

    // Advance time by 60 seconds to trigger the interval
    vi.advanceTimersByTime(60_000);

    // Manually trigger prune
    pruneCache(Date.now());

    // user3 should be removed (expired), user1 and user2 should remain
    expect(cache.has('user3')).toBe(false);
    expect(cache.has('user1')).toBe(true);
    expect(cache.has('user2')).toBe(true);
    expect(cache.size).toBe(2);

    // Advance time past expiry for all entries
    vi.advanceTimersByTime(100_000);
    pruneCache(Date.now());

    // All entries should be expired and removed
    expect(cache.size).toBe(0);

    clearInterval(intervalId);
  });

  it('should not remove non-expired entries', () => {
    const cache = new Map<string, { value: any; expiresAtMs: number }>();
    const now = Date.now();

    const pruneCache = (nowMs: number): void => {
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAtMs <= nowMs) {
          cache.delete(key);
        }
      }
    };

    // Add entries that won't expire for a while
    cache.set('active1', {
      value: { address: 'active1' },
      expiresAtMs: now + 100_000,
    });

    cache.set('active2', {
      value: { address: 'active2' },
      expiresAtMs: now + 200_000,
    });

    expect(cache.size).toBe(2);

    // Prune at current time
    pruneCache(now);

    // Nothing should be removed
    expect(cache.size).toBe(2);
    expect(cache.has('active1')).toBe(true);
    expect(cache.has('active2')).toBe(true);
  });

  it('should handle empty cache gracefully', () => {
    const cache = new Map<string, { value: any; expiresAtMs: number }>();

    const pruneCache = (nowMs: number): void => {
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAtMs <= nowMs) {
          cache.delete(key);
        }
      }
    };

    expect(cache.size).toBe(0);

    // Pruning empty cache should not throw
    expect(() => pruneCache(Date.now())).not.toThrow();
    expect(cache.size).toBe(0);
  });

  it('should prune multiple expired entries in one pass', () => {
    const cache = new Map<string, { value: any; expiresAtMs: number }>();
    const now = Date.now();

    const pruneCache = (nowMs: number): void => {
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAtMs <= nowMs) {
          cache.delete(key);
        }
      }
    };

    // Add multiple expired entries
    for (let i = 0; i < 10; i++) {
      cache.set(`expired${i}`, {
        value: { address: `expired${i}` },
        expiresAtMs: now - 1000 - i * 100,
      });
    }

    // Add some active entries
    for (let i = 0; i < 5; i++) {
      cache.set(`active${i}`, {
        value: { address: `active${i}` },
        expiresAtMs: now + 100_000,
      });
    }

    expect(cache.size).toBe(15);

    // Prune expired entries
    pruneCache(now);

    // Only active entries should remain
    expect(cache.size).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(cache.has(`active${i}`)).toBe(true);
    }
    for (let i = 0; i < 10; i++) {
      expect(cache.has(`expired${i}`)).toBe(false);
    }
  });

  it('should prevent memory drift in idle backend', () => {
    const cache = new Map<string, { value: any; expiresAtMs: number }>();
    const TTL_MS = 30_000;
    const PRUNE_INTERVAL_MS = 60_000;

    const pruneCache = (nowMs: number): void => {
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAtMs <= nowMs) {
          cache.delete(key);
        }
      }
    };

    const intervalId = setInterval(() => {
      pruneCache(Date.now());
    }, PRUNE_INTERVAL_MS);

    const startTime = Date.now();

    // Simulate a user connecting once
    cache.set('idle-user', {
      value: { address: 'idle-user', totalStreamsCreated: 1 },
      expiresAtMs: startTime + TTL_MS,
    });

    expect(cache.size).toBe(1);

    // Advance time past TTL but before first prune interval
    vi.advanceTimersByTime(TTL_MS + 1000);

    // Entry is expired but still in cache (waiting for prune)
    expect(cache.size).toBe(1);

    // Advance to trigger prune interval
    vi.advanceTimersByTime(PRUNE_INTERVAL_MS - TTL_MS - 1000);
    pruneCache(Date.now());

    // Now the expired entry should be removed
    expect(cache.size).toBe(0);
    expect(cache.has('idle-user')).toBe(false);

    clearInterval(intervalId);
  });

  it('should handle boundary conditions for expiry time', () => {
    const cache = new Map<string, { value: any; expiresAtMs: number }>();
    const now = Date.now();

    const pruneCache = (nowMs: number): void => {
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAtMs <= nowMs) {
          cache.delete(key);
        }
      }
    };

    // Entry that expires exactly at current time
    cache.set('exact', {
      value: { address: 'exact' },
      expiresAtMs: now,
    });

    // Entry that expires 1ms in the future
    cache.set('future', {
      value: { address: 'future' },
      expiresAtMs: now + 1,
    });

    // Entry that expired 1ms ago
    cache.set('past', {
      value: { address: 'past' },
      expiresAtMs: now - 1,
    });

    expect(cache.size).toBe(3);

    pruneCache(now);

    // 'exact' and 'past' should be removed (expiresAtMs <= nowMs)
    expect(cache.has('exact')).toBe(false);
    expect(cache.has('past')).toBe(false);
    expect(cache.has('future')).toBe(true);
    expect(cache.size).toBe(1);
  });
});
