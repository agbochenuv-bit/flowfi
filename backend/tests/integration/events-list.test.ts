/**
 * Integration tests for GET /v1/events.
 *
 * Verifies the activity-page contract: address filter, event-type filter,
 * pagination via limit/offset, and the shape returned to the frontend
 * (events, total, hasMore).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  prisma: {
    streamEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
  sseService: {
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
    getActiveIpCount: vi.fn().mockReturnValue(0),
    getPerIpPeakConnections: vi.fn().mockReturnValue(0),
    getMaxConnections: vi.fn().mockReturnValue(10000),
    checkCapacity: vi.fn().mockReturnValue({ allowed: true }),
    isShuttingDown: vi.fn().mockReturnValue(false),
    initRedisSubscription: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  default: mocks.prisma,
  prisma: mocks.prisma,
}));

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mocks.sseService,
  SSEService: vi.fn(() => mocks.sseService),
}));

vi.mock('../../src/lib/redis.js', () => ({
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
    getMetadata: vi.fn(),
    getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0, itemCount: 0 }),
    cleanup: vi.fn(),
  },
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  connectRedis: vi.fn().mockResolvedValue(undefined),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));

import app from '../../src/app.js';
import { signJwt } from '../../src/middleware/auth.js';

const ADDR = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';
const now = Math.floor(Date.now() / 1000);
const token = signJwt({ sub: ADDR, iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });

function makeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt-1',
    streamId: 1,
    eventType: 'CREATED',
    amount: '1000',
    transactionHash: 'tx-hash',
    ledgerSequence: 1,
    timestamp: 1700000000,
    metadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('GET /v1/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests missing authentication', async () => {
    const res = await request(app).get(`/v1/events?address=${ADDR}`);
    expect(res.status).toBe(401);
  });

  it('rejects requests missing the `address` query parameter', async () => {
    const res = await request(app)
      .get('/v1/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/address/i);
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });

  it('rejects requests with mismatched authenticated user and address query', async () => {
    const now = Math.floor(Date.now() / 1000);
    const otherToken = signJwt({
      sub: 'GOTHER123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
      iat: now,
      exp: now + 3600,
      iss: 'flowfi-api',
      aud: 'flowfi-api',
    });
    const res = await request(app)
      .get(`/v1/events?address=${ADDR}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('returns the paged event list for the wallet', async () => {
    const events = [makeEvent({ id: 'a', timestamp: 3 }), makeEvent({ id: 'b', timestamp: 2 })];
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce(events);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(5);

    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&limit=2`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body).toMatchObject({ total: 5, limit: 2, offset: 0, hasMore: true });

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      where: { stream: { OR: Array<{ sender?: string; recipient?: string }> } };
      orderBy: { timestamp: string };
      take: number;
      skip: number;
    };
    expect(callArgs.where.stream.OR).toEqual([{ sender: ADDR }, { recipient: ADDR }]);
    expect(callArgs.orderBy).toEqual({ timestamp: 'desc' });
    expect(callArgs.take).toBe(2);
    expect(callArgs.skip).toBe(0);
  });

  it('forwards a comma-separated type filter to Prisma', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(0);

    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&type=PAUSED,RESUMED`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      where: { eventType: { in: string[] } };
    };
    expect(callArgs.where.eventType).toEqual({ in: ['PAUSED', 'RESUMED'] });
  });

  it('rejects a type filter when no values are valid', async () => {
    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&type=BOGUS`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });

  it('supports page-based pagination as a fallback for offset', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(100);

    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&limit=10&page=4`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.offset).toBe(30);

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      skip: number;
    };
    expect(callArgs.skip).toBe(30);
  });

  it('does not include the related stream by default', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(0);

    await request(app)
      .get(`/v1/events?address=${ADDR}`)
      .set('Authorization', `Bearer ${token}`);

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      include?: unknown;
    };
    expect(callArgs.include).toBeUndefined();
  });

  it('includes the related stream when includeStream=true', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(0);

    await request(app)
      .get(`/v1/events?address=${ADDR}&includeStream=true`)
      .set('Authorization', `Bearer ${token}`);

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      include?: unknown;
    };
    expect(callArgs.include).toEqual({ stream: true });
  });
});

/**
 * Contract tests for the stable, versioned error envelope (issue #70).
 *
 * Every error response from the events route family must carry a stable
 * machine-readable `code`, a safe human-readable `message`, a `requestId`
 * for correlation, and (for validation failures) structured `details`.
 * Internal exception text must never leak to clients.
 */
