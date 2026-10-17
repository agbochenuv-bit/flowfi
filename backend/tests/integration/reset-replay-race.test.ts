/**
 * Integration test for resetIndexer / replayFromLedger racing a concurrent
 * scheduled poll — Functional Edge Case #19 from the second-wave audit (#1293).
 *
 * Both `resetIndexer` and `replayFromLedger` are tested in isolation elsewhere,
 * but never interleaved with SorobanEventWorker's mutex-protected poll cycle.
 * This file fills that gap by simulating the exact scenario operators hit during
 * incident recovery: a live indexer whose scheduled poll is mid-flight when an
 * operator resets or replays.
 *
 * The race (Functional Edge Case #19), as it behaved before #1221:
 *   1. SorobanEventWorker.poll() -> runExclusive -> fetchAndProcessEvents()
 *   2. fetchAndProcessEvents reads IndexerState.lastLedger (e.g. 200)
 *   3. fetchAndProcessEvents awaits server.getEvents (async network I/O)
 *   4.   ^ WINDOW: resetIndexer(50) writes lastLedger=50 with no lock held
 *   5. fetchAndProcessEvents resumes and upserts the cursor it captured in
 *      step 2, rolling lastLedger forward past the reset
 *   6. The reset is lost — the recovery action silently did nothing.
 *
 * resetIndexer now takes the worker's batchMutex (`runExclusive`), so its write
 * is ordered after any in-flight batch and cannot be clobbered by one. These
 * tests pin that ordering down end to end: they drive a real
 * SorobanEventWorker poll to the point where it is suspended on RPC, inject the
 * operator action, and assert the operator's cursor is the one that survives.
 *
 * They exercise the exported `sorobanEventWorker` singleton on purpose — that
 * is the instance `resetIndexer`/`replayFromLedger` lock against, so a fresh
 * `new SorobanEventWorker()` would share no mutex with them and the ordering
 * under test would not exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Deferred promise (for controlling async timing in tests) ─────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Shared mutable DB state ─────────────────────────────────────────────────
//
// Both the worker (via ensureIndexerState + upsert) and resetIndexer
// (via upsert) write to this shared state, simulating a real Postgres
// where concurrent upserts actually race.

let dbIndexerState: {
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
};

// Track all upsert calls in order for forensic assertions.
const upsertLog: Array<{ lastLedger: number; lastCursor: string | null; caller: string }> = [];

// ─── Hoisted mock factories ──────────────────────────────────────────────────

const { mockPrisma, mockSseService, mockLogger } = vi.hoisted(() => {
  const mockPrisma = {
    indexerState: {
      upsert: vi.fn(async (args: any) => {
        const update = args.update ?? {};
        dbIndexerState = {
          ...dbIndexerState,
          ...update,
          updatedAt: new Date(),
        };
        const caller = update.lastCursor === null && update.lastLedger !== undefined
          ? 'resetIndexer'
          : 'worker';
        upsertLog.push({
          lastLedger: dbIndexerState.lastLedger,
          lastCursor: dbIndexerState.lastCursor,
          caller,
        });
        return { ...dbIndexerState };
      }),
    },
    $disconnect: vi.fn(),
  };

  return {
    mockPrisma,
    mockSseService: {
      broadcastToStream: vi.fn(),
      broadcastToAdmin: vi.fn(),
    },
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../../src/lib/indexer-state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/indexer-state.js')>();
  return {
    ...original,
    ensureIndexerState: vi.fn(async (_startLedger: number) => {
      return {
        id: 'singleton' as const,
        lastLedger: dbIndexerState.lastLedger,
        lastCursor: dbIndexerState.lastCursor,
        createdAt: new Date(),
        updatedAt: dbIndexerState.updatedAt,
      };
    }),
  };
});

vi.mock('../../src/services/sse.service.js', () => ({
  sseService: mockSseService,
}));

vi.mock('../../src/logger.js', async () => {
  const { AsyncLocalStorage } = await import('async_hooks');
  return {
    default: mockLogger,
    // Real ALS: both the worker and replayFromLedger call getStore()/run().
    requestContext: new AsyncLocalStorage<{ requestId: string }>(),
  };
});

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { sorobanEventWorker } from '../../src/workers/soroban-event-worker.js';
import {
  resetIndexer,
  replayFromLedger,
  previewReplay,
  type ReplayExecutionReport,
} from '../../src/services/indexerService.js';

/**
 * Build a minimal Soroban EventResponse that the worker can decode.
 * We use `stream_created` with the minimum required body fields so
 * `fetchAndProcessEvents` reaches the final cursor upsert.
 */
