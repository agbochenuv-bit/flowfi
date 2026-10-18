import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
  },
  SSEService: vi.fn(() => ({
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
  })),
}));

vi.mock('../../../src/services/sorobanService.js', () => ({
  cancelStream: vi.fn().mockResolvedValue('tx_hash_123'),
  getStreamFromChain: vi.fn(),
  getClaimableFromChain: vi.fn(),
  isStale: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/lib/prisma.js', () => {
  const mockPrisma = {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
    },
  };
  return {
    prisma: mockPrisma,
    default: mockPrisma,
  };
});

// Mock auth middleware to bypass real Stellar signature verification.
// Uses a simple factory (no importOriginal) so it is reliable with pool:forks.
vi.mock('../../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: 'G_SENDER_123' };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    },
  };
});

// ─── App import (after mocks) ───────────────────────────────────────────────

import app from '../../../src/app.js';
import * as sorobanService from '../../../src/services/sorobanService.js';
import { prisma } from '../../../src/lib/prisma.js';

describe('POST /v1/streams/:streamId/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully cancels an active stream when called by the sender', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (prisma.stream.update as any).mockResolvedValue({ ...mockStream, isActive: false });

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ senderSecret: 'S_SECRET_123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      txHash: 'tx_hash_123',
      status: 'CANCELLED',
    });

    expect(sorobanService.cancelStream).toHaveBeenCalledWith(BigInt(streamId), 'S_SECRET_123');
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: BigInt(streamId) },
      data: { isActive: false },
    });
  });

  it('returns 400 if senderSecret is not provided in the request body', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('senderSecret');
    expect(sorobanService.cancelStream).not.toHaveBeenCalled();
  });

  it('returns 403 if the caller is not the stream sender', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_DIFFERENT_SENDER',
      isActive: true,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the sender can cancel the stream',
    });
    expect(sorobanService.cancelStream).not.toHaveBeenCalled();
  });

  it('returns 404 if the stream does not exist in DB', async () => {
    const streamId = 999;
    (prisma.stream.findUnique as any).mockResolvedValue(null);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(404);
    expect(sorobanService.cancelStream).not.toHaveBeenCalled();
  });

  it('returns 409 if the stream is already inactive', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: false,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already cancelled');
  });

  it('handles concurrent cancel requests correctly', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    };

    // Both requests observe the active stream, so each performs its own
    // on-chain cancel and marks the stream inactive.
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (prisma.stream.update as any).mockResolvedValue({ ...mockStream, isActive: false });
    (sorobanService.cancelStream as any).mockResolvedValue('tx_hash_123');

    // Run two concurrent cancel requests
    const promise1 = request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ senderSecret: 'S_SECRET_123' });
    const promise2 = request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ senderSecret: 'S_SECRET_123' });

    const [res1, res2] = await Promise.all([promise1, promise2]);

    // Both should return 200 with CANCELLED status
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body).toEqual({
      txHash: 'tx_hash_123',
      status: 'CANCELLED',
    });
    expect(res2.body).toEqual({
      txHash: 'tx_hash_123',
      status: 'CANCELLED',
    });

    // Each request performs its own on-chain cancel call
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(2);
    expect(sorobanService.cancelStream).toHaveBeenCalledWith(BigInt(streamId), 'S_SECRET_123');

    // Stream should be marked as inactive via the repository helper
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: BigInt(streamId) },
      data: { isActive: false },
    });

    // Both responses should reference the same transaction hash
    expect(res1.body.txHash).toBe(res2.body.txHash);
  });
});

// ─── Idempotency contract ───────────────────────────────────────────────────
//
// Externally observable behaviour for retryable stream commands:
//   * A request carrying `Idempotency-Key` is bound to (wallet, operation,
//     request hash). Replaying the same key with the same input returns the
//     original response body and status, without re-submitting on-chain.
//   * Replaying the same key with a different input is rejected with 422
//     `IDEMPOTENCY_KEY_REUSED`.
//   * Concurrent duplicates with the same key trigger at most one
//     transaction; the loser waits for and replays the winner's result.
//   * Keys are retained for a bounded window (24h); after expiry the key may
//     be reused as a fresh request.

describe('POST /v1/streams/:streamId/cancel — idempotency', () => {
  const streamId = 123;
  const idempotencyKey = 'idem-key-cancel-001';

  const mockStream = {
    streamId,
    sender: 'G_SENDER_123',
    isActive: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (prisma.stream.update as any).mockResolvedValue({ ...mockStream, isActive: false });
    (sorobanService.cancelStream as any).mockResolvedValue('tx_hash_123');
  });

  it('returns the original result when the same key is retried with identical input', async () => {
    const first = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ senderSecret: 'S_SECRET_123' });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ txHash: 'tx_hash_123', status: 'CANCELLED' });
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(1);

    // Retry with the same key and identical payload.
    const retry = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ senderSecret: 'S_SECRET_123' });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    // The retry must not submit a second on-chain transaction.
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(1);
    expect(prisma.stream.update).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of the same key with a different request body', async () => {
    const first = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ senderSecret: 'S_SECRET_123' });

    expect(first.status).toBe(200);
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(1);

    // Same key, different input → rejected, no new transaction.
    const conflict = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ senderSecret: 'S_DIFFERENT_SECRET' });

    expect(conflict.status).toBe(422);
    expect(conflict.body.error).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of the same key for a different stream (operation binding)', async () => {
    const first = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ senderSecret: 'S_SECRET_123' });

    expect(first.status).toBe(200);

    (prisma.stream.findUnique as any).mockResolvedValue({
      streamId: 456,
      sender: 'G_SENDER_123',
      isActive: true,
    });

    const conflict = await request(app)
      .post('/v1/streams/456/cancel')
      .set('Authorization', 'Bearer dummy_token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ senderSecret: 'S_SECRET_123' });

    expect(conflict.status).toBe(422);
    expect(conflict.body.error).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(1);
  });

  it('triggers at most one transaction for concurrent duplicate submissions', async () => {
    // Make the on-chain call slow so both requests overlap.
    let resolveCancel: (value: string) => void = () => {};
    (sorobanService.cancelStream as any).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveCancel = resolve;
        }),
    );

    const send = () =>
      request(app)
        .post(`/v1/streams/${streamId}/cancel`)
        .set('Authorization', 'Bearer dummy_token')
        .set('Idempotency-Key', idempotencyKey)
        .send({ senderSecret: 'S_SECRET_123' });

    const promise1 = send();
    const promise2 = send();

    // Give both requests a chance to reach the idempotency layer.
    await new Promise((r) => setTimeout(r, 50));

    resolveCancel('tx_hash_123');

    const [res1, res2] = await Promise.all([promise1, promise2]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body).toEqual({ txHash: 'tx_hash_123', status: 'CANCELLED' });
    expect(res2.body).toEqual(res1.body);

    // Only one on-chain submission despite two concurrent requests.
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(1);
    expect(prisma.stream.update).toHaveBeenCalledTimes(1);
  });

  it('treats requests without an idempotency key as non-idempotent', async () => {
    const first = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ senderSecret: 'S_SECRET_123' });

    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ senderSecret: 'S_SECRET_123' });

    expect(second.status).toBe(200);
    // Without a key each request submits its own transaction.
    expect(sorobanService.cancelStream).toHaveBeenCalledTimes(2);
  });
});
