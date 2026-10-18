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
import { exportEvents } from '../../src/services/export.service.js';

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

  /**
   * Ordering / pagination stability with the query-plan-backed indexes.
   *
   * The new indexes (see backend/prisma/migrations) support the
   * `streamEvent` access pattern `stream -> sender/recipient` +
   * `ORDER BY timestamp DESC` + `LIMIT/OFFSET`. These tests pin the
   * externally observable ordering and pagination contract so an index
   * change cannot silently reorder pages or shift boundaries.
   */
  describe('ordering and pagination stability', () => {
    it('always requests newest-first ordering with the same tie-breaker', async () => {
      mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
      mocks.prisma.streamEvent.count.mockResolvedValueOnce(0);

      await request(app)
        .get(`/v1/events?address=${ADDR}`)
        .set('Authorization', `Bearer ${token}`);

      const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
        orderBy: unknown;
      };
      // A stable orderBy is required for index-backed pagination: without a
      // deterministic tie-breaker, rows sharing a timestamp could be
      // duplicated or skipped across pages.
      expect(callArgs.orderBy).toEqual({ timestamp: 'desc' });
    });

    it('preserves the order returned by Prisma in the response payload', async () => {
      const events = [
        makeEvent({ id: 'newest', timestamp: 300 }),
        makeEvent({ id: 'middle', timestamp: 200 }),
        makeEvent({ id: 'oldest', timestamp: 100 }),
      ];
      mocks.prisma.streamEvent.findMany.mockResolvedValueOnce(events);
      mocks.prisma.streamEvent.count.mockResolvedValueOnce(3);

      const res = await request(app)
        .get(`/v1/events?address=${ADDR}&limit=3`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.events.map((e: { id: string }) => e.id)).toEqual([
        'newest',
        'middle',
        'oldest',
      ]);
      expect(res.body).toMatchObject({ total: 3, limit: 3, offset: 0, hasMore: false });
    });

    it('returns an empty page with hasMore=false when the wallet has no events', async () => {
      mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
      mocks.prisma.streamEvent.count.mockResolvedValueOnce(0);

      const res = await request(app)
        .get(`/v1/events?address=${ADDR}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
      expect(res.body).toMatchObject({ total: 0, offset: 0, hasMore: false });

      const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
        take: number;
        skip: number;
      };
      expect(callArgs.skip).toBe(0);
      expect(callArgs.take).toBeGreaterThan(0);
    });

    it('reports hasMore=false on the last page when offset + page size equals total', async () => {
      mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([
        makeEvent({ id: 'last-1', timestamp: 2 }),
        makeEvent({ id: 'last-2', timestamp: 1 }),
      ]);
      mocks.prisma.streamEvent.count.mockResolvedValueOnce(4);

      const res = await request(app)
        .get(`/v1/events?address=${ADDR}&limit=2&offset=2`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 4, limit: 2, offset: 2, hasMore: false });

      const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
        take: number;
        skip: number;
      };
      expect(callArgs.skip).toBe(2);
      expect(callArgs.take).toBe(2);
    });

    it('reports hasMore=true on the first page when more rows remain', async () => {
      mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([
        makeEvent({ id: 'first-1', timestamp: 5 }),
        makeEvent({ id: 'first-2', timestamp: 4 }),
      ]);
      mocks.prisma.streamEvent.count.mockResolvedValueOnce(3);

      const res = await request(app)
        .get(`/v1/events?address=${ADDR}&limit=2&offset=0`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });
    });

    it('returns an empty page with hasMore=false when offset is past the end', async () => {
      mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);
      mocks.prisma.streamEvent.count.mockResolvedValueOnce(3);

      const res = await request(app)
        .get(`/v1/events?address=${ADDR}&limit=2&offset=10`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
      expect(res.body).toMatchObject({ total: 3, offset: 10, hasMore: false });

      const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
        skip: number;
      };
      expect(callArgs.skip).toBe(10);
    });

    it('keeps the type filter applied alongside ordering and pagination', async () => {
      mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([
        makeEvent({ id: 'paused', eventType: 'PAUSED', timestamp: 9 }),
      ]);
      mocks.prisma.streamEvent.count.mockResolvedValueOnce(1);

      const res = await request(app)
        .get(`/v1/events?address=${ADDR}&type=PAUSED&limit=1&offset=0`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 1, limit: 1, offset: 0, hasMore: false });

      const callArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
        where: { eventType: { in: string[] } };
        orderBy: unknown;
        take: number;
        skip: number;
      };
      expect(callArgs.where.eventType).toEqual({ in: ['PAUSED'] });
      expect(callArgs.orderBy).toEqual({ timestamp: 'desc' });
      expect(callArgs.take).toBe(1);
      expect(callArgs.skip).toBe(0);
    });
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

  it('apply the same newest-first ordering and pagination window', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);

    await request(app)
      .get(`/v1/events?address=${VALID_ADDR}&limit=5&offset=10`)
      .set('Authorization', `Bearer ${validAddrToken}`);
    const eventsArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      orderBy: unknown;
      take: number;
      skip: number;
    };

    vi.clearAllMocks();
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);

    await request(app).get(`/v1/users/${VALID_ADDR}/events?limit=5&offset=10`);
    const userEventsArgs = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      orderBy: unknown;
      take: number;
      skip: number;
    };

    expect(userEventsArgs.orderBy).toEqual(eventsArgs.orderBy);
    expect(userEventsArgs.orderBy).toEqual({ timestamp: 'desc' });
    expect(userEventsArgs.take).toBe(eventsArgs.take);
    expect(userEventsArgs.skip).toBe(eventsArgs.skip);
    expect(userEventsArgs.take).toBe(5);
    expect(userEventsArgs.skip).toBe(10);
  });

  it('both return an empty page with hasMore=false for a wallet with no events', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValue([]);
    mocks.prisma.streamEvent.count.mockResolvedValue(0);

    const eventsRes = await request(app)
      .get(`/v1/events?address=${VALID_ADDR}`)
      .set('Authorization', `Bearer ${validAddrToken}`);
    const userEventsRes = await request(app).get(`/v1/users/${VALID_ADDR}/events`);

    expect(eventsRes.status).toBe(200);
    expect(userEventsRes.status).toBe(200);
    expect(eventsRes.body.events).toEqual([]);
    expect(userEventsRes.body.data).toEqual([]);
    expect(eventsRes.body.hasMore).toBe(false);
    expect(userEventsRes.body.hasMore).toBe(false);
  });

  it('both report hasMore=false on the last page', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValue([
      makeEvent({ id: 'tail-1', timestamp: 2 }),
      makeEvent({ id: 'tail-2', timestamp: 1 }),
    ]);
    mocks.prisma.streamEvent.count.mockResolvedValue(4);

    const eventsRes = await request(app)
      .get(`/v1/events?address=${VALID_ADDR}&limit=2&offset=2`)
      .set('Authorization', `Bearer ${validAddrToken}`);
    const userEventsRes = await request(app).get(
      `/v1/users/${VALID_ADDR}/events?limit=2&offset=2`,
    );

    expect(eventsRes.status).toBe(200);
    expect(userEventsRes.status).toBe(200);
    expect(eventsRes.body).toMatchObject({ total: 4, limit: 2, offset: 2, hasMore: false });
    expect(userEventsRes.body).toMatchObject({ total: 4, limit: 2, offset: 2, hasMore: false });
  });
});

/**
 * Export service integration tests.
 *
 * The export service pages through stream events with keyset pagination so
 * that large account exports stay bounded in memory and produce a
 * snapshot-consistent result even when new events arrive mid-export.
 */
describe('exportEvents (bounded, snapshot-consistent exports)', () => {
  const EXPORT_ADDR = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';

  function makeExportEvent(id: string, timestamp: number, overrides: Record<string, unknown> = {}) {
    return makeEvent({ id, timestamp, ...overrides });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pages with keyset pagination and never materializes the full result set', async () => {
    const batchSize = 2;
    const batches = [
      [makeExportEvent('e5', 5), makeExportEvent('e4', 4)],
      [makeExportEvent('e3', 3), makeExportEvent('e2', 2)],
      [makeExportEvent('e1', 1)],
    ];
    let call = 0;
    mocks.prisma.streamEvent.findMany.mockImplementation(async () => batches[call++] ?? []);

    const seen: string[] = [];
    const result = await exportEvents({
      address: EXPORT_ADDR,
      batchSize,
      onBatch: (events: Array<{ id: string }>) => {
        expect(events.length).toBeLessThanOrEqual(batchSize);
        seen.push(...events.map((e) => e.id));
      },
    });

    expect(seen).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    expect(result.count).toBe(5);
    expect(mocks.prisma.streamEvent.findMany).toHaveBeenCalledTimes(3);

    for (const [args] of mocks.prisma.streamEvent.findMany.mock.calls) {
      expect((args as { take: number }).take).toBe(batchSize);
    }
  });

  it('uses a stable keyset cursor so new events arriving mid-export do not shift results', async () => {
    const batchSize = 2;
    // First batch: newest two events at export start.
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([
      makeExportEvent('e5', 5),
      makeExportEvent('e4', 4),
    ]);
    // A new event (e6) arrives after the first batch was read. The second
    // batch must not include it because the cursor is anchored to e4.
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([
      makeExportEvent('e3', 3),
      makeExportEvent('e2', 2),
    ]);
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([makeExportEvent('e1', 1)]);

    const seen: string[] = [];
    const result = await exportEvents({
      address: EXPORT_ADDR,
      batchSize,
      onBatch: (events: Array<{ id: string }>) => {
        seen.push(...events.map((e) => e.id));
      },
    });

    expect(seen).toEqual(['e5', 'e4', 'e3', 'e2', 'e1']);
    expect(seen).not.toContain('e6');
    expect(result.count).toBe(5);

    // Second and subsequent calls must carry a cursor derived from the last
    // event of the previous batch, not an offset.
    const secondArgs = mocks.prisma.streamEvent.findMany.mock.calls[1]![0] as {
      cursor?: { id: string };
      skip?: number;
    };
    expect(secondArgs.cursor).toEqual({ id: 'e4' });
    expect(secondArgs.skip).toBe(1);
  });

  it('applies explicit event-type filters to every batch query', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);

    await exportEvents({
      address: EXPORT_ADDR,
      batchSize: 100,
      eventTypes: ['PAUSED', 'RESUMED'],
    });

    const args = mocks.prisma.streamEvent.findMany.mock.calls[0]![0] as {
      where: { eventType?: { in: string[] }; stream: { OR: unknown[] } };
    };
    expect(args.where.eventType).toEqual({ in: ['PAUSED', 'RESUMED'] });
    expect(args.where.stream.OR).toEqual([{ sender: EXPORT_ADDR }, { recipient: EXPORT_ADDR }]);
  });

  it('rejects a batch size above the configured maximum', async () => {
    await expect(
      exportEvents({ address: EXPORT_ADDR, batchSize: 100_000 }),
    ).rejects.toThrow(/batch/i);
    expect(mocks.prisma.streamEvent.findMany).not.toHaveBeenCalled();
  });

  it('handles an empty account without issuing extra queries', async () => {
    mocks.prisma.streamEvent.findMany.mockResolvedValueOnce([]);

    const result = await exportEvents({ address: EXPORT_ADDR, batchSize: 50 });
    expect(result.count).toBe(0);
    expect(mocks.prisma.streamEvent.findMany).toHaveBeenCalledTimes(1);
  });
});
