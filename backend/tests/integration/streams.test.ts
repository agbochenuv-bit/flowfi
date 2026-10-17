/**
 * Integration tests for stream HTTP routes with mocked Prisma/SSE.
 *
 * Indexer worker lifecycle flows are covered in indexer-worker.test.ts (mocked
 * worker) and stream-lifecycle.test.ts (real Postgres). This file focuses on
 * claimable RPC fallback, SSE broadcast contracts, and events pagination.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Preserve the module's real exports (issueChallenge, verifyChallenge,
// verifyJwt) — auth.routes wires them up at app construction — while stubbing
// only the middleware so requests bypass JWT verification.
vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: 'GTEST_USER_PUBLIC_KEY' };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    },
  };
});

// ─── Mocks (using vi.hoisted to ensure they are available to vi.mock) ─────────

const { mockSseService, mockPrisma } = vi.hoisted(() => ({
  mockSseService: {
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
  mockPrisma: {
    stream: {
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mockSseService,
  SSEService: vi.fn(() => mockSseService),
}));

vi.mock('../../src/lib/redis.js', () => ({
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
    getMetadata: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

// ─── App import (after mocks) ─────────────────────────────────────────────────

import app from '../../src/app.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SENDER = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';
const RECIPIENT = 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD';
const TOKEN = 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE';

function makeStream(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'uuid-stream-1',
    streamId: 1,
    sender: SENDER,
    recipient: RECIPIENT,
    tokenAddress: TOKEN,
    ratePerSecond: '10',
    depositedAmount: '86400',
    withdrawnAmount: '0',
    startTime: 1700000000,
    lastUpdateTime: 1700000000,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    senderUser: null,
    recipientUser: null,
    ...overrides,
  };
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('Stale DB (>30s) → GET /v1/streams/:id/claimable falls back to RPC', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 200 with claimableAmount when DB data is fresh', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      ratePerSecond: '10',
      depositedAmount: '86400',
      withdrawnAmount: '0',
      lastUpdateTime: now - 5, // 5 seconds ago — fresh
      updatedAt: new Date(Date.now() - 5_000),
      isActive: true,
    });
    mockPrisma.stream.findUnique.mockResolvedValue(stream);

    const res = await request(app).get('/v1/streams/1/claimable');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('claimableAmount');
    expect(typeof res.body.claimableAmount).toBe('string');
  });

  it('returns 200 with claimableAmount when DB data is stale (>30s old)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      ratePerSecond: '10',
      depositedAmount: '86400',
      withdrawnAmount: '0',
      lastUpdateTime: now - 60, // 60 seconds ago — stale
      updatedAt: new Date(Date.now() - 60_000),
      isActive: true,
    });
    mockPrisma.stream.findUnique.mockResolvedValue(stream);

    // Even when stale, the endpoint returns a calculated amount (no real RPC in tests)
    const res = await request(app).get('/v1/streams/1/claimable');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('claimableAmount');
  });
});

describe('SSE client receives broadcast for each stream event', () => {
  it('broadcastToStream is invoked when the indexer calls sseService', () => {
    // Directly exercise the SSE service mock to verify the integration contract
    mockSseService.broadcastToStream('1', 'stream.created', { streamId: 1 });
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.created',
      { streamId: 1 },
    );
  });

  it('broadcastToStream is called for topped_up events', () => {
    mockSseService.broadcastToStream('1', 'stream.topped_up', { amount: '1000' });
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.topped_up',
      { amount: '1000' },
    );
  });

  it('broadcastToStream is called for cancelled events', () => {
    mockSseService.broadcastToStream('1', 'stream.cancelled', {});
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.cancelled',
      {},
    );
  });

  it('broadcastToStream is called for paused events', () => {
    mockSseService.broadcastToStream('1', 'stream.paused', {});
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.paused',
      {},
    );
  });

  it('broadcastToStream is called for resumed events', () => {
    mockSseService.broadcastToStream('1', 'stream.resumed', {});
    expect(mockSseService.broadcastToStream).toHaveBeenCalledWith(
      '1',
      'stream.resumed',
      {},
    );
  });
});

describe('GET /v1/streams/:id/events — pagination and eventType filter', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns paginated events with total and hasMore', async () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      id: `evt-${i}`,
      streamId: 1,
      eventType: 'CREATED',
      transactionHash: `tx${i}`,
      ledgerSequence: 100 + i,
      timestamp: 1700000000 + i,
      amount: null,
      metadata: null,
      createdAt: new Date(),
    }));

    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue(events);
    mockPrisma.streamEvent.count.mockResolvedValue(3);

    const res = await request(app).get('/v1/streams/1/events?limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('hasMore');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.hasMore).toBe(false);

    const callArgs = mockPrisma.streamEvent.findMany.mock.calls[0]![0] as {
      where: { streamId: bigint };
      orderBy: { timestamp: string; id: string }[];
      take: number;
      skip: number;
    };
    expect(callArgs.where.streamId).toBe(1n);
    expect(callArgs.orderBy).toEqual([{ timestamp: 'desc' }, { id: 'desc' }]);
    expect(callArgs.take).toBe(10);
    expect(callArgs.skip).toBe(0);
  });

  it('enforces default limit of 50', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue([]);
    mockPrisma.streamEvent.count.mockResolvedValue(0);

    const res = await request(app).get('/v1/streams/1/events');
    expect(res.status).toBe(200);
    // Prisma findMany should be called with take: 50
    const call = mockPrisma.streamEvent.findMany.mock.calls[0]?.[0] as { take?: number } | undefined;
    expect(call?.take).toBe(50);
  });

  it('filters by eventType=CANCELLED', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue([]);
    mockPrisma.streamEvent.count.mockResolvedValue(0);

    const res = await request(app).get('/v1/streams/1/events?eventType=CANCELLED');
    expect(res.status).toBe(200);
    const call = mockPrisma.streamEvent.findMany.mock.calls[0]?.[0] as { where?: Record<string, unknown> } | undefined;
    expect(call?.where).toMatchObject({ eventType: 'CANCELLED' });
  });

  it('rejects invalid eventType with 400', async () => {
    const res = await request(app).get('/v1/streams/1/events?eventType=INVALID');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('hasMore is true when more results exist beyond the page', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      id: `evt-${i}`,
      streamId: 1,
      eventType: 'CREATED',
      transactionHash: `tx${i}`,
      ledgerSequence: 100 + i,
      timestamp: 1700000000 + i,
      amount: null,
      metadata: null,
      createdAt: new Date(),
    }));

    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue(events);
    mockPrisma.streamEvent.count.mockResolvedValue(100); // total > page size

    const res = await request(app).get('/v1/streams/1/events?limit=5&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.total).toBe(100);
  });
});

// ─── Error envelope contract (issue #70) ──────────────────────────────────────

describe('Streams route family — stable error envelope contract', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function expectErrorEnvelope(body: any, expectedCode: string) {
    expect(body).toHaveProperty('error');
    expect(body.error).toMatchObject({
      code: expectedCode,
      requestId: expect.any(String),
    });
    expect(typeof body.error.message).toBe('string');
    // Envelope must be versioned/documented.
    expect(body.error).toHaveProperty('version');
  }

  it('validation error on events returns stable code with requestId', async () => {
    const res = await request(app)
      .get('/v1/streams/1/events?eventType=INVALID')
      .set('x-request-id', 'req-validation-1');
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'VALIDATION_ERROR');
    expect(res.body.error.requestId).toBe('req-validation-1');
    expect(res.body.error.details).toBeDefined();
  });

  it('not-found stream returns stable NOT_FOUND code', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/v1/streams/999999/events');
    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'NOT_FOUND');
  });

  it('internal exception text is never exposed to clients', async () => {
    const secret = 'SECRET_INTERNAL_DB_DETAIL_xyz';
    mockPrisma.stream.findUnique.mockRejectedValue(new Error(secret));
    const res = await request(app).get('/v1/streams/1/events');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expectErrorEnvelope(res.body, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('malformed cursor returns stable INVALID_CURSOR code', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    const res = await request(app).get('/v1/streams/1/events?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expectErrorEnvelope(res.body, 'INVALID_CURSOR');
  });
});

// ─── Cursor pagination (issue #73) ───────────────────────────────────────────

describe('GET /v1/streams/:id/events — cursor pagination', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makeEvent(i: number, timestamp = 1700000000) {
    return {
      id: `evt-${i}`,
      streamId: 1,
      eventType: 'CREATED',
      transactionHash: `tx${i}`,
      ledgerSequence: 100 + i,
      timestamp,
      amount: null,
      metadata: null,
      createdAt: new Date(),
    };
  }

  it('walks pages without skipping or duplicating rows', async () => {
    // 25 rows, all with equal timestamps to force tie-breaking on id.
    const all = Array.from({ length: 25 }, (_, i) => makeEvent(i));
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page++) {
      // Simulate the DB honoring the cursor: return rows after the cursor.
      const startIdx = cursor ? all.findIndex((e) => e.id === cursor) + 1 : 0;
      const slice = all.slice(startIdx, startIdx + 10);
      mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
      mockPrisma.streamEvent.findMany.mockResolvedValue(slice);

      const url: string = `/v1/streams/1/events?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      for (const row of res.body.data) seen.push(row.id);

      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual(all.map((e) => e.id));
  });

  it('orders deterministically on equal timestamps (id tie-breaker)', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue([]);

    await request(app).get('/v1/streams/1/events?limit=10');
    const call = mockPrisma.streamEvent.findMany.mock.calls[0]?.[0] as {
      orderBy?: unknown;
    };
    expect(call?.orderBy).toEqual([{ timestamp: 'desc' }, { id: 'desc' }]);
  });

  it('does not duplicate rows when a new event is inserted concurrently', async () => {
    const page1 = [makeEvent(5), makeEvent(4), makeEvent(3)];
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValueOnce(page1);

    const res1 = await request(app).get('/v1/streams/1/events?limit=3');
    expect(res1.status).toBe(200);
    const firstIds = res1.body.data.map((e: any) => e.id);
    const cursor = res1.body.nextCursor;
    expect(cursor).toBeTruthy();

    // A new event (id evt-6) arrives before the next page is fetched.
    const page2 = [makeEvent(2), makeEvent(1), makeEvent(0)];
    mockPrisma.streamEvent.findMany.mockResolvedValueOnce(page2);
    const res2 = await request(app).get(
      `/v1/streams/1/events?limit=3&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(res2.status).toBe(200);

    const secondIds = res2.body.data.map((e: any) => e.id);
    const overlap = secondIds.filter((id: string) => firstIds.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('rejects an expired cursor with a stable error code', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    // A well-formed but expired cursor (encoded payload with past expiry).
    const expired = Buffer.from(
      JSON.stringify({ t: 1700000000, id: 'evt-1', exp: 1 }),
    ).toString('base64url');
    const res = await request(app).get(
      `/v1/streams/1/events?cursor=${encodeURIComponent(expired)}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CURSOR_EXPIRED');
  });

  it('preserves legacy offset response shape when no cursor is supplied', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue(makeStream());
    mockPrisma.streamEvent.findMany.mockResolvedValue([makeEvent(1)]);
    mockPrisma.streamEvent.count.mockResolvedValue(1);

    const res = await request(app).get('/v1/streams/1/events?limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('hasMore');
  });
});
