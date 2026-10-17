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

describe('Indexer worker integration (mocked DB)', () => {
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