import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';
import { SSEService } from '../src/services/sse.service.js';

// ─── Metric stubs ─────────────────────────────────────────────────────────────
vi.mock('../src/lib/metrics.js', () => ({
  sseClientsDroppedTotal: { inc: vi.fn() },
  sseConnectionsTotal: { inc: vi.fn() },
  sseMaxConnections: { set: vi.fn() },
  setSseConnectionCounts: vi.fn(),
  sseSlowConsumerQueueDepth: { set: vi.fn() },
  sseReplayBufferSize: { set: vi.fn() },
  sseRedisReconnectsTotal: { inc: vi.fn() },
  sseEventDeduplicatesTotal: { inc: vi.fn() },
}));

// ─── Mock response builder ────────────────────────────────────────────────────

const MAX_WRITABLE_BUFFER = 64 * 1024;

function createMockResponse(options: {
  writeReturns?: boolean;
  throwOnWrite?: boolean;
  writableLength?: number;
} = {}): Response & { emitter: EventEmitter; written: string[] } {
  const emitter = new EventEmitter();
  const socket = {
    writableLength: options.writableLength ?? 0,
  };

  const written: string[] = [];
  const res = {
    emitter,
    written,
    write: vi.fn((chunk: string) => {
      if (options.throwOnWrite) {
        throw new Error('write failed');
      }
      written.push(chunk);
      return options.writeReturns ?? true;
    }),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    end: vi.fn(),
    writableEnded: false,
    socket,
  };

  Object.defineProperty(res, 'writableLength', {
    get: () => options.writableLength ?? 0,
    configurable: true,
  });

  return res as unknown as Response & { emitter: EventEmitter; written: string[] };
}

// ─── Issue 1: Replay buffer ───────────────────────────────────────────────────

describe('SSEService — Issue 1: event IDs and replay', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
    service.stopAuthCheck();
  });

  it('emits `id:` field in broadcast messages', () => {
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, ['*']);

    service.broadcast('test.event', { foo: 'bar' });

    const written = res.written.join('');
    // Must contain id: <integer> before event:
    expect(written).toMatch(/id: \d+/);
    expect(written).toMatch(/event: test\.event/);
    expect(written).toMatch(/data:/);
  });

  it('monotonically increments the id across broadcasts', () => {
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, ['*']);

    service.broadcast('ev', { n: 1 });
    service.broadcast('ev', { n: 2 });

    const idMatches = res.written.join('').match(/id: (\d+)/g) ?? [];
    const ids = idMatches.map((m) => Number.parseInt(m.replace('id: ', ''), 10));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids[1]).toBeGreaterThan(ids[0]!);
  });

  it('replays missed events to a reconnecting client', () => {
    service = new SSEService();

    // First client sends two events
    const res1 = createMockResponse();
    service.addClient('c1', res1, ['*']);

    service.broadcast('ev', { n: 1 });
    service.broadcast('ev', { n: 2 });

    // Extract the last id: seen
    const allWritten = res1.written.join('');
    const lastIdMatch = allWritten.match(/id: (\d+)/g);
    expect(lastIdMatch).not.toBeNull();
    const lastId = Number.parseInt(lastIdMatch!.at(-1)!.replace('id: ', ''), 10);

    // A third event arrives while c1 is still connected
    service.broadcast('ev', { n: 3 });

    // New client reconnects claiming it last saw `lastId` (which is event 2)
    const res2 = createMockResponse();
    service.addClient('c2', res2, ['*'], 'unknown', undefined, lastId);

    // c2 should replay event 3 (id > lastId)
    const replayed = res2.written.join('');
    expect(replayed).toContain('"n":3');
    // But NOT events 1 or 2
    expect(replayed).not.toContain('"n":1');
    expect(replayed).not.toContain('"n":2');
  });

  it('does not replay events outside the age window', async () => {
    // Use a very short replay window (1 ms) to simulate stale entries.
    // The age is checked at replay time against entry.recordedAt, so we
    // need to record the event ID BEFORE sleeping, then reconnect AFTER.
    service = new SSEService();

    const res1 = createMockResponse();
    service.addClient('c1', res1, ['*']);

    // Broadcast the event that will become stale
    service.broadcast('old', { n: 1 });

    // Capture the id of the event we just broadcast
    const allWritten = res1.written.join('');
    const idMatch = allWritten.match(/id: (\d+)/);
    const oldId = idMatch ? Number.parseInt(idMatch[1]!, 10) : 0;

    // Fake the recordedAt timestamp of every replay buffer entry to be in the past
    // (beyond the default 60 s replay window)
    const buffer = (service as any).replayBuffer as Array<{ recordedAt: number }>;
    const staleTime = Date.now() - 120_000; // 2 minutes ago — beyond the 60 s window
    for (const entry of buffer) {
      entry.recordedAt = staleTime;
    }

    const res2 = createMockResponse();
    // Reconnect claiming lastEventId = oldId - 1 (so we'd expect oldId to be replayed)
    service.addClient('c2', res2, ['*'], 'unknown', undefined, oldId - 1);

    // The entry is stale so it must NOT be replayed
    const replayed = res2.written.join('');
    expect(replayed).not.toContain('"n":1');
  });

  it('does not replay events for channels the client is not subscribed to', () => {
    service = new SSEService();

    // Publish to stream '42'
    const res1 = createMockResponse();
    service.addClient('c1', res1, ['42']);

    service._localBroadcastToStream = (service as any)._localBroadcastToStream.bind(service);
    (service as any)._localBroadcastToStream('42', 'ev', { n: 1 });

    // c2 is subscribed to stream '99', not '42'
    const res2 = createMockResponse();
    service.addClient('c2', res2, ['99'], 'unknown', undefined, 0);

    const replayed = res2.written.join('');
    expect(replayed).not.toContain('"n":1');
  });
});

