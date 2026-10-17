import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startWorkers, stopWorkers } from '../src/workers/index.js';
import { sorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import { indexerLease } from '../src/workers/indexer-lease.js';

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../src/workers/stream-runway-worker.js', () => ({
  startStreamRunwayWorker: vi.fn(() => 123),
}));

vi.mock('../src/workers/indexer-lease.js', () => ({
  indexerLease: {
    acquire: vi.fn(),
    release: vi.fn(),
    renew: vi.fn(),
    isOwner: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Workers Index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(indexerLease.acquire).mockResolvedValue(true);
    vi.mocked(indexerLease.release).mockResolvedValue(undefined);
  });

  it('should start workers', async () => {
    await startWorkers();
    expect(sorobanEventWorker.start).toHaveBeenCalled();
  });

  it('should stop workers', () => {
    stopWorkers();
    expect(sorobanEventWorker.stop).toHaveBeenCalled();
  });

  it('should acquire the indexer lease on start', async () => {
    await startWorkers();
    expect(indexerLease.acquire).toHaveBeenCalledTimes(1);
  });

  it('should not start workers when the lease cannot be acquired', async () => {
    vi.mocked(indexerLease.acquire).mockResolvedValue(false);
    await startWorkers();
    expect(sorobanEventWorker.start).not.toHaveBeenCalled();
  });

  it('should release the indexer lease on stop', async () => {
    await startWorkers();
    stopWorkers();
    expect(indexerLease.release).toHaveBeenCalledTimes(1);
  });

  it('should release the lease only after workers are stopped', async () => {
    const order: string[] = [];
    vi.mocked(sorobanEventWorker.stop).mockImplementation(() => {
      order.push('stop');
    });
    vi.mocked(indexerLease.release).mockImplementation(async () => {
      order.push('release');
    });

    await startWorkers();
    stopWorkers();

    expect(order).toEqual(['stop', 'release']);
  });
});