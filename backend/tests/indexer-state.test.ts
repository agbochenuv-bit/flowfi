import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    indexerState: {
      findUnique: mocks.mockFindUnique,
      create: mocks.mockCreate,
      updateMany: mocks.mockUpdateMany,
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  ensureIndexerState,
  acquireLease,
  renewLease,
  releaseLease,
  writeCursorWithFence,
} from '../src/lib/indexer-state.js';

describe('ensureIndexerState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing row if it already exists', async () => {
    const existing = {
      id: 'singleton',
      lastLedger: 42,
      lastCursor: 'cur',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.mockFindUnique.mockResolvedValueOnce(existing);

    const result = await ensureIndexerState(0);

    expect(result).toEqual(existing);
    expect(mocks.mockCreate).not.toHaveBeenCalled();
  });

  it('creates and returns a new row when none exists', async () => {
    const created = {
      id: 'singleton',
      lastLedger: 10,
      lastCursor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.mockFindUnique.mockResolvedValueOnce(null);
    mocks.mockCreate.mockResolvedValueOnce(created);

    const result = await ensureIndexerState(10);

    expect(result).toEqual(created);
    expect(mocks.mockCreate).toHaveBeenCalledWith({
      data: { id: 'singleton', lastLedger: 10, lastCursor: null },
    });
  });

  it('re-reads the row on unique-constraint violation (P2002) without throwing', async () => {
    const existingRow = {
      id: 'singleton',
      lastLedger: 5,
      lastCursor: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // First findUnique returns null (no row yet)
    mocks.mockFindUnique.mockResolvedValueOnce(null);
    // Create throws P2002 (race condition duplicate insert)
    const p2002Error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    mocks.mockCreate.mockRejectedValueOnce(p2002Error);
    // Second findUnique returns the existing row created by the concurrent caller
    mocks.mockFindUnique.mockResolvedValueOnce(existingRow);

    const result = await ensureIndexerState(0);

    expect(result).toEqual(existingRow);
    expect(mocks.mockCreate).toHaveBeenCalledTimes(1);
    expect(mocks.mockFindUnique).toHaveBeenCalledTimes(2);
  });

  it('re-throws non-P2002 errors', async () => {
    mocks.mockFindUnique.mockResolvedValueOnce(null);
    const genericError = new Error('connection refused');
    mocks.mockCreate.mockRejectedValueOnce(genericError);

    await expect(ensureIndexerState(0)).rejects.toThrow('connection refused');
  });
});

describe('indexer lease primitives', () => {
  const now = new Date('2024-01-01T00:00:00.000Z');
  const future = new Date('2024-01-01T00:01:00.000Z');
  const past = new Date('2023-12-31T23:59:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('acquireLease', () => {
    it('succeeds when the lease is free', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await acquireLease('worker-a', 60_000);

      expect(result).toEqual({ acquired: true, ownerId: 'worker-a' });
      expect(mocks.mockUpdateMany).toHaveBeenCalledTimes(1);
      const call = mocks.mockUpdateMany.mock.calls[0][0];
      expect(call.where.id).toBe('singleton');
      expect(call.where.OR).toEqual([
        { leaseOwner: null },
        { leaseExpiresAt: { lt: now } },
      ]);
      expect(call.data.leaseOwner).toBe('worker-a');
      expect(call.data.leaseExpiresAt).toEqual(future);
      expect(typeof call.data.fencingToken).toBe('object');
    });

    it('fails when the lease is held by a live owner', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 0 });

      const result = await acquireLease('worker-b', 60_000);

      expect(result).toEqual({ acquired: false, ownerId: null });
    });

    it('takes over an expired lease from a previous owner', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await acquireLease('worker-b', 60_000);

      expect(result).toEqual({ acquired: true, ownerId: 'worker-b' });
      const call = mocks.mockUpdateMany.mock.calls[0][0];
      expect(call.where.OR).toContainEqual({ leaseExpiresAt: { lt: now } });
      expect(call.data.leaseOwner).toBe('worker-b');
      expect(call.data.fencingToken).toEqual({ increment: 1 });
    });
  });

  describe('renewLease', () => {
    it('extends the lease for the current owner and token', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await renewLease('worker-a', 7, 60_000);

      expect(result).toBe(true);
      const call = mocks.mockUpdateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        id: 'singleton',
        leaseOwner: 'worker-a',
        fencingToken: 7,
        leaseExpiresAt: { gt: now },
      });
      expect(call.data.leaseExpiresAt).toEqual(future);
    });

    it('fails to renew when the owner or token no longer matches', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 0 });

      const result = await renewLease('worker-a', 6, 60_000);

      expect(result).toBe(false);
    });
  });

  describe('releaseLease', () => {
    it('clears ownership for the current owner and token', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await releaseLease('worker-a', 7);

      expect(result).toBe(true);
      const call = mocks.mockUpdateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        id: 'singleton',
        leaseOwner: 'worker-a',
        fencingToken: 7,
      });
      expect(call.data).toEqual({ leaseOwner: null, leaseExpiresAt: null });
    });

    it('does not clear ownership when the token is stale', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 0 });

      const result = await releaseLease('worker-a', 6);

      expect(result).toBe(false);
    });
  });

  describe('writeCursorWithFence', () => {
    it('writes the cursor when the fencing token is current', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      const result = await writeCursorWithFence(7, 100, 'cursor-100');

      expect(result).toBe(true);
      const call = mocks.mockUpdateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'singleton', fencingToken: 7 });
      expect(call.data).toEqual({ lastLedger: 100, lastCursor: 'cursor-100' });
    });

    it('rejects a stale fencing token after lease turnover', async () => {
      mocks.mockUpdateMany.mockResolvedValueOnce({ count: 0 });

      const result = await writeCursorWithFence(6, 100, 'cursor-100');

      expect(result).toBe(false);
      expect(mocks.mockUpdateMany).toHaveBeenCalledTimes(1);
    });
  });
});