// ─── Issue 2: Auth revalidation ───────────────────────────────────────────────

describe('SSEService — Issue 2: auth revalidation', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
    service.stopAuthCheck();
  });

  it('evicts connections older than AUTH_MAX_CONN_AGE_MS', async () => {
    // Set max age to 1 ms so the test doesn't have to wait
    process.env.SSE_MAX_CONN_AGE_MS = '1';
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, [], '127.0.0.1', 'GUSER1');

    await new Promise((r) => setTimeout(r, 10)); // exceed max age

    // Manually trigger revalidation
    (service as any)._revalidateConnections();

    expect(service.getClientCount()).toBe(0);
    delete process.env.SSE_MAX_CONN_AGE_MS;
  });

  it('sends event: reconnect before closing expired connections', async () => {
    process.env.SSE_MAX_CONN_AGE_MS = '1';
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, [], '127.0.0.1', 'GUSER1');

    // Wait past the max age
    await new Promise((r) => setTimeout(r, 10));

    (service as any)._revalidateConnections();

    const written = res.written.join('');
    expect(written).toContain('event: reconnect');
    delete process.env.SSE_MAX_CONN_AGE_MS;
  });

  it('revokeUserConnections marks matching connections for eviction', () => {
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, [], '127.0.0.1', 'GREVOKED');

    service.revokeUserConnections('GREVOKED');

    // Revalidate to actually evict
    (service as any)._revalidateConnections();

    expect(service.getClientCount()).toBe(0);
  });

  it('does not evict connections that are still within the max age', () => {
    process.env.SSE_MAX_CONN_AGE_MS = '3600000';
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, [], '127.0.0.1', 'GUSER1');

    (service as any)._revalidateConnections();

    expect(service.getClientCount()).toBe(1);
    delete process.env.SSE_MAX_CONN_AGE_MS;
  });
});

// ─── Issue 3: Queue depth and overflow ───────────────────────────────────────

