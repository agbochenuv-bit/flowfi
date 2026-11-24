import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

const { prismaMock, getStreamFromChainMock, isStaleMock, getClaimableMock } =
  vi.hoisted(() => ({
    prismaMock: {
      stream: {
        findMany: vi.fn(),
      },
      indexerState: {
        findUnique: vi.fn(),
      },
      ledgerCheckpoint: {
        findFirst: vi.fn(),
      },
    },
    getStreamFromChainMock: vi.fn(),
    isStaleMock: vi.fn(),
    getClaimableMock: vi.fn(),
  }));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock('../src/services/sorobanService.js', () => ({
  getStreamFromChain: getStreamFromChainMock,
  isStale: isStaleMock,
  getLatestLedger: vi.fn().mockResolvedValue(1000),
}));

vi.mock('../src/services/claimable.service.js', () => ({
  claimableAmountService: {
    getClaimableAmount: getClaimableMock,
  },
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
  BatchStreamReadError,
  MAX_BATCH_READ_STREAM_IDS,
  MAX_BATCH_RPC_FALLBACKS,
  executeBatchStreamRead,
  validateBatchStreamReadRequest,
} from '../src/services/stream-read.service.js';
import { attachFreshnessHeaders } from '../src/services/freshness.service.js';
import { sendApiError } from '../src/lib/api-error.js';
import { optionalAuthWithScope } from '../src/middleware/auth.js';
import {
  __apiCredentialTestUtils,
  createApiCredential,
  revokeApiCredential,
} from '../src/services/api-credential.service.js';

function makeDbStream(streamId: bigint, overrides: Record<string, unknown> = {}) {
  return {
    id: `uuid-${streamId.toString()}`,
    streamId,
    sender: 'GABC123',
    recipient: 'GDEF456',
    tokenAddress: 'CTOKEN1',
    ratePerSecond: '10',
    depositedAmount: '1000',
    withdrawnAmount: '100',
    startTime: 1700000000n,
    lastUpdateTime: 1700000050n,
    endTime: 1700000100n,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    updatedAt: new Date(),
    senderUser: null,
    recipientUser: null,
    ...overrides,
  };
}

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.post(
    '/v1/streams/batch-read',
    optionalAuthWithScope('streams:read'),
    async (req: Request, res: Response) => {
      try {
        const validated = validateBatchStreamReadRequest(
          req.body,
          req.query['network'],
        );
        const result = await executeBatchStreamRead(validated);
        attachFreshnessHeaders(res, result.freshness);
        res.status(200).json(result);
      } catch (err) {
        if (err instanceof BatchStreamReadError) {
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
    },
  );
  return app;
}

describe('Bounded multi-stream read endpoint (#229)', () => {
  const app = buildTestApp();

  beforeEach(() => {
    vi.clearAllMocks();
    __apiCredentialTestUtils.clearAll();
    isStaleMock.mockReturnValue(false);
    getStreamFromChainMock.mockResolvedValue(null);
    prismaMock.indexerState.findUnique.mockResolvedValue({
      id: 'singleton',
      lastLedger: 500,
      updatedAt: new Date(),
    });
    prismaMock.ledgerCheckpoint.findFirst.mockResolvedValue({
      ledgerSequence: 500,
      processedAt: new Date(),
      isReverted: false,
    });
  });

  it('reads multiple streams in one bounded DB query while preserving caller order and deduplicating', async () => {
    prismaMock.stream.findMany.mockResolvedValue([
      makeDbStream(3n),
      makeDbStream(1n),
    ]);

    const res = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ['3', 1, '3', '2'] });

    expect(res.status).toBe(200);
    expect(prismaMock.stream.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.stream.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: { in: [3n, 1n, 2n] } },
        take: 3,
      }),
    );

    expect(res.body.items.map((item: { streamId: string }) => item.streamId)).toEqual([
      '3',
      '1',
      '2',
    ]);
    expect(res.body.items[0].status).toBe('found');
    expect(res.body.items[1].status).toBe('found');
    expect(res.body.items[2].status).toBe('not_found');
    expect(res.body.missingStreamIds).toEqual(['2']);
    expect(res.body.failedStreamIds).toEqual([]);
    expect(res.body.meta).toMatchObject({
      requestedCount: 4,
      uniqueCount: 3,
      duplicateCount: 1,
      foundCount: 2,
      missingCount: 1,
      failedCount: 0,
      maxBatchSize: MAX_BATCH_READ_STREAM_IDS,
      partial: true,
    });
    expect(res.body.freshness.finality).toBe('finalized');
    expect(res.headers['x-chain-freshness']).toBe('fresh');
    expect(res.headers['x-chain-finality']).toBe('finalized');
  });

  it('accepts exactly MAX_BATCH_READ_STREAM_IDS (50) and rejects 51 with BATCH_LIMIT_EXCEEDED', async () => {
    const fiftyIds = Array.from(
      { length: MAX_BATCH_READ_STREAM_IDS },
      (_, idx) => String(idx + 1),
    );
    prismaMock.stream.findMany.mockResolvedValue([makeDbStream(1n)]);

    const okRes = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: fiftyIds });
    expect(okRes.status).toBe(200);
    expect(okRes.body.meta.uniqueCount).toBe(MAX_BATCH_READ_STREAM_IDS);

    const tooManyIds = [...fiftyIds, '51'];
    const errRes = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: tooManyIds });
    expect(errRes.status).toBe(400);
    expect(errRes.body.error.code).toBe('BATCH_LIMIT_EXCEEDED');
    expect(errRes.body.error.details.maxBatchSize).toBe(
      MAX_BATCH_READ_STREAM_IDS,
    );
    expect(errRes.body.error.details.recoveryHint).toBeTruthy();
  });

  it('rejects empty streamIds, invalid IDs, invalid options, and network mismatch', async () => {
    const emptyRes = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: [] });
    expect(emptyRes.status).toBe(400);
    expect(emptyRes.body.error.code).toBe('EMPTY_BATCH_REQUEST');

    const badIdsRes = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ['10', '-5', 'abc'] });
    expect(badIdsRes.status).toBe(400);
    expect(badIdsRes.body.error.code).toBe('INVALID_STREAM_ID');
    expect(badIdsRes.body.error.details.invalidEntries).toHaveLength(2);

    const badOptionRes = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ['1'], includeClaimable: 'yes' });
    expect(badOptionRes.status).toBe(400);
    expect(badOptionRes.body.error.code).toBe('INVALID_OPTION');

    const networkMismatchRes = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ['1'], network: 'mainnet' });
    expect(networkMismatchRes.status).toBe(409);
    expect(networkMismatchRes.body.error.code).toBe('NETWORK_MISMATCH');
  });

  it('isolates per-item claimable errors without failing healthy streams in the batch', async () => {
    prismaMock.stream.findMany.mockResolvedValue([
      makeDbStream(1n),
      makeDbStream(2n),
    ]);
    getClaimableMock
      .mockReturnValueOnce({
        streamId: 1n,
        claimableAmount: '250',
        actionable: true,
        calculatedAt: 1700000100,
        cached: false,
      })
      .mockImplementationOnce(() => {
        throw new Error('corrupt i128 field');
      });

    const res = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ['1', '2'], includeClaimable: true, at: 1700000100 });

    expect(res.status).toBe(200);
    expect(res.body.items[0].status).toBe('found');
    expect(res.body.items[0].claimable.claimableAmount).toBe('250');
    expect(res.body.items[1].status).toBe('error');
    expect(res.body.items[1].error.code).toBe('CLAIMABLE_CALCULATION_FAILED');
    expect(res.body.failedStreamIds).toEqual(['2']);
    expect(res.body.meta.partial).toBe(true);
    expect(res.body.meta.recoveryHint).toContain('failedStreamIds');
  });

  it('caps optional RPC fallbacks and isolates transient RPC failures per item', async () => {
    prismaMock.stream.findMany.mockResolvedValue([]);
    getStreamFromChainMock
      .mockResolvedValueOnce({
        streamId: 1n,
        sender: 'GSENDER',
        recipient: 'GREC',
        tokenAddress: 'CTOKEN',
        ratePerSecond: '10',
        depositedAmount: '100',
        withdrawnAmount: '0',
        startTime: 1700000000,
        isActive: true,
      })
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue(null);

    const ids = Array.from(
      { length: MAX_BATCH_RPC_FALLBACKS + 2 },
      (_, idx) => String(idx + 1),
    );
    const res = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ids, allowRpcFallback: true });

    expect(res.status).toBe(200);
    expect(getStreamFromChainMock).toHaveBeenCalledTimes(MAX_BATCH_RPC_FALLBACKS);
    expect(res.body.items[0].status).toBe('found');
    expect(res.body.items[0].source).toBe('chain');
    expect(res.body.items[1].status).toBe('error');
    expect(res.body.items[1].error).toMatchObject({
      code: 'RPC_FALLBACK_FAILED',
      retryable: true,
    });
    expect(res.body.meta.rpcFallbacksUsed).toBe(MAX_BATCH_RPC_FALLBACKS);
    expect(res.body.meta.rpcFallbackCapped).toBe(true);
    expect(res.body.freshness.source).toBe('chain');
  });

  it('surfaces retryable 503 on primary DB outage and succeeds on retry', async () => {
    prismaMock.stream.findMany
      .mockRejectedValueOnce(new Error('connection pool exhausted'))
      .mockResolvedValueOnce([makeDbStream(7n)]);

    const failed = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ['7'] });
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('BATCH_READ_UNAVAILABLE');
    expect(failed.body.error.details.retryable).toBe(true);

    const retried = await request(app)
      .post('/v1/streams/batch-read')
      .send({ streamIds: ['7'] });
    expect(retried.status).toBe(200);
    expect(retried.body.meta.foundCount).toBe(1);
    expect(retried.body.items[0].streamId).toBe('7');
  });

  it('enforces streams:read scope when an API credential is presented', async () => {
    const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();
    const readKey = createApiCredential({
      walletAddress: wallet,
      name: 'Reader Key',
      scopes: ['streams:read'],
    });
    const wrongScopeKey = createApiCredential({
      walletAddress: wallet,
      name: 'Webhooks Only',
      scopes: ['webhooks:read'],
    });

    prismaMock.stream.findMany.mockResolvedValue([makeDbStream(1n)]);

    const allowed = await request(app)
      .post('/v1/streams/batch-read')
      .set('X-API-Key', readKey.secret)
      .send({ streamIds: ['1'] });
    expect(allowed.status).toBe(200);

    const forbidden = await request(app)
      .post('/v1/streams/batch-read')
      .set('X-API-Key', wrongScopeKey.secret)
      .send({ streamIds: ['1'] });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('INSUFFICIENT_SCOPE');

    revokeApiCredential({ walletAddress: wallet, credentialId: readKey.credential.id });
    const revoked = await request(app)
      .post('/v1/streams/batch-read')
      .set('X-API-Key', readKey.secret)
      .send({ streamIds: ['1'] });
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('CREDENTIAL_REVOKED');
  });
});
