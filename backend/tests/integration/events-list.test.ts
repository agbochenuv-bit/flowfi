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