function fakeStreamCreatedEvent(overrides: {
  id: string;
  txHash: string;
  ledger: number;
}) {
  return {
    id: overrides.id,
    type: 'contract' as const,
    ledger: overrides.ledger,
    ledgerClosedAt: new Date().toISOString(),
    txHash: overrides.txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [
      {
        switch: () => ({ value: 0 }),
        sym: () => 'stream_created',
      },
      {
        switch: () => ({ value: 1 }),
        u64: () => ({ toString: () => '42' }),
      },
    ],
    value: {
      switch: () => ({ value: 4 }),
      map: () => [
        {
          key: () => ({ sym: () => 'sender' }),
          val: () => ({
            address: () => ({
              switch: () => ({ value: 0 }),
              accountId: () => ({
                ed25519: () => Buffer.alloc(32),
              }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'recipient' }),
          val: () => ({
            address: () => ({
              switch: () => ({ value: 0 }),
              accountId: () => ({
                ed25519: () => Buffer.alloc(32),
              }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'token_address' }),
          val: () => ({
            address: () => ({
              switch: () => ({ value: 1 }),
              contractId: () => Buffer.alloc(32),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'rate_per_second' }),
          val: () => ({
            i128: () => ({
              hi: () => ({ toString: () => '0' }),
              lo: () => ({ toString: () => '100' }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'deposited_amount' }),
          val: () => ({
            i128: () => ({
              hi: () => ({ toString: () => '0' }),
              lo: () => ({ toString: () => '86400' }),
            }),
          }),
        },
        {
          key: () => ({ sym: () => 'start_time' }),
          val: () => ({
            u64: () => ({ toString: () => '1700000000' }),
          }),
        },
      ],
    } as any,
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Reset/replay race with concurrent poll (Edge Case #19 - issue #1293)', () => {
  const worker = sorobanEventWorker;
  let getEventsDeferred: Deferred<{ events: any[]; latestCursor?: string | null }>;

  /** Let queued microtasks and one timer tick run. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    vi.clearAllMocks();
    upsertLog.length = 0;

    // Initialize shared DB state.
    dbIndexerState = {
      lastLedger: 0,
      lastCursor: null,
      updatedAt: new Date(),
    };

    (worker as any).contractId = 'CTESTCONTRACT';
    (worker as any).pollIntervalMs = 600_000;

    // getEvents resolves whichever deferred is current when it is *called*,
    // so a test can queue the next batch's response by reassigning.
    getEventsDeferred = defer();
    (worker as any).server = {
      getEvents: vi.fn(() => getEventsDeferred.promise),
    };
  });

  afterEach(async () => {
    worker.stop();
    await worker.waitForDrain().catch(() => undefined);
  });

  it('resetIndexer cursor survives a poll that is already mid-flight', async () => {
    // ── Arrange ────────────────────────────────────────────────────────
    // The indexer is at ledger 200; the poll about to start reads from there.
    dbIndexerState = {
      lastLedger: 200,
      lastCursor: 'cursor-old',
      updatedAt: new Date(),
    };

    // ── Act ────────────────────────────────────────────────────────────
    // 1. start() -> poll() -> runExclusive -> fetchAndProcessEvents, which
    //    reads lastLedger=200 and then suspends on server.getEvents.
    void worker.start();
    await flush();

    // 2. Mid-flight, the operator resets to ledger 50. This is the whole
    //    point of the test: the call is issued while the poll still holds
    //    the batch mutex, so it must not be applied yet.
    const resetPromise = resetIndexer(50);
    await flush();
    expect(upsertLog).toHaveLength(0);

    // 3. Release the poll. It processes its event and writes its cursor
    //    (ledger 210) — that write is legitimate, it just must not be the
    //    last word.
    getEventsDeferred.resolve({
      events: [fakeStreamCreatedEvent({ id: 'e1', txHash: 'tx1', ledger: 210 })],
      latestCursor: 'cursor-new',
    });

    await resetPromise;
    await worker.waitForDrain();

    // ── Assert ─────────────────────────────────────────────────────────
    // The poll's cursor write lands first, the reset second — the ordering
    // the batch mutex guarantees. Before #1221 the reset slipped in ahead of
    // the poll and was then overwritten by it.
    expect(upsertLog.map((e) => e.caller)).toEqual(['worker', 'resetIndexer']);
    expect(upsertLog[0]!.lastLedger).toBe(210);
    expect(upsertLog[1]!.lastLedger).toBe(50);

    // Final DB state: the operator's reset is what survives.
    expect(dbIndexerState.lastLedger).toBe(50);
    expect(dbIndexerState.lastCursor).toBeNull();
  });

  it('replayFromLedger cursor survives a poll that is already mid-flight', async () => {
    // ── Arrange ────────────────────────────────────────────────────────
    dbIndexerState = {
      lastLedger: 300,
      lastCursor: 'cursor-abc',
      updatedAt: new Date(),
    };

    // ── Act ────────────────────────────────────────────────────────────
    // 1. First poll runs to completion normally, advancing to ledger 310.
    void worker.start();
    await flush();
    getEventsDeferred.resolve({
      events: [fakeStreamCreatedEvent({ id: 'e2', txHash: 'tx2', ledger: 310 })],
      latestCursor: 'cursor-first',
    });
    await worker.waitForDrain();
    expect(dbIndexerState.lastLedger).toBe(310);

    // 2. Start a second poll and leave it suspended on getEvents.
    getEventsDeferred = defer();
    void worker.start();
    await flush();

    // 3. Operator replays from ledger 100 while that poll is in flight:
    //    resetIndexer(100) queues behind it on the mutex, and the replay's
    //    own triggerPoll queues behind the reset.
    const replayPromise = replayFromLedger(100);
    await flush();

    // Nothing applied yet — the second poll still holds the mutex.
    const beforeRelease = upsertLog.length;
    expect(dbIndexerState.lastLedger).toBe(310);

    // 4. Release the second poll (it writes ledger 320), and hand the
    //    replay's own poll an empty batch so it makes no cursor write.
    const secondPollDeferred = getEventsDeferred;
    getEventsDeferred = defer();
    getEventsDeferred.resolve({ events: [], latestCursor: 'cursor-replay' });
    secondPollDeferred.resolve({
      events: [fakeStreamCreatedEvent({ id: 'e3', txHash: 'tx3', ledger: 320 })],
      latestCursor: 'cursor-poll2',
    });

    await replayPromise;
    await worker.waitForDrain();

    // ── Assert ─────────────────────────────────────────────────────────
    // The second poll's stale write lands, then the replay's reset — and
    // nothing after it, because the replay's own poll found no events.
    const afterRelease = upsertLog.slice(beforeRelease);
    expect(afterRelease.map((e) => e.caller)).toEqual(['worker', 'resetIndexer']);
    expect(afterRelease[0]!.lastLedger).toBe(320);
    expect(afterRelease[1]!.lastLedger).toBe(100);

    // Final DB state: the replay's cursor is what survives.
    expect(dbIndexerState.lastLedger).toBe(100);
    expect(dbIndexerState.lastCursor).toBeNull();
  });

  it('replayFromLedger reports the cursor write that survives a mid-flight poll', async () => {
    // ── Arrange ────────────────────────────────────────────────────────
    dbIndexerState = {
      lastLedger: 400,
      lastCursor: 'cursor-live',
      updatedAt: new Date(),
    };

    // ── Act ────────────────────────────────────────────────────────────
    void worker.start();
    await flush();

    const replayPromise = replayFromLedger(150);
    await flush();

    const secondPollDeferred = getEventsDeferred;
    getEventsDeferred = defer();
    getEventsDeferred.resolve({ events: [], latestCursor: 'cursor-replay' });
    secondPollDeferred.resolve({
      events: [fakeStreamCreatedEvent({ id: 'e4', txHash: 'tx4', ledger: 410 })],
      latestCursor: 'cursor-poll4',
    });

    const report = await replayPromise;
    await worker.waitForDrain();

    // ── Assert ─────────────────────────────────────────────────────────
    // The report describes the replay that actually took effect, not the
    // stale poll write that preceded it.
    expect(report.status).toBe('completed');
    expect(report.fromLedger).toBe(150);
    expect(report.toLedger).toBe(150);
    expect(report.finalLedger).toBe(150);
    expect(report.failurePosition).toBeNull();
    expect(report.requestId).toEqual(expect.any(String));
    expect(report.requestId.length).toBeGreaterThan(0);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(dbIndexerState.lastLedger).toBe(150);
    expect(dbIndexerState.lastCursor).toBeNull();
  });
});

// ─── Replay preview / execution report (issue #53) ───────────────────────────

describe('Replay preview and execution report (issue #53)', () => {
  const worker = sorobanEventWorker;

  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    vi.clearAllMocks();
    upsertLog.length = 0;

    dbIndexerState = {
      lastLedger: 500,
      lastCursor: 'cursor-live',
      updatedAt: new Date(),
    };

    (worker as any).contractId = 'CTESTCONTRACT';
    (worker as any).pollIntervalMs = 600_000;
    (worker as any).server = {
      getEvents: vi.fn(async () => ({ events: [], latestCursor: null })),
    };
  });

  afterEach(async () => {
    worker.stop();
    await worker.waitForDrain().catch(() => undefined);
  });

  it('previewReplay performs no writes and reports the affected ledger range', async () => {
    const before = { ...dbIndexerState };

    const preview = await previewReplay(100);

    // No mutation of the live cursor, no upsert issued.
    expect(upsertLog).toHaveLength(0);
    expect(dbIndexerState).toEqual(before);

    // The preview describes the range the replay would touch.
    expect(preview.fromLedger).toBe(100);
    expect(preview.toLedger).toBe(500);
    expect(preview.currentLedger).toBe(500);
    expect(preview.ledgerCount).toBe(401);
    expect(preview.willResetCursor).toBe(true);
    expect(preview.requestId).toEqual(expect.any(String));
    expect(preview.requestId.length).toBeGreaterThan(0);
  });

  it('previewReplay is a no-op range when replaying from the live cursor', async () => {
    const preview = await previewReplay(500);

    expect(upsertLog).toHaveLength(0);
    expect(preview.fromLedger).toBe(500);
    expect(preview.toLedger).toBe(500);
    expect(preview.ledgerCount).toBe(1);
    expect(preview.willResetCursor).toBe(false);
  });

  it('previewReplay rejects a future ledger without writing', async () => {
    await expect(previewReplay(501)).rejects.toThrow();
    expect(upsertLog).toHaveLength(0);
    expect(dbIndexerState.lastLedger).toBe(500);
  });

  it('replayFromLedger returns a reproducible execution report', async () => {
    const report: ReplayExecutionReport = await replayFromLedger(200);
    await worker.waitForDrain();

    expect(report.status).toBe('completed');
    expect(report.fromLedger).toBe(200);
    expect(report.toLedger).toBe(200);
    expect(report.finalLedger).toBe(200);
    expect(report.requestId).toEqual(expect.any(String));
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.failurePosition).toBeNull();
    expect(report.counts).toEqual({
      ledgersReplayed: 1,
      eventsProcessed: 0,
      recordsWritten: 1,
    });

    // A second identical replay yields the same summary shape.
    dbIndexerState = {
      lastLedger: 500,
      lastCursor: 'cursor-live',
      updatedAt: new Date(),
    };
    const second = await replayFromLedger(200);
    await worker.waitForDrain();

    expect(second.status).toBe('completed');
    expect(second.fromLedger).toBe(report.fromLedger);
    expect(second.toLedger).toBe(report.toLedger);
    expect(second.counts).toEqual(report.counts);
    expect(second.failurePosition).toBeNull();
  });

  it('replayFromLedger preserves the live cursor when execution fails', async () => {
    const before = { ...dbIndexerState };

    // Make the cursor write fail mid-execution.
    const upsertSpy = vi
      .spyOn(mockPrisma.indexerState, 'upsert')
      .mockRejectedValueOnce(new Error('db unavailable'));

    const report = await replayFromLedger(100);
    await worker.waitForDrain();

    upsertSpy.mockRestore();

    expect(report.status).toBe('failed');
    expect(report.fromLedger).toBe(100);
    expect(report.failurePosition).toBe(100);
    expect(report.requestId).toEqual(expect.any(String));
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.counts.recordsWritten).toBe(0);

    // The live cursor is untouched by the failed replay.
    expect(dbIndexerState).toEqual(before);
  });

  it('retries after a failure produce reproducible summaries', async () => {
    const upsertSpy = vi
      .spyOn(mockPrisma.indexerState, 'upsert')
      .mockRejectedValueOnce(new Error('db unavailable'));

    const failed = await replayFromLedger(100);
    await worker.waitForDrain();
    upsertSpy.mockRestore();

    const retried = await replayFromLedger(100);
    await worker.waitForDrain();

    expect(failed.status).toBe('failed');
    expect(retried.status).toBe('completed');
    expect(retried.fromLedger).toBe(failed.fromLedger);
    expect(retried.toLedger).toBe(failed.toLedger);
    expect(retried.failurePosition).toBeNull();
    expect(retried.counts.recordsWritten).toBe(1);
    expect(dbIndexerState.lastLedger).toBe(100);
    expect(dbIndexerState.lastCursor).toBeNull();
  });
});
