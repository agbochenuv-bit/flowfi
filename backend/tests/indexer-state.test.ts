import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    indexerState: {
      findUnique: mocks.mockFindUnique,
      create: mocks.mockCreate,
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

import { ensureIndexerState } from '../src/lib/indexer-state.js';
import { checkIndexerHealth } from '../src/lib/indexer-state.js';

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

describe('checkIndexerHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads dead-letter count and lag, then calls the alert service with the right arguments', async () => {
    const state = {
      id: 'singleton',
      lastLedger: 100,
      lastCursor: 'cur',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.mockFindUnique.mockResolvedValueOnce(state);

    const health = {
      deadLetterCount: 7,
      lagLedgers: 250,
      rpcFailureCount: 3,
    };
    const checkHealth = vi.fn().mockResolvedValue(health);
    const evaluate = vi.fn().mockResolvedValue(undefined);

    await checkIndexerHealth({
      currentLedger: 350,
      getHealth: checkHealth,
      alertService: { evaluate },
    });

    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({
      deadLetterCount: 7,
      lagLedgers: 250,
      rpcFailureCount: 3,
    });
  });

  it('swallows errors from the alert service so the indexer is unaffected', async () => {
    const state = {
      id: 'singleton',
      lastLedger: 100,
      lastCursor: 'cur',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.mockFindUnique.mockResolvedValueOnce(state);

    const checkHealth = vi.fn().mockResolvedValue({
      deadLetterCount: 1,
      lagLedgers: 10,
      rpcFailureCount: 0,
    });
    const evaluate = vi.fn().mockRejectedValue(new Error('alert backend down'));

    await expect(
      checkIndexerHealth({
        currentLedger: 110,
        getHealth: checkHealth,
        alertService: { evaluate },
      }),
    ).resolves.toBeUndefined();

    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
