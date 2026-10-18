import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withdrawHandler } from '../src/routes/v1/streams/withdraw.js';
import { prisma } from '../src/lib/prisma.js';
import { claimableAmountService } from '../src/services/claimable.service.js';
import { withdraw as sorobanWithdraw } from '../src/services/sorobanService.js';
import { idempotencyService } from '../src/services/idempotency.service.js';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../src/types/auth.types.js';

const mockTx = {
  $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  stream: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(async (fn: any) => fn(mockTx)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../src/services/claimable.service.js', () => ({
  claimableAmountService: {
    getClaimableAmount: vi.fn(),
  },
}));

vi.mock('../src/services/sorobanService.js', () => ({
  withdraw: vi.fn(),
}));

vi.mock('../src/services/idempotency.service.js', () => ({
  idempotencyService: {
    begin: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Withdraw Handler', () => {
  let req: Partial<AuthenticatedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      params: { streamId: '123' },
      user: { publicKey: 'GRECIPIENT1' } as any,
      headers: {},
    };
    (idempotencyService.begin as any).mockResolvedValue({ status: 'proceed' });
    (idempotencyService.complete as any).mockResolvedValue(undefined);
    (idempotencyService.fail as any).mockResolvedValue(undefined);
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  it('should return 404 if stream not found', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue(null);
    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'NOT_FOUND', message: 'Stream not found' } });
  });

  it('should return 403 if caller is not recipient', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ recipient: 'GOTHER' });
    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should successfully withdraw', async () => {
    const mockStream = {
      streamId: 123,
      recipient: 'GRECIPIENT1',
      withdrawnAmount: '0',
      depositedAmount: '1000',
      isActive: true,
    };
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (claimableAmountService.getClaimableAmount as any).mockReturnValue({ actionable: true, claimableAmount: '100' });
    (sorobanWithdraw as any).mockResolvedValue({ txHash: 'tx123' });
    // Mock the $transaction callback to return the refreshed stream
    vi.mocked(prisma.$transaction as any).mockImplementation(async (fn: any) => {
      mockTx.stream.findUnique.mockResolvedValue({ ...mockStream, withdrawnAmount: '100' });
      return fn(mockTx);
    });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: 'tx123' }));
    expect(prisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          transactionHash_eventType: {
            transactionHash: 'tx123',
            eventType: 'WITHDRAWN',
          },
        },
      })
    );
  });

  describe('idempotency', () => {
    const mockStream = {
      streamId: 123,
      recipient: 'GRECIPIENT1',
      withdrawnAmount: '0',
      depositedAmount: '1000',
      isActive: true,
    };

    beforeEach(() => {
      (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
      (claimableAmountService.getClaimableAmount as any).mockReturnValue({
        actionable: true,
        claimableAmount: '100',
      });
      (sorobanWithdraw as any).mockResolvedValue({ txHash: 'tx123' });
      vi.mocked(prisma.$transaction as any).mockImplementation(async (fn: any) => {
        mockTx.stream.findUnique.mockResolvedValue({ ...mockStream, withdrawnAmount: '100' });
        return fn(mockTx);
      });
    });

    it('replays the original result on retry with the same key and input', async () => {
      req.headers = { 'idempotency-key': 'key-1' };
      (idempotencyService.begin as any).mockResolvedValueOnce({ status: 'proceed' });
      (idempotencyService.begin as any).mockResolvedValueOnce({
        status: 'replay',
        response: { success: true, txHash: 'tx123' },
      });

      await withdrawHandler(req as AuthenticatedRequest, res as Response);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(sorobanWithdraw).toHaveBeenCalledTimes(1);

      const replayRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as Partial<Response>;
      await withdrawHandler(req as AuthenticatedRequest, replayRes as Response);

      expect(replayRes.status).toHaveBeenCalledWith(200);
      expect(replayRes.json).toHaveBeenCalledWith({ success: true, txHash: 'tx123' });
      expect(sorobanWithdraw).toHaveBeenCalledTimes(1);
      expect(idempotencyService.complete).toHaveBeenCalledTimes(1);
    });

    it('rejects key reuse when the request input changed', async () => {
      req.headers = { 'idempotency-key': 'key-2' };
      (idempotencyService.begin as any).mockResolvedValue({
        status: 'conflict',
        message: 'Idempotency key reused with different request payload',
      });

      await withdrawHandler(req as AuthenticatedRequest, res as Response);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key reused with different request payload',
        },
      });
      expect(sorobanWithdraw).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('submits at most one transaction for concurrent duplicate submissions', async () => {
      req.headers = { 'idempotency-key': 'key-3' };
      let inFlight: Promise<any> | null = null;
      (idempotencyService.begin as any).mockImplementation(async () => {
        if (inFlight) {
          return { status: 'in_progress' };
        }
        inFlight = new Promise((resolve) => setTimeout(resolve, 10));
        await inFlight;
        return { status: 'proceed' };
      });

      const resA = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as Partial<Response>;
      const resB = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      } as Partial<Response>;

      await Promise.all([
        withdrawHandler(req as AuthenticatedRequest, resA as Response),
        withdrawHandler(req as AuthenticatedRequest, resB as Response),
      ]);

      expect(sorobanWithdraw).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(resA.status).toHaveBeenCalledWith(200);
      expect(resB.status).toHaveBeenCalledWith(409);
      expect(resB.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'IDEMPOTENCY_IN_PROGRESS' }),
        })
      );
    });

    it('records the failure so a retry can proceed after a failed submission', async () => {
      req.headers = { 'idempotency-key': 'key-4' };
      (sorobanWithdraw as any).mockRejectedValueOnce(new Error('soroban down'));

      await withdrawHandler(req as AuthenticatedRequest, res as Response);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(idempotencyService.fail).toHaveBeenCalledWith(
        'key-4',
        expect.objectContaining({ publicKey: 'GRECIPIENT1' })
      );
      expect(idempotencyService.complete).not.toHaveBeenCalled();
    });
  });
});
