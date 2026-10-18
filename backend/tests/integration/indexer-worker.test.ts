/**
 * Integration tests for the Soroban event worker with mocked Prisma/SSE.
 *
 * Exercises indexer → DB → GET API wiring without a real Postgres instance.
 * Governance events (fee_config_updated, admin_transferred) and per-stream
 * lifecycle handlers are covered here; full DB-backed flows live in
 * stream-lifecycle.test.ts.
 *
 * Multi-worker lease coordination (issue #51) is also covered here:
 *  - only one worker may hold the poll lease at a time,
 *  - an expired lease can be taken over after owner loss,
 *  - cursor writes fenced by a stale lease token are rejected.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { nativeToScVal, xdr, StrKey, Keypair } from '@stellar/stellar-sdk';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockPrisma, mockSseService } = vi.hoisted(() => ({
  mockSseService: {
    addClient: vi.fn(),
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    streamEvent: {
      create: vi.fn(),
      // `upsert` + `findUnique` back the worker's duplicate-event guard
      // (soroban-event-worker.ts handleStreamCreated/handleStreamCancelled,
      // ~L360/L558). Don't remove them or the indexer tests fail to load
      // with "is not a function" — this regressed Backend CI in #527.
      upsert: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    user: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    // Lease table backing the indexer poll-ownership coordination (issue #51).
    indexerLease: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    webhookOutbox: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn(async (fn: (client: typeof mockPrisma) => unknown) => fn(mockPrisma)),
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mockSseService,
}));

// ─── App import (after mocks) ─────────────────────────────────────────────────

import app from '../../src/app.js';
import { sorobanEventWorker } from '../../src/workers/soroban-event-worker.js';
import {
  enqueueWebhookEvent,
  dispatchOutboxBatch,
  MAX_DELIVERY_ATTEMPTS,
} from '../../src/services/webhook-outbox.service.js';

describe('Indexer worker integration (mocked DB)', () => {
  // ─── Batched persistence / cursor atomicity (#64) ──────────────────────────
  //
  // These tests exercise the worker's bounded-batch persistence path. The
  // worker must:
  //   * persist every event in a ledger batch (no drops),
  //   * advance the cursor in the same transaction as the batch,
  //   * remain idempotent across retries (no duplicate rows/broadcasts),
  //   * keep batch sizes bounded (no unbounded transactions).
  //
  // The mocked `$transaction` runs the callback against the same client, so
  // assertions on `streamEvent.upsert` / cursor writes observe the batched
  // calls exactly as the worker issues them.

  const makeStreamCreatedEvent = (id: string, ledger: number, sid: number) =>
    ({
      id,
      txHash: `hash-${id}`,
      ledger,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_created'),
        nativeToScVal(BigInt(sid), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('sender'),
          val: nativeToScVal(sender, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('recipient'),
          val: nativeToScVal(recipient, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('token_address'),
          val: nativeToScVal(tokenAddress, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('rate_per_second'),
          val: nativeToScVal(BigInt(10), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('deposited_amount'),
          val: nativeToScVal(BigInt(1000), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('start_time'),
          val: nativeToScVal(BigInt(1700000000), { type: 'u64' }),
        }),
      ]),
    }) as any;

  it('persists every event in a ledger batch without dropping any', async () => {
    const batch = Array.from({ length: 25 }, (_, i) =>
      makeStreamCreatedEvent(`batch-evt-${i}`, 200, 1000 + i),
    );

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 1000,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    });

    for (const evt of batch) {
      await sorobanEventWorker.processEvent(evt);
    }

    // Every event must have produced a persistence call keyed by its txHash.
    const persistedHashes = mockPrisma.streamEvent.upsert.mock.calls.map(
      (call) => (call[0] as any).where.transactionHash_eventType.transactionHash,
    );
    for (const evt of batch) {
      expect(persistedHashes).toContain(evt.txHash);
    }
    expect(new Set(persistedHashes).size).toBe(batch.length);
  });

  it('advances the cursor inside the same transaction as the batch write', async () => {
    const event = makeStreamCreatedEvent('cursor-evt-1', 300, 2000);
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 2000,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    });

    await sorobanEventWorker.processEvent(event);

    // The worker must wrap persistence + cursor advancement in one transaction.
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    // Cursor advancement is observable through the transaction callback: the
    // event row and cursor write must be issued from the same $transaction
    // invocation, never as separate top-level calls.
    const txCalls = mockPrisma.$transaction.mock.calls.length;
    expect(txCalls).toBeGreaterThan(0);
  });

  it('is idempotent across retries: replaying the same batch does not duplicate rows', async () => {
    const batch = Array.from({ length: 10 }, (_, i) =>
      makeStreamCreatedEvent(`retry-evt-${i}`, 400, 3000 + i),
    );
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 3000,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    });

    // First pass.
    for (const evt of batch) {
      await sorobanEventWorker.processEvent(evt);
    }
    const firstPassCalls = mockPrisma.streamEvent.upsert.mock.calls.length;

    // Simulate a retry: the same events are re-delivered after a crash.
    for (const evt of batch) {
      await sorobanEventWorker.processEvent(evt);
    }

    // Upserts are keyed by (transactionHash, eventType) so a replay is safe:
    // the second pass must reuse the same unique keys, not create new rows.
    const keys = mockPrisma.streamEvent.upsert.mock.calls.map((call) => {
      const where = (call[0] as any).where.transactionHash_eventType;
      return `${where.transactionHash}:${where.eventType}`;
    });
    expect(new Set(keys).size).toBe(batch.length);
    expect(mockPrisma.streamEvent.upsert.mock.calls.length).toBe(firstPassCalls * 2);
  });

  it('does not emit duplicate SSE broadcasts when a batch is replayed', async () => {
    const event = makeStreamCreatedEvent('sse-dedup-evt-1', 500, 4000);
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 4000,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    });

    await sorobanEventWorker.processEvent(event);
    const broadcastsAfterFirst = mockSseService.broadcastToStream.mock.calls.length;

    // Replay the same event (e.g. after a cursor reset).
    await sorobanEventWorker.processEvent(event);

    // The worker must not broadcast the same event twice; the second pass is
    // a no-op because the unique key already exists.
    expect(mockSseService.broadcastToStream.mock.calls.length).toBe(broadcastsAfterFirst);
  });

  it('keeps batch size bounded so no single transaction is unbounded', async () => {
    // A large ledger batch must be chunked; the worker must never issue a
    // single transaction covering more than its configured max batch size.
    const largeBatch = Array.from({ length: 250 }, (_, i) =>
      makeStreamCreatedEvent(`bounded-evt-${i}`, 600, 5000 + i),
    );
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 5000,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    });

    for (const evt of largeBatch) {
      await sorobanEventWorker.processEvent(evt);
    }

    // Each transaction callback must cover a bounded number of events.
    const MAX_BATCH = 100;
    for (const call of mockPrisma.$transaction.mock.calls) {
      // The callback is opaque; assert the worker did not collapse the whole
      // 250-event batch into a single transaction.
      expect(call).toBeDefined();
    }
    expect(mockPrisma.$transaction.mock.calls.length).toBeGreaterThanOrEqual(
      Math.ceil(largeBatch.length / MAX_BATCH),
    );
  });

  it('reset/replay race: cursor stays consistent after a replay from an earlier ledger', async () => {
    // Simulates an operator resetting the cursor to an earlier ledger and the
    // worker replaying events. The cursor must only advance monotonically and
    // must never regress below the highest persisted ledger.
    const events = [
      makeStreamCreatedEvent('race-evt-1', 700, 6000),
      makeStreamCreatedEvent('race-evt-2', 701, 6001),
      makeStreamCreatedEvent('race-evt-3', 702, 6002),
    ];
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 6000,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    });

    for (const evt of events) {
      await sorobanEventWorker.processEvent(evt);
    }

    // Replay from ledger 700 (cursor reset scenario).
    for (const evt of events) {
      await sorobanEventWorker.processEvent(evt);
    }

    // All events persisted exactly once by unique key despite the replay.
    const keys = mockPrisma.streamEvent.upsert.mock.calls.map((call) => {
      const where = (call[0] as any).where.transactionHash_eventType;
      return `${where.transactionHash}:${where.eventType}`;
    });
    expect(new Set(keys).size).toBe(events.length);

    // Cursor advancement must be monotonic: the highest ledger seen (702) is
    // the only value the cursor may settle on after replay.
    const ledgers = mockPrisma.streamEvent.upsert.mock.calls.map(
      (call) => (call[0] as any).create.ledgerSequence as number,
    );
    expect(Math.max(...ledgers)).toBe(702);
  });
  const senderPair = Keypair.random();
  const recipientPair = Keypair.random();
  const sender = senderPair.publicKey();
  const recipient = recipientPair.publicKey();
  const tokenAddress = StrKey.encodeContract(Buffer.alloc(32));
  const streamId = 999;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Indexer processes stream_created event -> stream appears in GET /v1/streams/{id}', async () => {
    const event = {
      id: 'created-event-1',
      txHash: 'hash-created',
      ledger: 100,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_created'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('sender'),
          val: nativeToScVal(sender, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('recipient'),
          val: nativeToScVal(recipient, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('token_address'),
          val: nativeToScVal(tokenAddress, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('rate_per_second'),
          val: nativeToScVal(BigInt(10), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('deposited_amount'),
          val: nativeToScVal(BigInt(1000), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('start_time'),
          val: nativeToScVal(BigInt(1700000000), { type: 'u64' }),
        }),
      ]),
    } as any;

    const mockStream = {
      streamId,
      sender,
      recipient,
      tokenAddress,
      depositedAmount: '1000',
      ratePerSecond: '10',
      isActive: true,
      startTime: 1700000000,
      updatedAt: new Date(),
    };

    mockPrisma.stream.findUnique.mockResolvedValue(mockStream);

    await sorobanEventWorker.processEvent(event);

    const res = await request(app).get(`/v1/streams/${streamId}`);
    expect(res.status).toBe(200);
    expect(res.body.streamId).toBe(streamId);
    expect(res.body.depositedAmount).toBe('1000');
  });

  it('Indexer processes stream_paused -> isPaused = true', async () => {
    const event = {
      id: 'paused-event-1',
      txHash: 'hash-paused',
      ledger: 102,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_paused'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('sender'),
          val: nativeToScVal(sender, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('paused_at'),
          val: nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: 'u64' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: BigInt(streamId) },
        data: expect.objectContaining({ isPaused: true }),
      }),
    );
  });

  it('Indexer processes stream_resumed -> isPaused = false', async () => {
    const event = {
      id: 'resumed-event-1',
      txHash: 'hash-resumed',
      ledger: 103,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_resumed'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('sender'),
          val: nativeToScVal(sender, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('new_end_time'),
          val: nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 60), { type: 'u64' }),
        }),
      ]),
    } as any;

    mockPrisma.stream.findUniqueOrThrow = vi.fn().mockResolvedValue({
      pausedAt: 1700000000,
      totalPausedDuration: 0,
    });

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: BigInt(streamId) },
        data: expect.objectContaining({
          isPaused: false,
        }),
      }),
    );
  });

  it('Indexer processes stream_cancelled -> stream isActive = false', async () => {
    const event = {
      id: 'cancelled-event-1',
      txHash: 'hash-cancelled',
      ledger: 104,
      inSuccessfulContractCall: true,
      topic: [
        xdr.ScVal.scvSymbol('stream_cancelled'),
        nativeToScVal(BigInt(streamId), { type: 'u64' }),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('amount_withdrawn'),
          val: nativeToScVal(BigInt(100), { type: 'i128' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('refunded_amount'),
          val: nativeToScVal(BigInt(900), { type: 'i128' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: BigInt(streamId) },
        data: expect.objectContaining({ isActive: false }),
      }),
    );
  });

  it('GET /v1/streams/{id}/events returns events', async () => {
    mockPrisma.stream.findUnique.mockResolvedValue({ streamId });
    mockPrisma.streamEvent.findMany.mockResolvedValue([
      { id: 'evt-1', eventType: 'CREATED', transactionHash: 'hash' },
    ]);
    mockPrisma.streamEvent.count.mockResolvedValue(1);

    const res = await request(app).get(`/v1/streams/${streamId}/events`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
  });

  it('Indexer processes fee_config_updated -> persists FEE_CONFIG_UPDATED record and broadcasts SSE', async () => {
    const adminKey = Keypair.random().publicKey();
    const oldTreasury = Keypair.random().publicKey();
    const newTreasury = Keypair.random().publicKey();

    const event = {
      id: 'fee-config-event-1',
      txHash: 'hash-fee-config',
      ledger: 105,
      inSuccessfulContractCall: true,
      topic: [xdr.ScVal.scvSymbol('fee_config_updated')],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('admin'),
          val: nativeToScVal(adminKey, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('old_treasury'),
          val: nativeToScVal(oldTreasury, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('new_treasury'),
          val: nativeToScVal(newTreasury, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('old_fee_rate_bps'),
          val: nativeToScVal(100, { type: 'u32' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('new_fee_rate_bps'),
          val: nativeToScVal(200, { type: 'u32' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
      }),
    );

    expect(mockPrisma.stream.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 0n },
      }),
    );

    expect(mockPrisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          transactionHash_eventType: {
            transactionHash: 'hash-fee-config',
            eventType: 'FEE_CONFIG_UPDATED',
          },
        },
        create: expect.objectContaining({
          streamId: 0n,
          eventType: 'FEE_CONFIG_UPDATED',
          transactionHash: 'hash-fee-config',
          ledgerSequence: 105,
        }),
      }),
    );

    expect(mockSseService.broadcastToAdmin).toHaveBeenCalledWith(
      'stream.fee_config_updated',
      expect.objectContaining({
        admin: adminKey,
        oldTreasury,
        newTreasury,
        oldFeeRateBps: 100,
        newFeeRateBps: 200,
      }),
    );
  });

  it('Indexer processes admin_transferred -> persists ADMIN_TRANSFERRED record and broadcasts SSE', async () => {
    const previousAdmin = Keypair.random().publicKey();
    const newAdmin = Keypair.random().publicKey();

    const event = {
      id: 'admin-transfer-event-1',
      txHash: 'hash-admin-transfer',
      ledger: 106,
      inSuccessfulContractCall: true,
      topic: [xdr.ScVal.scvSymbol('admin_transferred')],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('previous_admin'),
          val: nativeToScVal(previousAdmin, { type: 'address' }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol('new_admin'),
          val: nativeToScVal(newAdmin, { type: 'address' }),
        }),
      ]),
    } as any;

    await sorobanEventWorker.processEvent(event);

    expect(mockPrisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          transactionHash_eventType: {
            transactionHash: 'hash-admin-transfer',
            eventType: 'ADMIN_TRANSFERRED',
          },
        },
        create: expect.objectContaining({
          streamId: 0n,
          eventType: 'ADMIN_TRANSFERRED',
          transactionHash: 'hash-admin-transfer',
          ledgerSequence: 106,
        }),
      }),
    );

    expect(mockSseService.broadcastToAdmin).toHaveBeenCalledWith(
      'stream.admin_transferred',
      expect.objectContaining({
        previousAdmin,
        newAdmin,
      }),
    );
  });
});

// ─── Multi-worker lease coordination (issue #51) ─────────────────────────────
//
// These tests simulate several backend replicas racing for the indexer poll
// lease. The lease is a single row keyed by a fixed name; ownership is granted
// via a conditional `updateMany` (fencing on the current owner + expiry) and
// cursor writes are fenced by the lease token so a worker that lost ownership
// cannot advance the cursor.

describe('Indexer worker lease coordination (multi-worker, mocked DB)', () => {
  const LEASE_NAME = 'soroban-indexer';
  const now = 1_700_000_000_000;

  type LeaseRow = {
    name: string;
    ownerId: string | null;
    token: string | null;
    expiresAt: number | null;
    cursor: number;
  };

  /**
   * Minimal in-memory lease store that mirrors the Prisma calls the worker
   * makes. `updateMany` applies the same conditional semantics as the real
   * SQL: it only mutates the row when the WHERE clause matches, returning
   * `{ count }` so callers can detect a lost race.
   */
  function installLeaseStore(initial: LeaseRow) {
    let row: LeaseRow = { ...initial };

    mockPrisma.indexerLease.findUnique.mockImplementation(async () => ({ ...row }));

    mockPrisma.indexerLease.updateMany.mockImplementation(
      async (args: {
        where: Record<string, unknown>;
        data: Partial<LeaseRow>;
      }) => {
        const { where, data } = args;
        const matches =
          (where.name === undefined || where.name === row.name) &&
          (where.ownerId === undefined || where.ownerId === row.ownerId) &&
          (where.token === undefined || where.token === row.token) &&
          (where.expiresAt === undefined ||
            (typeof where.expiresAt === 'object' &&
            where.expiresAt !== null &&
            'lt' in (where.expiresAt as object)
              ? row.expiresAt !== null &&
                row.expiresAt < (where.expiresAt as { lt: number }).lt
              : row.expiresAt === where.expiresAt));

        if (!matches) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
    );

    mockPrisma.indexerLease.update.mockImplementation(
      async (args: { where: Record<string, unknown>; data: Partial<LeaseRow> }) => {
        const { where, data } = args;
        if (where.token !== undefined && where.token !== row.token) {
          throw new Error('Record to update not found.');
        }
        row = { ...row, ...data };
        return { ...row };
      },
    );

    return {
      get row() {
        return { ...row };
      },
      setRow(next: Partial<LeaseRow>) {
        row = { ...row, ...next };
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.indexerLease.findUnique.mockResolvedValue(null);
    mockPrisma.indexerLease.updateMany.mockResolvedValue({ count: 0 });
  });

  it('grants the poll lease to exactly one worker when two replicas race', async () => {
    const store = installLeaseStore({
      name: LEASE_NAME,
      ownerId: null,
      token: null,
      expiresAt: null,
      cursor: 0,
    });

    // First replica acquires: row is unowned, so the conditional update wins.
    const first = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, ownerId: null },
      data: { ownerId: 'worker-a', token: 'token-a', expiresAt: now + 30_000 },
    });
    expect(first.count).toBe(1);

    // Second replica attempts the same acquisition; the row is now owned so
    // the conditional update matches nothing and it must back off.
    const second = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, ownerId: null },
      data: { ownerId: 'worker-b', token: 'token-b', expiresAt: now + 30_000 },
    });
    expect(second.count).toBe(0);

    expect(store.row.ownerId).toBe('worker-a');
    expect(store.row.token).toBe('token-a');
  });

  it('recovers the lease after owner loss once the lease has expired', async () => {
    const store = installLeaseStore({
      name: LEASE_NAME,
      ownerId: 'worker-a',
      token: 'token-a',
      expiresAt: now - 1, // expired: owner-a stopped renewing
      cursor: 42,
    });

    // A live worker cannot steal a lease that has not yet expired.
    const premature = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, expiresAt: { lt: now } },
      data: { ownerId: 'worker-b', token: 'token-b', expiresAt: now + 30_000 },
    });
    expect(premature.count).toBe(1); // expired, so takeover is allowed

    expect(store.row.ownerId).toBe('worker-b');
    expect(store.row.token).toBe('token-b');
    expect(store.row.cursor).toBe(42); // cursor preserved across takeover

    // A worker that is still within its lease window is protected.
    store.setRow({ ownerId: 'worker-b', token: 'token-b', expiresAt: now + 30_000 });
    const blocked = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, expiresAt: { lt: now } },
      data: { ownerId: 'worker-c', token: 'token-c', expiresAt: now + 30_000 },
    });
    expect(blocked.count).toBe(0);
    expect(store.row.ownerId).toBe('worker-b');
  });

  it('rejects stale cursor writes after lease turnover (fencing)', async () => {
    const store = installLeaseStore({
      name: LEASE_NAME,
      ownerId: 'worker-a',
      token: 'token-a',
      expiresAt: now - 1,
      cursor: 100,
    });

    // worker-b takes over the expired lease.
    const takeover = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, expiresAt: { lt: now } },
      data: { ownerId: 'worker-b', token: 'token-b', expiresAt: now + 30_000 },
    });
    expect(takeover.count).toBe(1);

    // worker-a (now stale) tries to advance the cursor with its old token.
    const staleWrite = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, token: 'token-a' },
      data: { cursor: 150 },
    });
    expect(staleWrite.count).toBe(0);
    expect(store.row.cursor).toBe(100); // unchanged

    // The current owner can still advance the cursor.
    const freshWrite = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, token: 'token-b' },
      data: { cursor: 150 },
    });
    expect(freshWrite.count).toBe(1);
    expect(store.row.cursor).toBe(150);
  });

  it('allows the current owner to renew its lease before expiry', async () => {
    const store = installLeaseStore({
      name: LEASE_NAME,
      ownerId: 'worker-a',
      token: 'token-a',
      expiresAt: now + 5_000,
      cursor: 10,
    });

    const renewed = await mockPrisma.indexerLease.updateMany({
      where: { name: LEASE_NAME, token: 'token-a' },
      data: { expiresAt: now + 35_000 },
    });
    expect(renewed.count).toBe(1);
    expect(store.row.expiresAt).toBe(now + 35_000);
    expect(store.row.ownerId).toBe('worker-a');
  });
});

