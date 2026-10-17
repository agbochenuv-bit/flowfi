import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';

const {
  mockWithdraw,
  mockPrisma,
  currentUser,
  idempotencyStore,
} = vi.hoisted(() => ({
  mockWithdraw: vi.fn(),
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    idempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
  },
  // In-memory stand-in for the durable idempotency table. Keyed by the
  // composite (wallet, operation, key) tuple; each entry records the request
  // hash and the stored response so retries can replay it.
  idempotencyStore: new Map<
    string,
    { requestHash: string; status: number; body: unknown; createdAt: number }
  >(),
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../../src/services/sorobanService.js', () => ({
  withdraw: mockWithdraw,
  getStreamFromChain: vi.fn(),
  getClaimableFromChain: vi.fn(),
  isStale: vi.fn().mockReturnValue(false),
}));

// Wire the idempotency store into the mocked Prisma client so the withdraw
// handler's idempotency middleware sees a durable, shared backing store.
mockPrisma.idempotencyKey.findUnique.mockImplementation(async ({ where }: any) => {
  const composite = where?.wallet_operation_key ?? where;
  const storeKey = `${composite.wallet}:${composite.operation}:${composite.key}`;
  const entry = idempotencyStore.get(storeKey);
  if (!entry) return null;
  return {
    wallet: composite.wallet,
    operation: composite.operation,
    key: composite.key,
    requestHash: entry.requestHash,
    status: entry.status,
    responseBody: entry.body,
    createdAt: new Date(entry.createdAt),
  };
});

mockPrisma.idempotencyKey.create.mockImplementation(async ({ data }: any) => {
  const storeKey = `${data.wallet}:${data.operation}:${data.key}`;
  if (idempotencyStore.has(storeKey)) {
    const err: any = new Error('Unique constraint failed');
    err.code = 'P2002';
    throw err;
  }
  idempotencyStore.set(storeKey, {
    requestHash: data.requestHash,
    status: data.status,
    body: data.responseBody,
    createdAt: Date.now(),
  });
  return data;
});

mockPrisma.idempotencyKey.update.mockImplementation(async ({ where, data }: any) => {
  const composite = where?.wallet_operation_key ?? where;
  const storeKey = `${composite.wallet}:${composite.operation}:${composite.key}`;
  const entry = idempotencyStore.get(storeKey);
  if (!entry) {
    const err: any = new Error('Record not found');
    err.code = 'P2025';
    throw err;
  }
  if (data.status !== undefined) entry.status = data.status;
  if (data.responseBody !== undefined) entry.body = data.responseBody;
  return { ...entry };
});

mockPrisma.idempotencyKey.deleteMany.mockImplementation(async () => {
  const now = Date.now();
  const retentionMs = 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const [storeKey, entry] of idempotencyStore.entries()) {
    if (now - entry.createdAt > retentionMs) {
      idempotencyStore.delete(storeKey);
      deleted += 1;
    }
  }
  return { count: deleted };
});

// Simple factory — no importOriginal — reliable with pool:forks.
vi.mock('../../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: currentUser.publicKey };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    },
  };
});

import app from '../../../src/app.js';

function makeKeypair() {
  return StellarSdk.Keypair.random();
}

function setAuthAs(keypair: StellarSdk.Keypair): string {
  currentUser.publicKey = keypair.publicKey();
  return 'mock-token';
}

