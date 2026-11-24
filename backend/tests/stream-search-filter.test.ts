import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    stream: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    indexerState: {
      findUnique: vi.fn(),
    },
    ledgerCheckpoint: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock('../src/services/sorobanService.js', () => ({
  getLatestLedger: vi.fn().mockResolvedValue(1200),
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_STREAM_PAGE_SIZE,
  StreamQueryValidationError,
  normalizeSearchQuery,
  normalizeStellarIdentifier,
  normalizeStreamSearchQuery,
} from '../src/lib/stream-query.js';
import { buildStreamWhere, findStreams } from '../src/repositories/stream.repository.js';
import {
  attachFreshnessHeaders,
  getChainFreshnessMetadata,
} from '../src/services/freshness.service.js';
import { sendApiError } from '../src/lib/api-error.js';

function buildSearchApp() {
  const app = express();
  app.get('/v1/streams', async (req: Request, res: Response) => {
    try {
      const { params, appliedFilters } = normalizeStreamSearchQuery(
        req.query as Record<string, unknown>,
      );
      const [result, freshness] = await Promise.all([
        findStreams(params),
        getChainFreshnessMetadata({ source: 'indexer' }),
      ]);
      attachFreshnessHeaders(res, freshness);
      res.status(200).json({
        data: result.streams,
        total: result.total,
        hasMore: result.hasMore,
        limit: params.limit,
        offset: params.offset,
        nextCursor: result.nextCursor,
        appliedFilters,
        freshness,
      });
    } catch (err) {
      if (err instanceof StreamQueryValidationError) {
        sendApiError(res, {
          status: err.status,
          code: err.code,
          message: err.message,
          details: err.details,
        });
        return;
      }
      sendApiError(res, {
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Unexpected error',
      });
    }
  });
  return app;
}

describe('Normalized stream search and filter semantics (#230)', () => {
  const app = buildSearchApp();
  const walletA = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11)).publicKey();
  const walletB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12)).publicKey();

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.stream.findMany.mockResolvedValue([]);
    prismaMock.stream.count.mockResolvedValue(0);
    prismaMock.indexerState.findUnique.mockResolvedValue({
      id: 'singleton',
      lastLedger: 1200,
      updatedAt: new Date(),
    });
    prismaMock.ledgerCheckpoint.findFirst.mockResolvedValue({
      ledgerSequence: 1200,
      processedAt: new Date(),
      isReverted: false,
    });
  });

  it('normalizes Stellar StrKey identifiers, search queries, statuses, and sort aliases', () => {
    expect(normalizeStellarIdentifier(`  ${walletA.toLowerCase()}  `)).toBe(walletA);
    expect(normalizeSearchQuery('   payroll   usdc  ')).toBe('payroll usdc');

    const { params, appliedFilters } = normalizeStreamSearchQuery({
      sender: ` ${walletA.toLowerCase()} `,
      tokenAddress: '  CTOKEN_USDC  ',
      status: 'COMPLETED, active , ACTIVE',
      q: '  42  ',
      sort: 'start_time',
      order: 'ASC',
      page: '2',
      limit: '25',
    });

    expect(params.sender).toBe(walletA);
    expect(params.tokenAddress).toBe('CTOKEN_USDC');
    expect(params.statuses).toEqual(['active', 'completed']);
    expect(params.search).toBe('42');
    expect(params.searchStreamId).toBe(42n);
    expect(params.sortField).toBe('startTime');
    expect(params.sortOrder).toBe('asc');
    expect(params.limit).toBe(25);
    expect(params.offset).toBe(25);

    expect(appliedFilters).toMatchObject({
      sender: walletA,
      tokenAddress: 'CTOKEN_USDC',
      statuses: ['active', 'completed'],
      search: '42',
      sort: 'startTime',
      order: 'asc',
      paginationMode: 'offset',
      limit: 25,
      offset: 25,
      cursor: null,
    });
  });

  it('composes participant, multi-status, search, and time ranges cleanly without clobbering OR clauses', () => {
    const { params } = normalizeStreamSearchQuery({
      address: walletA.toLowerCase(),
      status: ['paused', 'active'],
      q: '99',
      startTimeFrom: '1700000000',
      startTimeTo: '1700099999',
      createdAfter: '2026-01-01T00:00:00Z',
      createdBefore: '2026-12-31T23:59:59Z',
    });

    const where = buildStreamWhere(params);

    expect(where.AND).toHaveLength(3);
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { OR: [{ sender: walletA }, { recipient: walletA }] },
        {
          OR: [
            { isActive: true, isPaused: false },
            { isPaused: true },
          ],
        },
        {
          OR: [
            { streamId: 99n },
            { sender: { contains: '99', mode: 'insensitive' } },
            { recipient: { contains: '99', mode: 'insensitive' } },
            { tokenAddress: { contains: '99', mode: 'insensitive' } },
          ],
        },
      ]),
    );
    expect(where.startTime).toEqual({ gte: 1700000000n, lte: 1700099999n });
    expect(where.createdAt?.gte).toBeInstanceOf(Date);
    expect(where.createdAt?.lte).toBeInstanceOf(Date);
  });

  it('rejects conflicting alias filters, inverted ranges, invalid sort/status, and cursor/offset conflicts', async () => {
    const tokenConflict = await request(app)
      .get('/v1/streams')
      .query({ token: 'CTOKEN_A', tokenAddress: 'CTOKEN_B' });
    expect(tokenConflict.status).toBe(400);
    expect(tokenConflict.body.error.code).toBe('CONFLICTING_FILTERS');

    const participantConflict = await request(app)
      .get('/v1/streams')
      .query({ participant: walletA, address: walletB });
    expect(participantConflict.status).toBe(400);
    expect(participantConflict.body.error.code).toBe('CONFLICTING_FILTERS');

    const badStatus = await request(app)
      .get('/v1/streams')
      .query({ status: 'active,bogus' });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error.code).toBe('INVALID_STATUS');

    const invertedStart = await request(app)
      .get('/v1/streams')
      .query({ startTimeFrom: '2000', startTimeTo: '1000' });
    expect(invertedStart.status).toBe(400);
    expect(invertedStart.body.error.code).toBe('INVALID_RANGE');

    const invertedCreated = await request(app)
      .get('/v1/streams')
      .query({
        createdAfter: '2026-06-01T00:00:00Z',
        createdBefore: '2026-01-01T00:00:00Z',
      });
    expect(invertedCreated.status).toBe(400);
    expect(invertedCreated.body.error.code).toBe('INVALID_RANGE');

    const badSort = await request(app)
      .get('/v1/streams')
      .query({ sort: 'nonexistentColumn' });
    expect(badSort.status).toBe(400);
    expect(badSort.body.error.code).toBe('INVALID_SORT_FIELD');

    const badOrder = await request(app)
      .get('/v1/streams')
      .query({ order: 'sideways' });
    expect(badOrder.status).toBe(400);
    expect(badOrder.body.error.code).toBe('INVALID_SORT_ORDER');

    const cursorOffsetConflict = await request(app)
      .get('/v1/streams')
      .query({ cursor: '10', offset: '20' });
    expect(cursorOffsetConflict.status).toBe(400);
    expect(cursorOffsetConflict.body.error.code).toBe('CONFLICTING_PAGINATION');

    const tooBigLimit = await request(app)
      .get('/v1/streams')
      .query({ limit: String(MAX_STREAM_PAGE_SIZE + 1) });
    expect(tooBigLimit.status).toBe(400);
    expect(tooBigLimit.body.error.code).toBe('INVALID_PAGINATION');

    const tooLongSearch = await request(app)
      .get('/v1/streams')
      .query({ q: 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) });
    expect(tooLongSearch.status).toBe(400);
    expect(tooLongSearch.body.error.code).toBe('INVALID_SEARCH_QUERY');
  });

  it('rejects mismatched network queries with 409 NETWORK_MISMATCH', async () => {
    const res = await request(app)
      .get('/v1/streams')
      .query({ network: 'mainnet' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NETWORK_MISMATCH');
  });

  it('returns appliedFilters and freshness metadata alongside paginated results over HTTP', async () => {
    prismaMock.stream.findMany.mockResolvedValue([
      { streamId: 5n, sender: walletA, recipient: walletB },
    ]);
    prismaMock.stream.count.mockResolvedValue(1);

    const res = await request(app)
      .get('/v1/streams')
      .query({
        participant: walletA.toLowerCase(),
        status: 'ACTIVE',
        sort: 'created_at',
        order: 'desc',
        limit: '10',
      });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.appliedFilters).toMatchObject({
      participant: walletA,
      statuses: ['active'],
      sort: 'createdAt',
      order: 'desc',
      paginationMode: 'offset',
      limit: 10,
      offset: 0,
    });
    expect(res.body.freshness).toMatchObject({
      network: 'testnet',
      source: 'indexer',
      freshness: 'fresh',
      finality: 'finalized',
    });
    expect(res.headers['x-chain-freshness']).toBe('fresh');
  });
});
