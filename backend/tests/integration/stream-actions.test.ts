import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';

const {
  mockPauseStream,
  mockResumeStream,
  mockWithdraw,
  mockPrisma,
  mockIdempotencyStore,
} = vi.hoisted(() => ({
  mockPauseStream: vi.fn(),
  mockResumeStream: vi.fn(),
  mockWithdraw: vi.fn(),
  mockPrisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
    $disconnect: vi.fn(),
  },
  mockIdempotencyStore: {
    find: vi.fn(),
    insert: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  },
}));

vi.mock('../../src/services/idempotencyStore.js', () => ({
  idempotencyStore: mockIdempotencyStore,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

vi.mock('../../src/services/sorobanService.js', () => ({
  getStreamFromChain: vi.fn().mockResolvedValue(null),
  getClaimableFromChain: vi.fn().mockResolvedValue(null),
  isStale: vi.fn().mockReturnValue(false),
  pauseStream: mockPauseStream,
  resumeStream: mockResumeStream,
  withdraw: mockWithdraw,
}));

import app from '../../src/app.js';

function makeKeypair() {
  return StellarSdk.Keypair.random();
}

function buildSignedTransaction(keypair: StellarSdk.Keypair, nonce: string): string {
  const account = new StellarSdk.Account(keypair.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.manageData({
        name: 'auth',
        value: Buffer.from(nonce, 'hex'),
      }),
    )
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

async function getValidJwt(keypair: StellarSdk.Keypair): Promise<string> {
  const challengeRes = await request(app)
    .post('/v1/auth/challenge')
    .send({ publicKey: keypair.publicKey() });

  const nonce = challengeRes.body.nonce as string;
  const signedTransaction = buildSignedTransaction(keypair, nonce);

  const verifyRes = await request(app)
    .post('/v1/auth/verify')
    .send({ publicKey: keypair.publicKey(), signedTransaction });

  return verifyRes.body.token as string;
}

describe('stream action routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.stream.findMany.mockResolvedValue([]);
    mockPrisma.stream.count.mockResolvedValue(0);
    mockPrisma.streamEvent.findMany.mockResolvedValue([]);
    mockPrisma.streamEvent.count.mockResolvedValue(0);
    mockIdempotencyStore.find.mockResolvedValue(null);
    mockIdempotencyStore.insert.mockResolvedValue({ inserted: true });
    mockIdempotencyStore.complete.mockResolvedValue(undefined);
    mockIdempotencyStore.fail.mockResolvedValue(undefined);
  });

  it('POST /v1/streams/:streamId/pause pauses an active sender-owned stream', async () => {
    const sender = makeKeypair();
    const token = await getValidJwt(sender);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 7,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
    });
    mockPauseStream.mockResolvedValue({ txHash: 'pause-tx-hash' });
    mockPrisma.stream.update.mockResolvedValue({
      streamId: 7,
      isActive: true,
      isPaused: true,
      pausedAt: 1700000000,
      totalPausedDuration: 0,
    });

    const response = await request(app)
      .post('/v1/streams/7/pause')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId: 7,
      txHash: 'pause-tx-hash',
    });
    expect(mockPauseStream).toHaveBeenCalledWith(sender.publicKey(), 7n);
  });

  it('rejects a raw signed transaction bearer token without a JWT', async () => {
    const sender = makeKeypair();
    const rawToken = buildSignedTransaction(sender, '00'.repeat(32));

    const response = await request(app)
      .post('/v1/streams/7/pause')
      .set('Authorization', `Bearer ${rawToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    });
  });

  it('POST /v1/streams/:streamId/resume resumes a paused sender-owned stream', async () => {
    const sender = makeKeypair();
    const token = await getValidJwt(sender);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 9,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      isActive: true,
      isPaused: true,
      pausedAt: Math.floor(Date.now() / 1000) - 30,
      totalPausedDuration: 10,
    });
    mockResumeStream.mockResolvedValue({ txHash: 'resume-tx-hash' });
    mockPrisma.stream.update.mockResolvedValue({
      streamId: 9,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 40,
    });

    const response = await request(app)
      .post('/v1/streams/9/resume')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId: 9,
      txHash: 'resume-tx-hash',
    });
    expect(mockResumeStream).toHaveBeenCalledWith(sender.publicKey(), 9n);
  });

  it('rejects pause from a wallet that does not own the stream', async () => {
    const sender = makeKeypair();
    const attacker = makeKeypair();
    const token = await getValidJwt(attacker);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 7,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
    });

    const response = await request(app)
      .post('/v1/streams/7/pause')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(mockPauseStream).not.toHaveBeenCalled();
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();
  });

  it('ignores a client-supplied sender address when pausing', async () => {
    const sender = makeKeypair();
    const attacker = makeKeypair();
    const token = await getValidJwt(attacker);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 7,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
    });

    const response = await request(app)
      .post('/v1/streams/7/pause')
      .set('Authorization', `Bearer ${token}`)
      .send({ sender: sender.publicKey() });

    expect(response.status).toBe(403);
    expect(mockPauseStream).not.toHaveBeenCalled();
  });

  it('rejects resume from a wallet that does not own the stream', async () => {
    const sender = makeKeypair();
    const attacker = makeKeypair();
    const token = await getValidJwt(attacker);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 9,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      isActive: true,
      isPaused: true,
      pausedAt: Math.floor(Date.now() / 1000) - 30,
      totalPausedDuration: 10,
    });

    const response = await request(app)
      .post('/v1/streams/9/resume')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(mockResumeStream).not.toHaveBeenCalled();
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();
  });

  it('rejects withdraw from a wallet that is not the recipient', async () => {
    const recipient = makeKeypair();
    const attacker = makeKeypair();
    const token = await getValidJwt(attacker);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 11,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      startTime: Math.floor(Date.now() / 1000) - 50,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 10,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    });

    const response = await request(app)
      .post('/v1/streams/11/withdraw')
      .set('Authorization', `Bearer ${token}`)
      .send({ recipient: recipient.publicKey() });

    expect(response.status).toBe(403);
    expect(mockWithdraw).not.toHaveBeenCalled();
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();
  });

  it('rejects top-up from a wallet that is not the sender', async () => {
    const sender = makeKeypair();
    const attacker = makeKeypair();
    const token = await getValidJwt(attacker);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 13,
      sender: sender.publicKey(),
      recipient: makeKeypair().publicKey(),
      depositedAmount: '1000',
      isActive: true,
      isPaused: false,
    });

    const response = await request(app)
      .post('/v1/streams/13/top-up')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '100', sender: sender.publicKey() });

    expect(response.status).toBe(403);
    expect(mockPrisma.stream.update).not.toHaveBeenCalled();
  });

  it('POST /v1/streams/:streamId/withdraw withdraws the claimable amount for the recipient', async () => {
    const recipient = makeKeypair();
    const token = await getValidJwt(recipient);

    mockPrisma.stream.findUnique.mockResolvedValue({
      streamId: 11,
      sender: makeKeypair().publicKey(),
      recipient: recipient.publicKey(),
      ratePerSecond: '10',
      depositedAmount: '1000',
      withdrawnAmount: '100',
      startTime: Math.floor(Date.now() / 1000) - 50,
      lastUpdateTime: Math.floor(Date.now() / 1000) - 10,
      isActive: true,
      isPaused: false,
      pausedAt: null,
      totalPausedDuration: 0,
      updatedAt: new Date(),
    });
    mockWithdraw.mockResolvedValue({ txHash: 'withdraw-tx-hash' });
    mockPrisma.stream.update.mockResolvedValue({
      streamId: 11,
      withdrawnAmount: '600',
      isActive: true,
    });

    const response = await request(app)
      .post('/v1/streams/11/withdraw')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      streamId: 11,
      txHash: 'withdraw-tx-hash',
      amount: '100',
    });
    expect(mockWithdraw).toHaveBeenCalledWith(11n, recipient.publicKey());
    expect(mockPrisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: 'WITHDRAWN',
          amount: '100',
          transactionHash: 'withdraw-tx-hash',
        }),
      }),
    );
  });

  describe('idempotency', () => {
    const IDEMPOTENCY_KEY = 'retry-key-0001';

    function mockPausableStream(sender: StellarSdk.Keypair) {
      mockPrisma.stream.findUnique.mockResolvedValue({
        streamId: 7,
        sender: sender.publicKey(),
        recipient: makeKeypair().publicKey(),
        isActive: true,
        isPaused: false,
        pausedAt: null,
        totalPausedDuration: 0,
      });
      mockPrisma.stream.update.mockResolvedValue({
        streamId: 7,
        isActive: true,
        isPaused: true,
        pausedAt: 1700000000,
        totalPausedDuration: 0,
      });
    }

    it('returns the original result when retried with the same key and input', async () => {
      const sender = makeKeypair();
      const token = await getValidJwt(sender);
      mockPausableStream(sender);
      mockPauseStream.mockResolvedValue({ txHash: 'pause-tx-hash' });

      const first = await request(app)
        .post('/v1/streams/7/pause')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY);

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        success: true,
        streamId: 7,
        txHash: 'pause-tx-hash',
      });
      expect(mockPauseStream).toHaveBeenCalledTimes(1);

      // Simulate the stored record from the first request being replayed.
      mockIdempotencyStore.find.mockResolvedValue({
        key: IDEMPOTENCY_KEY,
        wallet: sender.publicKey(),
        operation: 'pause',
        requestHash: first.headers['idempotency-request-hash'],
        status: 'COMPLETED',
        responseStatus: 200,
        responseBody: first.body,
      });

      const retry = await request(app)
        .post('/v1/streams/7/pause')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY);

      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(mockPauseStream).toHaveBeenCalledTimes(1);
    });

    it('rejects key reuse with changed input with IDEMPOTENCY_CONFLICT', async () => {
      const sender = makeKeypair();
      const token = await getValidJwt(sender);
      mockPausableStream(sender);
      mockPauseStream.mockResolvedValue({ txHash: 'pause-tx-hash' });

      mockIdempotencyStore.find.mockResolvedValue({
        key: IDEMPOTENCY_KEY,
        wallet: sender.publicKey(),
        operation: 'pause',
        requestHash: 'hash-of-original-request',
        status: 'COMPLETED',
        responseStatus: 200,
        responseBody: { success: true, streamId: 7, txHash: 'pause-tx-hash' },
      });

      const response = await request(app)
        .post('/v1/streams/7/pause')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send({ reason: 'different input' });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: 'IDEMPOTENCY_CONFLICT',
      });
      expect(mockPauseStream).not.toHaveBeenCalled();
    });

    it('triggers at most one transaction for concurrent duplicate submissions', async () => {
      const sender = makeKeypair();
      const token = await getValidJwt(sender);
      mockPausableStream(sender);

      let resolvePause: (value: { txHash: string }) => void = () => {};
      mockPauseStream.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePause = resolve;
          }),
      );

      // First caller wins the insert; the second observes an in-flight record.
      mockIdempotencyStore.insert
        .mockResolvedValueOnce({ inserted: true })
        .mockResolvedValueOnce({ inserted: false });

      const first = request(app)
        .post('/v1/streams/7/pause')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY);

      const second = request(app)
        .post('/v1/streams/7/pause')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', IDEMPOTENCY_KEY);

      // Let the in-flight duplicate observe the pending record.
      mockIdempotencyStore.find.mockResolvedValue({
        key: IDEMPOTENCY_KEY,
        wallet: sender.publicKey(),
        operation: 'pause',
        requestHash: 'pending-request-hash',
        status: 'IN_PROGRESS',
        responseStatus: null,
        responseBody: null,
      });

      resolvePause({ txHash: 'pause-tx-hash' });

      const [firstRes, secondRes] = await Promise.all([first, second]);

      expect(mockPauseStream).toHaveBeenCalledTimes(1);
      expect([firstRes.status, secondRes.status]).toContain(200);
      expect([firstRes.status, secondRes.status]).toContain(409);
    });
  });
});
