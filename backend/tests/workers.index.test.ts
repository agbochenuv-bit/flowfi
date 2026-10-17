import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWorkers, stopWorkers } from '../src/workers/index.js';
import { sorobanEventWorker } from '../src/workers/soroban-event-worker.js';

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../src/workers/stream-runway-worker.js', () => ({
  startStreamRunwayWorker: vi.fn(() => 123),
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
  });

  it('should start workers', async () => {
    await startWorkers();
    expect(sorobanEventWorker.start).toHaveBeenCalled();
  });

  it('should stop workers', () => {
    stopWorkers();
    expect(sorobanEventWorker.stop).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stream runway worker regression / boundary tests
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

type RunwayAlertType = 'RUNWAY_48H' | 'RUNWAY_24H';

interface StreamRow {
  id: string;
  sender: string;
  recipient: string;
  ratePerSecond: bigint;
  startTime: Date;
  stopTime: Date;
  withdrawn: bigint;
}

interface NotificationRow {
  id: string;
  streamId: string;
  policy: RunwayAlertType;
  windowKey: string;
  createdAt: Date;
}

// In-memory notification store shared across "replicas" so we can simulate
// the unique constraint (streamId, policy, windowKey) enforced by the DB.
let notificationStore: NotificationRow[];
let notificationIdCounter: number;

function makePrismaMock() {
  return {
    stream: {
      findMany: vi.fn(async (): Promise<StreamRow[]> => []),
    },
    streamRunwayNotification: {
      create: vi.fn(
        async (args: {
          data: { streamId: string; policy: RunwayAlertType; windowKey: string };
        }): Promise<NotificationRow> => {
          const { streamId, policy, windowKey } = args.data;
          const exists = notificationStore.some(
            (n) =>
              n.streamId === streamId &&
              n.policy === policy &&
              n.windowKey === windowKey,
          );
          if (exists) {
            const err = new Error('Unique constraint failed') as Error & {
              code: string;
            };
            err.code = 'P2002';
            throw err;
          }
          const row: NotificationRow = {
            id: `notif-${++notificationIdCounter}`,
            streamId,
            policy,
            windowKey,
            createdAt: new Date(),
          };
          notificationStore.push(row);
          return row;
        },
      ),
      findMany: vi.fn(
        async (args: {
          where?: { streamId?: string; policy?: RunwayAlertType };
        }): Promise<NotificationRow[]> => {
          const where = args?.where ?? {};
          return notificationStore.filter(
            (n) =>
              (where.streamId === undefined || n.streamId === where.streamId) &&
              (where.policy === undefined || n.policy === where.policy),
          );
        },
      ),
    },
  };
}

let prismaMock: ReturnType<typeof makePrismaMock>;
let sseServiceMock: { broadcast: ReturnType<typeof vi.fn> };
let claimableAmountServiceMock: {
  calculateClaimable: ReturnType<typeof vi.fn>;
};

// The worker module is imported lazily so each test can install fresh mocks
// before the module resolves its dependencies.
let runStreamRunwayCheck: (now?: Date) => Promise<void>;

async function loadWorker() {
  vi.resetModules();
  vi.doMock('../src/db/prisma.js', () => ({ prisma: prismaMock }));
  vi.doMock('../src/services/sse.service.js', () => ({
    sseService: sseServiceMock,
  }));
  vi.doMock('../src/services/claimable-amount.service.js', () => ({
    claimableAmountService: claimableAmountServiceMock,
  }));
  vi.doMock('../src/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }));
  const mod = await import('../src/workers/stream-runway-worker.js');
  runStreamRunwayCheck = mod.runStreamRunwayCheck;
}

function makeStream(overrides: Partial<StreamRow> = {}): StreamRow {
  return {
    id: 'stream-1',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    ratePerSecond: 1n,
    startTime: new Date('2024-01-01T00:00:00.000Z'),
    stopTime: new Date('2024-01-10T00:00:00.000Z'),
    withdrawn: 0n,
    ...overrides,
  };
}

function alertsFor(streamId: string): NotificationRow[] {
  return notificationStore.filter((n) => n.streamId === streamId);
}

describe('stream-runway-worker notifications', () => {
  beforeEach(() => {
    notificationStore = [];
    notificationIdCounter = 0;
    prismaMock = makePrismaMock();
    sseServiceMock = { broadcast: vi.fn() };
    claimableAmountServiceMock = {
      calculateClaimable: vi.fn(async () => 0n),
    };
  });

  afterEach(() => {
    vi.doUnmock('../src/db/prisma.js');
    vi.doUnmock('../src/services/sse.service.js');
    vi.doUnmock('../src/services/claimable-amount.service.js');
    vi.doUnmock('../src/logger.js');
    vi.resetModules();
  });

  it('emits exactly one alert when the same window runs twice (deterministic clock)', async () => {
    await loadWorker();

    // Stream with 30h of runway remaining at `now`.
    const now = new Date('2024-01-05T00:00:00.000Z');
    const stopTime = new Date(now.getTime() + 30 * HOUR_MS);
    prismaMock.stream.findMany.mockResolvedValue([
      makeStream({ id: 'stream-det', stopTime }),
    ]);
    // Claimable is 0, so remaining runway == stopTime - now.
    claimableAmountServiceMock.calculateClaimable.mockResolvedValue(0n);

    await runStreamRunwayCheck(now);
    await runStreamRunwayCheck(now);

    const alerts = alertsFor('stream-det');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].policy).toBe('RUNWAY_48H');
    expect(sseServiceMock.broadcast).toHaveBeenCalledTimes(1);
  });

  it('emits exactly one SSE broadcast across concurrent replicas (P2002 on second insert)', async () => {
    await loadWorker();

    const now = new Date('2024-01-05T00:00:00.000Z');
    const stopTime = new Date(now.getTime() + 20 * HOUR_MS);
    prismaMock.stream.findMany.mockResolvedValue([
      makeStream({ id: 'stream-conc', stopTime }),
    ]);
    claimableAmountServiceMock.calculateClaimable.mockResolvedValue(0n);

    // Two parallel replicas race on the same window.
    await Promise.all([
      runStreamRunwayCheck(now),
      runStreamRunwayCheck(now),
    ]);

    const alerts = alertsFor('stream-conc');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].policy).toBe('RUNWAY_24H');
    // Only the replica that won the insert should broadcast.
    expect(sseServiceMock.broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not re-emit when the clock skews within the same bucket', async () => {
    await loadWorker();

    const base = new Date('2024-01-05T00:00:00.000Z');
    const stopTime = new Date(base.getTime() + 30 * HOUR_MS);
    prismaMock.stream.findMany.mockResolvedValue([
      makeStream({ id: 'stream-skew', stopTime }),
    ]);
    claimableAmountServiceMock.calculateClaimable.mockResolvedValue(0n);

    // Forward skew within the 48h bucket.
    await runStreamRunwayCheck(base);
    await runStreamRunwayCheck(new Date(base.getTime() + 5 * 60 * 1000));
    // Backward skew within the same bucket.
    await runStreamRunwayCheck(new Date(base.getTime() - 5 * 60 * 1000));

    const alerts = alertsFor('stream-skew');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].policy).toBe('RUNWAY_48H');
    expect(sseServiceMock.broadcast).toHaveBeenCalledTimes(1);
  });

  it('emits RUNWAY_48H when crossing exactly the 48h threshold', async () => {
    await loadWorker();

    const now = new Date('2024-01-05T00:00:00.000Z');
    const stopTime = new Date(now.getTime() + 48 * HOUR_MS);
    prismaMock.stream.findMany.mockResolvedValue([
      makeStream({ id: 'stream-48h', stopTime }),
    ]);
    claimableAmountServiceMock.calculateClaimable.mockResolvedValue(0n);

    await runStreamRunwayCheck(now);

    const alerts = alertsFor('stream-48h');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].policy).toBe('RUNWAY_48H');
    expect(sseServiceMock.broadcast).toHaveBeenCalledTimes(1);
  });

  it('emits RUNWAY_24H when crossing exactly the 24h threshold', async () => {
    await loadWorker();

    const now = new Date('2024-01-05T00:00:00.000Z');
    const stopTime = new Date(now.getTime() + 24 * HOUR_MS);
    prismaMock.stream.findMany.mockResolvedValue([
      makeStream({ id: 'stream-24h', stopTime }),
    ]);
    claimableAmountServiceMock.calculateClaimable.mockResolvedValue(0n);

    await runStreamRunwayCheck(now);

    const alerts = alertsFor('stream-24h');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].policy).toBe('RUNWAY_24H');
    expect(sseServiceMock.broadcast).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate alerts after a simulated restart', async () => {
    await loadWorker();

    const now = new Date('2024-01-05T00:00:00.000Z');
    const stopTime = new Date(now.getTime() + 30 * HOUR_MS);
    prismaMock.stream.findMany.mockResolvedValue([
      makeStream({ id: 'stream-restart', stopTime }),
    ]);
    claimableAmountServiceMock.calculateClaimable.mockResolvedValue(0n);

    await runStreamRunwayCheck(now);
    expect(alertsFor('stream-restart')).toHaveLength(1);

    // Simulate a process restart: reload the worker module while the
    // persisted notification store survives (as it would in the DB).
    await loadWorker();
    prismaMock.stream.findMany.mockResolvedValue([
      makeStream({ id: 'stream-restart', stopTime }),
    ]);
    claimableAmountServiceMock.calculateClaimable.mockResolvedValue(0n);

    await runStreamRunwayCheck(now);

    const alerts = alertsFor('stream-restart');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].policy).toBe('RUNWAY_48H');
    // One broadcast from before the restart, none after.
    expect(sseServiceMock.broadcast).toHaveBeenCalledTimes(0);
  });
});