describe('SSEService — Issue 3: queue depth and overflow', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
    service.stopAuthCheck();
  });

  it('enqueues messages for a paused client', () => {
    service = new SSEService();

    const pausedRes = createMockResponse({ writeReturns: false });
    service.addClient('paused', pausedRes, []);

    // First broadcast triggers backpressure (write returns false)
    service.broadcast('ev', { n: 1 });
    // Second broadcast while still paused → enqueued
    service.broadcast('ev', { n: 2 });

    const client = (service as any).clients.get('paused');
    expect(client).toBeDefined();
    expect(client.queue.length).toBeGreaterThanOrEqual(1);
  });

  it('drops a slow client when queue exceeds MAX_CLIENT_QUEUE_DEPTH', () => {
    service = new SSEService();
    // Override the limit directly so the module-level IIFE value doesn't matter
    service.maxClientQueueDepth = 2;

    const pausedRes = createMockResponse({
      writeReturns: false,
      writableLength: 0,
    });
    service.addClient('slow', pausedRes, []);

    // Fill the queue past the limit
    for (let i = 0; i < 4; i++) {
      service.broadcast('ev', { n: i });
    }

    expect(service.getClientCount()).toBe(0);
    expect(service.getSlowClientsDropped()).toBe(1);
  });

  it('removes a client when write() throws without blocking other clients', () => {
    service = new SSEService();

    const failingRes = createMockResponse({ throwOnWrite: true });
    const healthyRes = createMockResponse();

    service.addClient('failing-client', failingRes);
    service.addClient('healthy-client', healthyRes);

    expect(service.getClientCount()).toBe(2);

    service.broadcast('stream.created', { streamId: 1 });

    expect(service.getClientCount()).toBe(1);
    expect(failingRes.end).toHaveBeenCalled();
    expect(healthyRes.write).toHaveBeenCalled();
  });

  it('drops a slow client when write() returns false and buffer exceeds threshold', () => {
    service = new SSEService();

    const slowRes = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });
    const healthyRes = createMockResponse();

    service.addClient('slow-client', slowRes);
    service.addClient('healthy-client', healthyRes);

    service.broadcast('stream.created', { streamId: 1 });

    expect(service.getClientCount()).toBe(1);
    expect(service.getSlowClientsDropped()).toBe(1);
    expect(slowRes.end).toHaveBeenCalled();
    expect(healthyRes.write).toHaveBeenCalled();
  });

  it('removes slow clients from heartbeat broadcasts as well', () => {
    service = new SSEService();

    const slowRes = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });

    service.addClient('slow-client', slowRes);
    service.sendHeartbeat();

    expect(service.getClientCount()).toBe(0);
    expect(service.getSlowClientsDropped()).toBe(1);
  });

  it('drains the queue after backpressure releases (drain event)', () => {
    service = new SSEService();

    let writeCallCount = 0;
    const emitter = new EventEmitter();
    const responses: string[] = [];

    const res = {
      emitter,
      write: vi.fn((chunk: string) => {
        writeCallCount++;
        responses.push(chunk);
        // First write triggers backpressure, subsequent writes succeed
        return writeCallCount > 1;
      }),
      once: emitter.once.bind(emitter),
      on: emitter.on.bind(emitter),
      end: vi.fn(),
      writableEnded: false,
      socket: { writableLength: 0 },
      writableLength: 0,
    } as unknown as Response;

    service.addClient('c1', res, []);

    // This write will return false (backpressure)
    service.broadcast('ev', { n: 1 });

    // Enqueue one more while paused
    service.broadcast('ev', { n: 2 });

    // Simulate drain
    emitter.emit('drain');

    // Both events should have been written eventually
    const joined = responses.join('');
    expect(joined).toContain('"n":1');
    expect(joined).toContain('"n":2');
  });
});

// ─── Issue 4: Redis deduplication ────────────────────────────────────────────

