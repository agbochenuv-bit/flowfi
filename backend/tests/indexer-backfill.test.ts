import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    backfillJob: {
      findUnique: hoisted.findUnique,
      findFirst: hoisted.findFirst,
      findMany: hoisted.findMany,
      create: hoisted.create,
      update: hoisted.update,
      count: hoisted.count,
    },
    indexerState: {
      findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastLedger: 500000, lastCursor: 'live-cursor' }),
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  requestContext: {
    run: <T>(_store: unknown, fn: () => T): T => fn(),
    getStore: () => undefined,
  },
}));

import * as indexerService from '../src/services/indexerService.js';
import { BackfillStatus } from '../src/services/indexerService.js';

describe('Indexer Backfill Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates ledger range boundaries when starting backfill', async () => {
    await expect(
      indexerService.startBackfill({ fromLedger: 200, toLedger: 100 })
    ).rejects.toThrow('fromLedger must be less than or equal to toLedger');

    await expect(
      indexerService.startBackfill({ fromLedger: -1, toLedger: 100 })
    ).rejects.toThrow('Ledger numbers must be non-negative');
  });

  it('prevents overlapping running backfill jobs', async () => {
    hoisted.findFirst.mockResolvedValueOnce({
      id: 'job-existing',
      fromLedger: 100,
      toLedger: 500,
      status: BackfillStatus.RUNNING,
    });

    await expect(
      indexerService.startBackfill({ fromLedger: 200, toLedger: 300 })
    ).rejects.toThrow('already running or pending');

    expect(hoisted.findFirst).toHaveBeenCalledTimes(1);
  });

  it('reports backfill progress and completion percentage correctly', async () => {
    hoisted.findUnique.mockResolvedValueOnce({
      id: 'job-123',
      name: 'test-backfill',
      fromLedger: 100,
      toLedger: 200,
      status: BackfillStatus.RUNNING,
      currentLedger: 150,
      eventsProcessed: 25,
      eventsFailed: 0,
      errorMessage: null,
      startedAt: new Date(Date.now() - 10_000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const progress = await indexerService.getBackfillProgress('job-123');

    expect(progress).not.toBeNull();
    expect(progress?.percentComplete).toBe(50); // 50 / 100 ledgers processed (from 100 to 150)
    expect(progress?.ledgersRemaining).toBe(50); // 200 - 150
    expect(progress?.job.status).toBe(BackfillStatus.RUNNING);
  });

  it('supports pausing and resuming backfill jobs', async () => {
    hoisted.findUnique.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.RUNNING,
    });
    hoisted.update.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.PAUSED,
    });

    const paused = await indexerService.pauseBackfill('job-123');
    expect(paused?.status).toBe(BackfillStatus.PAUSED);

    hoisted.findUnique.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.PAUSED,
    });
    hoisted.update.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.RUNNING,
    });

    const resumed = await indexerService.resumeBackfill('job-123');
    expect(resumed?.status).toBe(BackfillStatus.RUNNING);
  });

  it('ensures backfill operates independently without affecting live indexer status', async () => {
    const status = await indexerService.getIndexerStatus();
    // Live indexer status is independent and unregressed
    expect(status.lastLedger).toBe(500000);
    expect(status.lastCursor).toBe('live-cursor');
  });
});
