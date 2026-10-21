import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Prisma
const mockPrisma = vi.hoisted(() => ({
  backfillJob: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  indexerState: {
    findUnique: vi.fn().mockResolvedValue({ id: 'singleton', lastLedger: 500000, lastCursor: 'live-cursor' }),
  },
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../src/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logger.js')>();
  return {
    ...actual,
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    requestContext: {
      run: <T>(_store: unknown, fn: () => T): T => fn(),
      getStore: () => undefined,
    },
  };
});

vi.mock('../../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    processEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

import * as indexerService from '../../src/services/indexerService.js';
import { BackfillStatus } from '../../src/services/indexerService.js';

describe('Indexer Backfill Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a backfill job and returns the created job', async () => {
    const createdJob = {
      id: 'new-job-id',
      name: 'test-backfill',
      fromLedger: 1000,
      toLedger: 2000,
      status: BackfillStatus.PENDING,
      currentLedger: 1000,
      eventsProcessed: 0,
      eventsFailed: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.backfillJob.findFirst.mockResolvedValueOnce(null); // No overlapping job
    mockPrisma.backfillJob.create.mockResolvedValueOnce(createdJob);

    const result = await indexerService.startBackfill({
      fromLedger: 1000,
      toLedger: 2000,
      name: 'test-backfill',
    });

    expect(result.id).toBe('new-job-id');
    expect(result.status).toBe(BackfillStatus.PENDING);
    expect(mockPrisma.backfillJob.create).toHaveBeenCalledWith({
      data: {
        name: 'test-backfill',
        fromLedger: 1000,
        toLedger: 2000,
        status: BackfillStatus.PENDING,
        currentLedger: 1000,
      },
    });
  });

  it('returns backfill job status including progress', async () => {
    const job = {
      id: 'job-123',
      name: 'historical-backfill',
      fromLedger: 100,
      toLedger: 1000,
      status: BackfillStatus.RUNNING,
      currentLedger: 550,
      eventsProcessed: 150,
      eventsFailed: 2,
      errorMessage: null,
      startedAt: new Date(Date.now() - 60_000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockPrisma.backfillJob.findUnique.mockResolvedValueOnce(job);

    const status = await indexerService.getBackfillStatus('job-123');
    expect(status).not.toBeNull();
    expect(status?.id).toBe('job-123');
    expect(status?.status).toBe(BackfillStatus.RUNNING);

    const progress = await indexerService.getBackfillProgress('job-123');
    expect(progress).not.toBeNull();
    expect(progress?.percentComplete).toBeGreaterThan(40); // ~45% at ledger 550 of range 100-1000
    expect(progress?.ledgersRemaining).toBe(450);
  });

  it('lists backfill jobs with filters', async () => {
    const jobs = [
      { id: 'job-1', fromLedger: 100, toLedger: 200, status: BackfillStatus.COMPLETED },
      { id: 'job-2', fromLedger: 300, toLedger: 400, status: BackfillStatus.RUNNING },
    ];

    mockPrisma.backfillJob.findMany.mockResolvedValueOnce(jobs);
    mockPrisma.backfillJob.count.mockResolvedValueOnce(2);

    const result = await indexerService.listBackfillJobs({ status: BackfillStatus.RUNNING, limit: 10, offset: 0 });

    expect(result.jobs).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it('pauses and resumes backfill jobs', async () => {
    // Pause
    mockPrisma.backfillJob.findUnique.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.RUNNING,
    });
    mockPrisma.backfillJob.update.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.PAUSED,
    });

    const paused = await indexerService.pauseBackfill('job-123');
    expect(paused?.status).toBe(BackfillStatus.PAUSED);

    // Resume
    mockPrisma.backfillJob.findUnique.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.PAUSED,
    });
    mockPrisma.backfillJob.update.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.RUNNING,
    });

    const resumed = await indexerService.resumeBackfill('job-123');
    expect(resumed?.status).toBe(BackfillStatus.RUNNING);
  });

  it('cancels a backfill job', async () => {
    mockPrisma.backfillJob.findUnique.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.RUNNING,
    });
    mockPrisma.backfillJob.update.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.CANCELLED,
    });

    const cancelled = await indexerService.cancelBackfill('job-123');
    expect(cancelled?.status).toBe(BackfillStatus.CANCELLED);
  });

  it('rejects invalid operations on wrong status', async () => {
    mockPrisma.backfillJob.findUnique.mockResolvedValueOnce({
      id: 'job-123',
      status: BackfillStatus.COMPLETED,
    });

    await expect(indexerService.pauseBackfill('job-123')).rejects.toThrow('Cannot pause job in status COMPLETED');
    await expect(indexerService.resumeBackfill('job-123')).rejects.toThrow('Cannot resume job in status COMPLETED');
    await expect(indexerService.cancelBackfill('job-123')).rejects.toThrow('Cannot cancel job in status COMPLETED');
  });
});