describe('POST /api/v1/streams/:streamId/withdraw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idempotencyStore.clear();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
  });

  it('successfully withdraws claimable amount for the recipient', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 123;
    const stream = {
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      startTime: Math.floor(Date.now() / 1000) - 100,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 50,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };

    mockPrisma.stream.findUnique.mockResolvedValue(stream);
    mockWithdraw.mockResolvedValue({ txHash: 'withdraw-tx-hash' });
    // Mock $transaction to simulate the withdraw handler's transaction
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      // After $executeRawUnsafe, the handler re-reads the stream
      mockPrisma.stream.findUnique.mockResolvedValueOnce({
        ...stream,
        withdrawnAmount: '200',
      });
      return fn(mockPrisma);
    });

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId,
      txHash: 'withdraw-tx-hash',
    });

    // Verify service call with new signature (streamId, recipientAddress)
    expect(mockWithdraw).toHaveBeenCalledWith(BigInt(streamId), recipient.publicKey());
    
    // Verify the atomic SQL increment was called
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalled();

    // Verify event creation
    expect(mockPrisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'WITHDRAWN',
          streamId: BigInt(streamId),
          transactionHash: 'withdraw-tx-hash',
        }),
      })
    );
  });

  it('returns 403 if the caller is not the recipient', async () => {
    const someoneElse = makeKeypair();
    const token = setAuthAs(someoneElse);

    const streamId = 123;
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: makeKeypair().publicKey(), // Different recipient
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      isActive: true,
      isPaused: false,
      updatedAt: new Date(),
    });

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the stream recipient can withdraw from the stream',
    });
  });

  it('returns 404 if stream not found', async () => {
    const user = makeKeypair();
    const token = setAuthAs(user);

    mockPrisma.stream.findUnique.mockResolvedValue(null);

    const response = await request(app)
      .post('/v1/streams/999/withdraw')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Stream not found',
    });
  });

  it('returns 409 if no claimable balance available', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 123;
    const now = Math.floor(Date.now() / 1000);
    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '0',
      startTime: now + 100, // Starts in the future
      lastUpdateTime: now + 100,
      isActive: true,
      isPaused: false,
      updatedAt: new Date(),
    });

    const response = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe('No claimable balance is currently available');
  });

  it('does not double-count withdrawnAmount when the same claim window is withdrawn twice in a row', async () => {
    const recipient = makeKeypair();
    const token = setAuthAs(recipient);

    const streamId = 456;
    const nowSec = Math.floor(Date.now() / 1000);

    // Stateful in-memory representation of the Stream row. Rather than
    // stubbing each call with independent, hand-picked withdrawnAmount
    // values, this object is genuinely mutated by the mocked atomic
    // increment below (mirroring the real
    // `UPDATE "Stream" SET "withdrawnAmount" = withdrawnAmount + $1 ...`
    // SQL), so the second withdraw call's re-fetch actually observes
    // whatever the first call did.
    const streamState = {
      streamId,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '100',
      depositedAmount: '10000000',
      withdrawnAmount: '0',
      startTime: nowSec - 5000,
      lastUpdateTime: nowSec - 5000, // 5000s of unclaimed accrual
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    };

    // Restore the plain pass-through $transaction implementation: an earlier
    // test in this file (the "successful withdraw" case) replaces it with a
    // custom implementation that queues a one-off findUnique() stub, which
    // vi.clearAllMocks() does not undo (it clears call history, not custom
    // implementations). Without this reset, that stale stub would leak into
    // this test's re-fetch.
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    // Both the handler's initial read and the transaction's post-increment
    // re-read go through this, always reflecting the *current* state.
    mockPrisma.stream.findUnique.mockImplementation(async () => ({ ...streamState }));

    // Simulates the handler's atomic SQL increment:
    // UPDATE "Stream" SET "withdrawnAmount" = withdrawnAmount + $1, "lastUpdateTime" = $2
    mockPrisma.$executeRawUnsafe.mockImplementation(
      async (_sql: string, withdrawAmountStr: string, lastUpdateTime: bigint) => {
        streamState.withdrawnAmount = (
          BigInt(streamState.withdrawnAmount) + BigInt(withdrawAmountStr)
        ).toString();
        streamState.lastUpdateTime = Number(lastUpdateTime);
        return undefined;
      },
    );

    mockPrisma.stream.update.mockImplementation(async ({ data }: any) => {
      Object.assign(streamState, data);
      return { ...streamState };
    });

    let sorobanCallCount = 0;
    mockWithdraw.mockImplementation(async () => {
      sorobanCallCount += 1;
      return { txHash: `withdraw-tx-hash-${sorobanCallCount}` };
    });

    // --- First withdraw: claims the full ~5000s * 100/s accrued window ---
    const first = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    const firstClaimed = BigInt(first.body.amount);
    // Allow a little slack for real wall-clock time elapsed while the test
    // was setting up / the request was in flight.
    expect(firstClaimed).toBeGreaterThanOrEqual(499000n);
    expect(first.body.stream.withdrawnAmount).toBe(firstClaimed.toString());

    // --- Second withdraw, immediately after, for the SAME stream/recipient ---
    const second = await request(app)
      .post(`/v1/streams/${streamId}/withdraw`)
      .set('Authorization', `Bearer ${token}`);

    const totalWithdrawn = BigInt(streamState.withdrawnAmount);

    if (second.status === 200) {
      // Some real wall-clock time may legitimately have elapsed between the
      // two requests, so a small additional claim on top of the first is
      // acceptable — but it must be nowhere near a second full claim of the
      // already-withdrawn window (which would indicate double-counting).
      const secondClaimed = BigInt(second.body.amount);
      expect(secondClaimed).toBeLessThan(firstClaimed / 10n);
    } else {
      // No meaningful time has elapsed since the first withdraw bumped
      // lastUpdateTime, so the second call correctly finds nothing left to
      // claim in this window and is rejected.
      expect(second.status).toBe(409);
      expect(second.body.error.message).toBe('No claimable balance is currently available');
    }

    // The critical assertion: withdrawnAmount reflects only the ONE
    // legitimate claim of the accrued window (plus, at most, a negligible
    // sliver of genuinely new accrual) — never a second full claim of the
    // same already-withdrawn window.
    expect(totalWithdrawn).toBeGreaterThanOrEqual(firstClaimed);
    expect(totalWithdrawn).toBeLessThan(firstClaimed * 2n);

    // sorobanWithdraw should only ever have been invoked once per HTTP call
    // (i.e. the second call didn't silently no-op withdraw on-chain either).
    expect(mockWithdraw).toHaveBeenCalledTimes(second.status === 200 ? 2 : 1);
  });

  describe('idempotency', () => {
    function buildStream(recipient: StellarSdk.Keypair, streamId: number) {
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        streamId,
        sender: makeKeypair().publicKey(),
        recipient: recipient.publicKey(),
        ratePerSecond: '10',
        depositedAmount: '100000',
        withdrawnAmount: '0',
        startTime: nowSec - 1000,
        lastUpdateTime: nowSec - 1000,
        isActive: true,
        isPaused: false,
        pausedAt: null,
        totalPausedDuration: 0,
        updatedAt: new Date(),
      };
    }

    it('replays the original result when the same key is retried with identical input', async () => {
      const recipient = makeKeypair();
      const token = setAuthAs(recipient);
      const streamId = 700;
      const stream = buildStream(recipient, streamId);

      mockPrisma.stream.findUnique.mockResolvedValue(stream);
      mockWithdraw.mockResolvedValue({ txHash: 'idem-tx-hash' });

      const first = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'retry-key-1');

      expect(first.status).toBe(200);
      expect(first.body.txHash).toBe('idem-tx-hash');
      expect(mockWithdraw).toHaveBeenCalledTimes(1);

      // Retry with the same key and identical request body.
      const retry = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'retry-key-1');

      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      // The retry must NOT submit a second on-chain transaction.
      expect(mockWithdraw).toHaveBeenCalledTimes(1);
    });

    it('rejects reuse of a key with a different request hash', async () => {
      const recipient = makeKeypair();
      const token = setAuthAs(recipient);
      const streamId = 701;
      const stream = buildStream(recipient, streamId);

      mockPrisma.stream.findUnique.mockResolvedValue(stream);
      mockWithdraw.mockResolvedValue({ txHash: 'first-tx' });

      const first = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'conflict-key')
        .send({ amount: '100' });

      expect(first.status).toBe(200);
      expect(mockWithdraw).toHaveBeenCalledTimes(1);

      // Same key, but the request payload differs -> must be rejected.
      const conflict = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'conflict-key')
        .send({ amount: '999' });

      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      // No additional on-chain submission for the conflicting request.
      expect(mockWithdraw).toHaveBeenCalledTimes(1);
    });

    it('scopes keys per wallet so another wallet may reuse the same key string', async () => {
      const recipientA = makeKeypair();
      const recipientB = makeKeypair();
      const streamId = 702;

      mockPrisma.stream.findUnique.mockImplementation(async () => {
        const active = currentUser.publicKey;
        return buildStream(
          active === recipientA.publicKey() ? recipientA : recipientB,
          streamId,
        );
      });
      mockWithdraw.mockResolvedValue({ txHash: 'scoped-tx' });

      const tokenA = setAuthAs(recipientA);
      const first = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'shared-key');
      expect(first.status).toBe(200);

      const tokenB = setAuthAs(recipientB);
      const second = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${tokenB}`)
        .set('Idempotency-Key', 'shared-key');

      // Different wallet => distinct idempotency scope => executes normally.
      expect(second.status).toBe(200);
      expect(mockWithdraw).toHaveBeenCalledTimes(2);
    });

    it('triggers at most one transaction for concurrent duplicate submissions', async () => {
      const recipient = makeKeypair();
      const token = setAuthAs(recipient);
      const streamId = 703;
      const stream = buildStream(recipient, streamId);

      mockPrisma.stream.findUnique.mockResolvedValue(stream);

      let resolveWithdraw: (value: { txHash: string }) => void = () => {};
      const withdrawGate = new Promise<{ txHash: string }>((resolve) => {
        resolveWithdraw = resolve;
      });
      let sorobanCalls = 0;
      mockWithdraw.mockImplementation(async () => {
        sorobanCalls += 1;
        return withdrawGate;
      });

      const send = () =>
        request(app)
          .post(`/v1/streams/${streamId}/withdraw`)
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', 'concurrent-key');

      const [a, b] = await Promise.all([send(), send()]);

      // Release the in-flight transaction so both requests can settle.
      resolveWithdraw({ txHash: 'concurrent-tx' });
      const [resA, resB] = await Promise.all([a, b]);

      // Exactly one on-chain submission despite two concurrent requests.
      expect(sorobanCalls).toBe(1);

      const statuses = [resA.status, resB.status].sort();
      // One request performs the work (200); the other either replays the
      // stored result (200) or is told the key is in-flight (409).
      expect(statuses[0]).toBe(200);
      expect([200, 409]).toContain(statuses[1]);

      if (resA.status === 200 && resB.status === 200) {
        expect(resA.body).toEqual(resB.body);
      }
    });

    it('does not persist an idempotency record when the command fails', async () => {
      const recipient = makeKeypair();
      const token = setAuthAs(recipient);
      const streamId = 704;
      const stream = buildStream(recipient, streamId);

      mockPrisma.stream.findUnique.mockResolvedValue(stream);
      mockWithdraw.mockRejectedValueOnce(new Error('soroban unavailable'));

      const failed = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'failure-key');

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(idempotencyStore.size).toBe(0);

      // A retry with the same key is allowed to execute again.
      mockWithdraw.mockResolvedValueOnce({ txHash: 'recovered-tx' });
      const retry = await request(app)
        .post(`/v1/streams/${streamId}/withdraw`)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'failure-key');

      expect(retry.status).toBe(200);
      expect(retry.body.txHash).toBe('recovered-tx');
      expect(mockWithdraw).toHaveBeenCalledTimes(2);
    });
  });
});