describe('GET /v1/events error envelope contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function expectEnvelope(body: Record<string, unknown>) {
    expect(typeof body.code).toBe('string');
    expect(body.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(typeof body.message).toBe('string');
    expect(typeof body.requestId).toBe('string');
    expect((body.requestId as string).length).toBeGreaterThan(0);
  }

  it('returns a stable envelope for unauthenticated requests', async () => {
    const res = await request(app).get(`/v1/events?address=${ADDR}`);
    expect(res.status).toBe(401);
    expectEnvelope(res.body);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('returns a stable envelope with validation details for a missing address', async () => {
    const res = await request(app)
      .get('/v1/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expectEnvelope(res.body);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'address' })]),
    );
  });

  it('returns a stable envelope for a forbidden cross-wallet request', async () => {
    const otherToken = signJwt({
      sub: 'GOTHER123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
      iat: now,
      exp: now + 3600,
      iss: 'flowfi-api',
      aud: 'flowfi-api',
    });
    const res = await request(app)
      .get(`/v1/events?address=${ADDR}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
    expectEnvelope(res.body);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns a stable envelope for an invalid type filter', async () => {
    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&type=BOGUS`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expectEnvelope(res.body);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('never exposes internal exception text when the data layer fails', async () => {
    const internalMessage = 'PrismaClientKnownRequestError: connection pool exhausted at 10.0.0.5:5432';
    mocks.prisma.streamEvent.findMany.mockRejectedValueOnce(new Error(internalMessage));
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(0);

    const res = await request(app)
      .get(`/v1/events?address=${ADDR}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expectEnvelope(res.body);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('PrismaClientKnownRequestError');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    expect(JSON.stringify(res.body)).not.toContain('connection pool exhausted');
  });

  it('echoes a caller-supplied correlation id in the envelope', async () => {
    const res = await request(app)
      .get('/v1/events')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'req-correlation-123');
    expect(res.status).toBe(400);
    expect(res.body.requestId).toBe('req-correlation-123');
  });
});

/**
 * Cursor pagination tests for GET /v1/events (issue #73).
 *
 * The cursor is opaque, encodes a deterministic (timestamp, id) ordering key,
 * and is only activated when the versioned `pagination=cursor` param is
 * supplied. Without it the legacy limit/offset/total/hasMore shape is
 * preserved byte-for-byte.
 */
describe('GET /v1/events cursor pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function decodeCursor(cursor: string): { timestamp: number; id: string } {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  }

  it('preserves the legacy response shape when the versioned param is absent', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([makeEvent({ id: 'a' })]);
    mocks.prisma.streamEvent.count.mockResolvedValueOnce(1);

    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&limit=10`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 10, offset: 0, hasMore: false });
    expect(res.body.nextCursor).toBeUndefined();
    expect(mocks.prisma.streamEvent.count).toHaveBeenCalledTimes(1);
  });

  it('returns an opaque nextCursor and a deterministic (timestamp, id) orderBy', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([
      makeEvent({ id: 'a', timestamp: 3 }),
      makeEvent({ id: 'b', timestamp: 2 }),
    ]);

    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&limit=2&pagination=cursor`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.nextCursor).toBe('string');
    expect(res.body.hasMore).toBe(true);

    const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      orderBy: Array<Record<string, string>>;
      take: number;
      skip?: number;
      cursor?: unknown;
    };
    expect(callArgs.orderBy).toEqual([{ timestamp: 'desc' }, { id: 'desc' }]);
    expect(callArgs.skip).toBeUndefined();
    expect(callArgs.take).toBe(3); // limit + 1 lookahead
  });

  it('does not skip or duplicate rows across page boundaries', async () => {
    // Deterministic dataset with equal timestamps to exercise the tie-breaker.
    const all = [
      makeEvent({ id: 'e5', timestamp: 100 }),
      makeEvent({ id: 'e4', timestamp: 100 }),
      makeEvent({ id: 'e3', timestamp: 90 }),
      makeEvent({ id: 'e2', timestamp: 90 }),
      makeEvent({ id: 'e1', timestamp: 80 }),
    ];

    mocks.prisma.streamEvent.findMany.mockImplementation(async (args: any) => {
      let rows = [...all];
      if (args.cursor) {
        const key = decodeCursor(args.cursor.id);
        rows = rows.filter(
          (r) =>
            r.timestamp < key.timestamp ||
            (r.timestamp === key.timestamp && String(r.id) < key.id),
        );
      }
      return rows.slice(0, args.take);
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url: string = `/v1/events?address=${ADDR}&limit=2&pagination=cursor${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      for (const ev of res.body.events) seen.push(ev.id);
      if (!res.body.hasMore) break;
      cursor = res.body.nextCursor;
    }

    expect(seen).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('is stable under concurrent inserts (new rows do not shift the window)', async () => {
    const initial = [
      makeEvent({ id: 'e3', timestamp: 100 }),
      makeEvent({ id: 'e2', timestamp: 90 }),
      makeEvent({ id: 'e1', timestamp: 80 }),
    ];

    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce(initial.slice(0, 2));

    const first = await request(app)
      .get(`/v1/events?address=${ADDR}&limit=2&pagination=cursor`)
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.events.map((e: { id: string }) => e.id)).toEqual(['e3', 'e2']);

    // A newer event is inserted between pages; the cursor must ignore it.
    const afterInsert = [makeEvent({ id: 'e4', timestamp: 110 }), ...initial];
    mocks.prisma.streamEvent.findMany.mockImplementationOnce(async (args: any) => {
      const key = decodeCursor(args.cursor.id);
      return afterInsert
        .filter(
          (r) =>
            r.timestamp < key.timestamp ||
            (r.timestamp === key.timestamp && String(r.id) < key.id),
        )
        .slice(0, args.take);
    });

    const second = await request(app)
      .get(
        `/v1/events?address=${ADDR}&limit=2&pagination=cursor&cursor=${encodeURIComponent(
          first.body.nextCursor,
        )}`,
      )
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.events.map((e: { id: string }) => e.id)).toEqual(['e1']);
    expect(second.body.hasMore).toBe(false);
  });

  it('rejects an expired cursor with a stable envelope', async () => {
    const expired = Buffer.from(
      JSON.stringify({ timestamp: 1, id: 'e1', exp: Math.floor(Date.now() / 1000) - 60 }),
    ).toString('base64url');

    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&pagination=cursor&cursor=${encodeURIComponent(expired)}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CURSOR_EXPIRED');
    expect(typeof res.body.requestId).toBe('string');
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor with a stable envelope', async () => {
    const res = await request(app)
      .get(`/v1/events?address=${ADDR}&pagination=cursor&cursor=not-a-cursor`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });
});

/**
 * Feature-parity tests: GET /v1/users/:publicKey/events and GET /v1/events
 * both sit on top of the shared listEventsForWallet helper
 * (backend/src/repositories/streamEvent.repository.ts) and must therefore
 * apply identical sender/recipient and type-filtering logic, even though
 * they differ in auth model (unauthenticated + :publicKey param vs.
 * requireAuth + session address) and response envelope field name
 * (`data` vs `events`).
 */
describe('GET /v1/users/:publicKey/events and GET /v1/events filtering parity', () => {
  // GET /v1/users/:publicKey/events validates the Stellar public key format
  // (^G[A-Z2-7]{55}$), unlike GET /v1/events (whose `address` comes from an
  // already-authenticated session), so parity tests need a well-formed key.
  const VALID_ADDR = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
  const validAddrNow = Math.floor(Date.now() / 1000);
  const validAddrToken = signJwt({
    sub: VALID_ADDR,
    iat: validAddrNow,
    exp: validAddrNow + 3600,
    iss: 'flowfi-api',
    aud: 'flowfi-api',
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('apply the same sender/recipient OR where-clause for a given wallet', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);

    await request(app)
      .get(`/v1/events?address=${VALID_ADDR}`)
      .set('Authorization', `Bearer ${validAddrToken}`);
    const eventsWhere = mocks.prisma.streamEvent.findMany.mock.calls[0]![0].where;

    vi.clearAllMocks();
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);

    await request(app).get(`/v1/users/${VALID_ADDR}/events`);
    const userEventsWhere = mocks.prisma.streamEvent.findMany.mock.calls[0]![0].where;

    expect(userEventsWhere.stream).toEqual(eventsWhere.stream);
  });

  it('apply the same comma-separated `type` filter', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);

    await request(app)
      .get(`/v1/events?address=${VALID_ADDR}&type=PAUSED,RESUMED`)
      .set('Authorization', `Bearer ${validAddrToken}`);
    const eventsWhere = mocks.prisma.streamEvent.findMany.mock.calls[0]![0].where;

    vi.clearAllMocks();
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);

    await request(app).get(`/v1/users/${VALID_ADDR}/events?type=PAUSED,RESUMED`);
    const userEventsWhere = mocks.prisma.streamEvent.findMany.mock.calls[0]![0].where;

    expect(userEventsWhere.eventType).toEqual(eventsWhere.eventType);
    expect(userEventsWhere.eventType).toEqual({ in: ['PAUSED', 'RESUMED'] });
  });

  it('both reject a type filter with no valid values', async () => {
    const eventsRes = await request(app)
      .get(`/v1/events?address=${VALID_ADDR}&type=BOGUS`)
      .set('Authorization', `Bearer ${validAddrToken}`);
    const userEventsRes = await request(app).get(`/v1/users/${VALID_ADDR}/events?type=BOGUS`);

    expect(eventsRes.status).toBe(400);
    expect(userEventsRes.status).toBe(400);
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });
});