describe('SSEService — Issue 4: Redis deduplication', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
    service.stopAuthCheck();
  });

  it('delivers an event once when eventId is unique', () => {
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, ['42']);

    const msg = JSON.stringify({ event: 'ev', data: { n: 1 }, eventId: 'uuid-unique-1' });
    (service as any)._handleRedisMessage('sse:stream:42', msg);

    const written = res.written.join('');
    expect(written).toContain('"n":1');
  });

  it('drops duplicate eventIds and does not fan out twice', () => {
    service = new SSEService();
    const res = createMockResponse();
    service.addClient('c1', res, ['42']);

    const msg = JSON.stringify({ event: 'ev', data: { n: 1 }, eventId: 'uuid-dup-1' });

    (service as any)._handleRedisMessage('sse:stream:42', msg);
    res.written.length = 0; // reset written log

    (service as any)._handleRedisMessage('sse:stream:42', msg);

    // Second delivery must be silently dropped
    const written = res.written.join('');
    expect(written).toBe('');
  });

  it('evicts oldest dedup entries when window is full', () => {
    service = new SSEService();
    const DEDUP_WINDOW_SIZE = 500;

    // Fill the dedup window with DEDUP_WINDOW_SIZE unique IDs so it is exactly full.
    // Then add one more unique ID to trigger eviction of uuid-fill-0.
    for (let i = 0; i < DEDUP_WINDOW_SIZE; i++) {
      const msg = JSON.stringify({ event: 'ev', data: { n: i }, eventId: `uuid-fill-${i}` });
      (service as any)._handleRedisMessage('sse:stream:x', msg);
    }

    // Push one additional unique ID — this evicts uuid-fill-0 from the LRU set
    const spillMsg = JSON.stringify({ event: 'ev', data: { spill: true }, eventId: 'uuid-spill' });
    (service as any)._handleRedisMessage('sse:stream:x', spillMsg);

    // Now uuid-fill-0 is evicted. Redelivering it on a subscribed channel should
    // NOT be treated as a duplicate.
    const res = createMockResponse();
    service.addClient('c1', res, ['y']);

    const redelivered = JSON.stringify({ event: 'ev', data: { redelivered: true }, eventId: 'uuid-fill-0' });
    (service as any)._handleRedisMessage('sse:stream:y', redelivered);

    const written = res.written.join('');
    expect(written).toContain('"redelivered":true');
  });

  it('handles malformed JSON in Redis messages without crashing', () => {
    service = new SSEService();

    expect(() => {
      (service as any)._handleRedisMessage('sse:stream:42', 'not-valid-json{{{');
    }).not.toThrow();
  });

  it('isRedisSubscribed returns false before subscription', () => {
    service = new SSEService();
    expect(service.isRedisSubscribed()).toBe(false);
  });
});

// ─── Issue 2: Per-user connection cap (preserved from original tests) ─────────

describe('SSEService per-user connection cap', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
    service.stopAuthCheck();
  });

  it('allows connections from a user up to the per-user cap, independent of IP', () => {
    service = new SSEService();
    const userId = 'GUSER123';

    for (let i = 0; i < 10; i += 1) {
      const capacity = service.checkCapacity(`10.0.0.${i}`, userId);
      expect(capacity.allowed).toBe(true);
      service.addClient(`client-${i}`, createMockResponse(), [], `10.0.0.${i}`, userId);
    }

    expect(service.getUserConnectionCount(userId)).toBe(10);

    const rejected = service.checkCapacity('10.0.0.99', userId);
    expect(rejected.allowed).toBe(false);
    expect(rejected.status).toBe(429);
    expect(rejected.message).toMatch(/user/i);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not cap unauthenticated/anonymous checks that omit a userId', () => {
    service = new SSEService();

    for (let i = 0; i < 10; i += 1) {
      const capacity = service.checkCapacity(`10.1.0.${i}`);
      expect(capacity.allowed).toBe(true);
    }
  });

  it('releases the per-user slot once a client disconnects', () => {
    service = new SSEService();
    const userId = 'GUSER456';

    const res = createMockResponse();
    service.addClient('client-a', res, [], '10.2.0.1', userId);
    expect(service.getUserConnectionCount(userId)).toBe(1);

    res.emitter.emit('close');

    expect(service.getUserConnectionCount(userId)).toBe(0);
  });
});
