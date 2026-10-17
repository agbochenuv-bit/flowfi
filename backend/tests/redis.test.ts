import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import {
  cache,
  isRedisAvailable,
  startMemoryCacheSweep,
  stopMemoryCacheSweep,
  incrementCounter,
  getCounter,
  resetCounter,
} from '../src/lib/redis.js';

describe('Memory Cache', () => {
  afterAll(() => {
    stopMemoryCacheSweep();
  });

  it('should set and get values', () => {
    cache.set('key1', 'value1', 10);
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return null for expired values', () => {
    vi.useFakeTimers();
    cache.set('key-exp', 'value1', 1);
    vi.advanceTimersByTime(1500);
    expect(cache.get('key-exp')).toBeNull();
    vi.useRealTimers();
  });

  it('should delete values', () => {
    cache.set('key-del', 'value1', 10);
    cache.del('key-del');
    expect(cache.get('key-del')).toBeNull();
  });

  it('should return stats', () => {
    const initialStats = cache.getStats();
    cache.set('key-stats', 'value1', 10);
    cache.get('key-stats');
    cache.get('key-missing');
    const finalStats = cache.getStats();
    expect(finalStats.hits).toBe(initialStats.hits + 1);
    expect(finalStats.misses).toBe(initialStats.misses + 1);
  });
});

describe('Memory Cache Sweep Config', () => {
  afterAll(() => {
    stopMemoryCacheSweep();
  });

  it('should allow starting and stopping sweep interval', () => {
    vi.useFakeTimers();
    const cleanupSpy = vi.spyOn(cache, 'cleanup');
    
    // Stop any existing sweep and start a fresh one with 1000ms interval
    stopMemoryCacheSweep();
    startMemoryCacheSweep(1000);
    
    vi.advanceTimersByTime(2500);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    
    // Stop sweep and ensure no more calls happen
    stopMemoryCacheSweep();
    vi.advanceTimersByTime(2000);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    
    cleanupSpy.mockRestore();
    vi.useRealTimers();
  });

  it('should respect MEMORY_CACHE_SWEEP_MS env variable', () => {
    vi.useFakeTimers();
    const cleanupSpy = vi.spyOn(cache, 'cleanup');
    
    const originalEnv = process.env.MEMORY_CACHE_SWEEP_MS;
    process.env.MEMORY_CACHE_SWEEP_MS = '500';
    
    stopMemoryCacheSweep();
    startMemoryCacheSweep();
    
    vi.advanceTimersByTime(1200);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);
    
    stopMemoryCacheSweep();
    
    if (originalEnv === undefined) {
      delete process.env.MEMORY_CACHE_SWEEP_MS;
    } else {
      process.env.MEMORY_CACHE_SWEEP_MS = originalEnv;
    }
    cleanupSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('Redis Available', () => {
  it('should return false if redis not initialized', () => {
    expect(isRedisAvailable()).toBe(false);
  });
});

describe('Counter helpers (in-memory fallback)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    stopMemoryCacheSweep();
  });

  it('increments a counter and returns the new value', async () => {
    await resetCounter('test:incr');
    expect(await incrementCounter('test:incr', 60)).toBe(1);
    expect(await incrementCounter('test:incr', 60)).toBe(2);
    expect(await incrementCounter('test:incr', 60)).toBe(3);
    expect(await getCounter('test:incr')).toBe(3);
  });

  it('applies a TTL on first increment and expires the counter afterwards', async () => {
    vi.useFakeTimers();
    await resetCounter('test:ttl');
    expect(await incrementCounter('test:ttl', 1)).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(await getCounter('test:ttl')).toBe(0);
    // A fresh increment after expiry starts a new window
    expect(await incrementCounter('test:ttl', 1)).toBe(1);
    vi.useRealTimers();
  });

  it('does not extend the TTL on subsequent increments within the window', async () => {
    vi.useFakeTimers();
    await resetCounter('test:ttl-stable');
    await incrementCounter('test:ttl-stable', 2);
    vi.advanceTimersByTime(1500);
    await incrementCounter('test:ttl-stable', 2);
    // Window started at t=0 with 2s TTL; at t=1.5s counter still alive
    expect(await getCounter('test:ttl-stable')).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(await getCounter('test:ttl-stable')).toBe(0);
    vi.useRealTimers();
  });

  it('shares counters across simulated instances via the same backing store', async () => {
    await resetCounter('test:shared');
    // Simulate two API instances hitting the same logical counter key
    const instanceA = await incrementCounter('test:shared', 60);
    const instanceB = await incrementCounter('test:shared', 60);
    expect(instanceA).toBe(1);
    expect(instanceB).toBe(2);
    expect(await getCounter('test:shared')).toBe(2);
  });

  it('falls back to in-memory counters when Redis is unavailable', async () => {
    expect(isRedisAvailable()).toBe(false);
    await resetCounter('test:fallback');
    expect(await incrementCounter('test:fallback', 60)).toBe(1);
    expect(await incrementCounter('test:fallback', 60)).toBe(2);
    expect(await getCounter('test:fallback')).toBe(2);
  });

  it('resetCounter clears the counter value', async () => {
    await incrementCounter('test:reset', 60);
    await incrementCounter('test:reset', 60);
    expect(await getCounter('test:reset')).toBe(2);
    await resetCounter('test:reset');
    expect(await getCounter('test:reset')).toBe(0);
  });

  it('getCounter returns 0 for unknown keys', async () => {
    expect(await getCounter('test:never-set')).toBe(0);
  });
});