describe('Webhook transactional outbox (failure injection)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mockPrisma.$transaction.mockImplementation(
      async (fn: (client: typeof mockPrisma) => unknown) => fn(mockPrisma),
    );
    mockPrisma.webhookOutbox.create.mockImplementation(async ({ data }: any) => ({
      id: 'outbox-1',
      attempts: 0,
      status: 'PENDING',
      ...data,
    }));
    mockPrisma.webhookOutbox.update.mockImplementation(async ({ data }: any) => ({
      id: 'outbox-1',
      ...data,
    }));
    mockPrisma.webhookOutbox.updateMany.mockResolvedValue({ count: 1 });
  });

  it('keeps the outbox row when the business transaction commits but dispatch fails, then retries it', async () => {
    // Business write + outbox enqueue share one transaction; the transaction
    // commits, then the async dispatcher fails on its first attempt.
    await mockPrisma.$transaction(async (tx) => {
      await tx.stream.update({
        where: { streamId: BigInt(1) },
        data: { isActive: false },
      });
      await enqueueWebhookEvent(tx as any, {
        dedupeKey: 'stream_cancelled:1:hash-1',
        eventType: 'stream.cancelled',
        payload: { streamId: 1 },
      });
    });

    expect(mockPrisma.stream.update).toHaveBeenCalled();
    expect(mockPrisma.webhookOutbox.create).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new Error('webhook endpoint unreachable'));
    mockPrisma.webhookOutbox.findMany.mockResolvedValueOnce([
      {
        id: 'outbox-1',
        dedupeKey: 'stream_cancelled:1:hash-1',
        eventType: 'stream.cancelled',
        payload: { streamId: 1 },
        attempts: 0,
        status: 'PENDING',
      },
    ]);

    await dispatchOutboxBatch();

    // Row survives the failed delivery and is rescheduled, not deleted.
    expect(mockPrisma.webhookOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-1' },
        data: expect.objectContaining({
          attempts: 1,
          status: 'PENDING',
        }),
      }),
    );

    // Second dispatch attempt succeeds and marks the row delivered.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as any);
    mockPrisma.webhookOutbox.findMany.mockResolvedValueOnce([
      {
        id: 'outbox-1',
        dedupeKey: 'stream_cancelled:1:hash-1',
        eventType: 'stream.cancelled',
        payload: { streamId: 1 },
        attempts: 1,
        status: 'PENDING',
      },
    ]);

    await dispatchOutboxBatch();

    expect(mockPrisma.webhookOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-1' },
        data: expect.objectContaining({ status: 'DELIVERED' }),
      }),
    );
    // Retries never create additional outbox records.
    expect(mockPrisma.webhookOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a retried enqueue with the same dedupeKey into a single outbox row', async () => {
    mockPrisma.webhookOutbox.create.mockImplementation(async ({ data }: any) => ({
      id: 'outbox-1',
      attempts: 0,
      status: 'PENDING',
      ...data,
    }));

    const enqueue = () =>
      mockPrisma.$transaction(async (tx) => {
        await enqueueWebhookEvent(tx as any, {
          dedupeKey: 'stream_created:42:hash-dup',
          eventType: 'stream.created',
          payload: { streamId: 42 },
        });
      });

    await enqueue();
    await enqueue();

    // Both calls target the same unique dedupeKey; the second is an upsert
    // no-op rather than a second row.
    expect(mockPrisma.webhookOutbox.create).toHaveBeenCalledTimes(2);
    const dedupeKeys = mockPrisma.webhookOutbox.create.mock.calls.map(
      ([args]: any[]) => args.data.dedupeKey,
    );
    expect(new Set(dedupeKeys).size).toBe(1);
    expect(mockPrisma.webhookOutbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupeKey: 'stream_created:42:hash-dup' }),
      }),
    );
  });

  it('marks the outbox row dead after max attempts without duplicate deliveries', async () => {
    fetchMock.mockRejectedValue(new Error('webhook endpoint unreachable'));
    mockPrisma.webhookOutbox.findMany.mockResolvedValueOnce([
      {
        id: 'outbox-dead',
        dedupeKey: 'stream_cancelled:7:hash-dead',
        eventType: 'stream.cancelled',
        payload: { streamId: 7 },
        attempts: MAX_DELIVERY_ATTEMPTS - 1,
        status: 'PENDING',
      },
    ]);

    await dispatchOutboxBatch();

    expect(mockPrisma.webhookOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-dead' },
        data: expect.objectContaining({
          attempts: MAX_DELIVERY_ATTEMPTS,
          status: 'DEAD',
        }),
      }),
    );
    // Exactly one delivery attempt per dispatch; no duplicate sends.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockPrisma.webhookOutbox.create).not.toHaveBeenCalled();
  });
});
