import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import logger, { requestContext } from '../logger.js';

export interface IndexerStatus {
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
  lagSeconds: number;
}

export async function getIndexerStatus(): Promise<IndexerStatus> {
  const state = await prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } });
  const lagSeconds = state ? Math.floor((Date.now() - state.updatedAt.getTime()) / 1000) : -1;
  return {
    lastLedger: state?.lastLedger ?? 0,
    lastCursor: state?.lastCursor ?? null,
    updatedAt: state?.updatedAt ?? new Date(0),
    lagSeconds,
  };
}

export async function resetIndexer(toLedger: number): Promise<void> {
  // Acquire the same mutex that serialises poll/replay batches so that an
  // in-flight poll cannot overwrite the reset cursor after we write it (#1221).
  await sorobanEventWorker.runExclusive(async () => {
    await prisma.indexerState.upsert({
      where: { id: INDEXER_STATE_ID },
      create: { id: INDEXER_STATE_ID, lastLedger: toLedger, lastCursor: null },
      update: { lastLedger: toLedger, lastCursor: null },
    });
  });
  logger.info(`[IndexerService] Reset lastProcessedLedger to ${toLedger}`);
}

/**
 * Preview what a reset would do without mutating state.
 * Returns the current cursor and the target ledger so operators can
 * verify the intended scope before committing.
 */
export interface ResetPreview {
  currentLastLedger: number;
  currentLastCursor: string | null;
  targetLastLedger: number;
}

export async function previewReset(targetLedger: number): Promise<ResetPreview> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  return {
    currentLastLedger: state?.lastLedger ?? 0,
    currentLastCursor: state?.lastCursor ?? null,
    targetLastLedger: targetLedger,
  };
}

/**
 * Preview what a replay from a given ledger would do without mutating state.
 * Returns the event count, ledger range, and current cursor so operators can
 * sanity-check before committing a destructive replay.
 *
 * This function performs no writes: it only reads indexer state and stream
 * events, so it is safe to call repeatedly before an execution.
 */
export interface ReplayPreview {
  fromLedger: number;
  currentLastLedger: number;
  currentLastCursor: string | null;
  eventCount: number;
  minLedgerInReplayRange: number | null;
  maxLedgerInReplayRange: number | null;
}

export async function previewReplay(
  fromLedger: number,
): Promise<ReplayPreview> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  const currentLastLedger = state?.lastLedger ?? 0;

  const rangeFilter: import('../generated/prisma/index.js').Prisma.StreamEventWhereInput =
    currentLastLedger > 0
      ? { ledgerSequence: { gte: fromLedger, lte: currentLastLedger } }
      : { ledgerSequence: { gte: fromLedger } };

  const [eventCount, aggregate] = await Promise.all([
    prisma.streamEvent.count({ where: rangeFilter }),
    prisma.streamEvent.aggregate({
      where: rangeFilter,
      _min: { ledgerSequence: true },
      _max: { ledgerSequence: true },
    }),
  ]);

  return {
    fromLedger,
    currentLastLedger,
    currentLastCursor: state?.lastCursor ?? null,
    eventCount,
    minLedgerInReplayRange: aggregate._min.ledgerSequence,
    maxLedgerInReplayRange: aggregate._max.ledgerSequence,
  };
}

/**
 * Structured, auditable report describing the outcome of a replay execution.
 *
 * - `requestId` correlates the report with logs and the triggering request.
 * - `durationMs` is the wall-clock time spent executing the replay.
 * - `eventCount` / `minLedgerInReplayRange` / `maxLedgerInReplayRange` mirror
 *   the preview so operators can compare expected vs. actual scope.
 * - `failurePosition` is the ledger at which execution failed (if any).
 * - `cursorPreserved` indicates whether the live cursor was left untouched
 *   because the replay failed.
 */
export interface ReplayExecutionReport {
  requestId: string;
  fromLedger: number;
  success: boolean;
  durationMs: number;
  eventCount: number;
  minLedgerInReplayRange: number | null;
  maxLedgerInReplayRange: number | null;
  previousLastLedger: number;
  previousLastCursor: string | null;
  failurePosition: number | null;
  errorMessage: string | null;
  cursorPreserved: boolean;
}

/**
 * Execute a replay from `fromLedger` and return a structured report.
 *
 * On failure the live cursor is restored to its pre-execution value so that
 * a subsequent retry starts from the same position and produces a
 * reproducible summary.
 */
export async function executeReplay(
  fromLedger: number,
  customRequestId?: string,
): Promise<ReplayExecutionReport> {
  const requestId = customRequestId || requestContext.getStore()?.requestId || randomUUID();
  return requestContext.run({ requestId }, async () => {
    const startedAt = Date.now();
    const preview = await previewReplay(fromLedger);
    const previousLastLedger = preview.currentLastLedger;
    const previousLastCursor = preview.currentLastCursor;

    try {
      await resetIndexer(fromLedger);
      await sorobanEventWorker.triggerPoll(requestId);
      const durationMs = Date.now() - startedAt;
      logger.info(
        `[IndexerService] Replay executed from ledger ${fromLedger} (requestId=${requestId}, durationMs=${durationMs}, eventCount=${preview.eventCount})`,
      );
      return {
        requestId,
        fromLedger,
        success: true,
        durationMs,
        eventCount: preview.eventCount,
        minLedgerInReplayRange: preview.minLedgerInReplayRange,
        maxLedgerInReplayRange: preview.maxLedgerInReplayRange,
        previousLastLedger,
        previousLastCursor,
        failurePosition: null,
        errorMessage: null,
        cursorPreserved: false,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Restore the live cursor so a retry starts from the same position.
      await sorobanEventWorker.runExclusive(async () => {
        await prisma.indexerState.upsert({
          where: { id: INDEXER_STATE_ID },
          create: {
            id: INDEXER_STATE_ID,
            lastLedger: previousLastLedger,
            lastCursor: previousLastCursor,
          },
          update: {
            lastLedger: previousLastLedger,
            lastCursor: previousLastCursor,
          },
        });
      });
      logger.error(
        `[IndexerService] Replay failed from ledger ${fromLedger} (requestId=${requestId}, durationMs=${durationMs}, failurePosition=${fromLedger}): ${errorMessage}`,
      );
      return {
        requestId,
        fromLedger,
        success: false,
        durationMs,
        eventCount: preview.eventCount,
        minLedgerInReplayRange: preview.minLedgerInReplayRange,
        maxLedgerInReplayRange: preview.maxLedgerInReplayRange,
        previousLastLedger,
        previousLastCursor,
        failurePosition: fromLedger,
        errorMessage,
        cursorPreserved: true,
      };
    }
  });
}

export async function replayFromLedger(fromLedger: number, customRequestId?: string): Promise<string> {
  const report = await executeReplay(fromLedger, customRequestId);
  return report.requestId;
}
