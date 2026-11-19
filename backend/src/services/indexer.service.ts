import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import logger, { requestContext } from '../logger.js';

/**
 * Network finality assumptions
 * ----------------------------
 * Stellar's consensus protocol (SCP) finalises ledgers once a quorum of
 * validators agrees on them. In practice a ledger is considered *final* once
 * `INDEXER_FINALITY_DEPTH` additional ledgers have been closed on top of it.
 * Below that depth a ledger is still "recent" and may be rolled back by a
 * chain reorganization (reorg) if the network fails to reach consensus on the
 * winning branch.
 *
 * The indexer therefore treats any ledger within `finalityDepth` of the
 * current tip as *provisional*: its hash may change. Ledgers deeper than the
 * finality window are assumed immutable. When we observe that a previously
 * recorded ledger hash no longer matches the canonical chain we classify the
 * event as a reorg, find the fork point (the deepest ledger whose hash still
 * matches), and repair every projection derived from the orphaned branch.
 *
 * Default finality depth is 1 (the minimum safe value for Stellar's ~5s
 * ledger close time); operators can raise it via `INDEXER_FINALITY_DEPTH`.
 */
export const DEFAULT_FINALITY_DEPTH = 1;

export function getFinalityDepth(): number {
  const raw = process.env.INDEXER_FINALITY_DEPTH;
  if (raw === undefined || raw === '') return DEFAULT_FINALITY_DEPTH;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      `[IndexerService] Invalid INDEXER_FINALITY_DEPTH="${raw}", falling back to ${DEFAULT_FINALITY_DEPTH}`,
    );
    return DEFAULT_FINALITY_DEPTH;
  }
  return parsed;
}

/**
 * A single observed ledger header, used to detect reorgs by comparing the
 * hash we recorded against the hash the network now reports for that ledger.
 */
export interface ObservedLedger {
  ledgerSequence: number;
  ledgerHash: string;
  parentHash: string | null;
}

/**
 * Classification of a detected chain reorganization.
 *
 * - `forkLedger` is the deepest ledger whose hash still matches the canonical
 *   chain. Everything strictly above it is orphaned.
 * - `depth` is the number of orphaned ledgers (tip - forkLedger).
 * - `orphanedLedgers` lists the ledger sequences that must be rolled back.
 */
export interface ReorgClassification {
  detected: boolean;
  forkLedger: number;
  depth: number;
  orphanedLedgers: number[];
  finalityDepth: number;
}

/**
 * Result of repairing projections after a reorg.
 */
export interface ReorgRepairResult {
  requestId: string;
  forkLedger: number;
  depth: number;
  orphanedLedgers: number[];
  deletedEvents: number;
  deletedStreams: number;
  previousLastLedger: number;
  previousLastCursor: string | null;
  newLastLedger: number;
  newLastCursor: string | null;
  reorgRecordId: string;
}

/**
 * Compare the canonical chain (as reported by the network) against the ledger
 * hashes we previously recorded. Returns the deepest matching ledger as the
 * fork point. If no divergence is found, `detected` is false.
 *
 * `canonical` must be ordered from oldest to newest and contain at least the
 * ledgers we have recorded up to the current tip.
 */
export function classifyReorg(
  recorded: ObservedLedger[],
  canonical: ObservedLedger[],
  finalityDepth: number = getFinalityDepth(),
): ReorgClassification {
  const canonicalBySeq = new Map<number, ObservedLedger>();
  for (const entry of canonical) canonicalBySeq.set(entry.ledgerSequence, entry);

  const sortedRecorded = [...recorded].sort(
    (a, b) => a.ledgerSequence - b.ledgerSequence,
  );

  let forkLedger = 0;
  const orphaned: number[] = [];
  for (const entry of sortedRecorded) {
    const current = canonicalBySeq.get(entry.ledgerSequence);
    if (current && current.ledgerHash === entry.ledgerHash) {
      forkLedger = entry.ledgerSequence;
      continue;
    }
    // Divergence: this ledger and everything above it is orphaned.
    orphaned.push(entry.ledgerSequence);
  }

  if (orphaned.length === 0) {
    return {
      detected: false,
      forkLedger,
      depth: 0,
      orphanedLedgers: [],
      finalityDepth,
    };
  }

  const tip = Math.max(...orphaned);
  return {
    detected: true,
    forkLedger,
    depth: tip - forkLedger,
    orphanedLedgers: orphaned.sort((a, b) => a - b),
    finalityDepth,
  };
}

/**
 * Broadcast a corrective `reorg` SSE event so connected clients can drop any
 * cached state above `forkLedger` and re-fetch canonical data. Returns the
 * number of subscribers notified.
 */
export async function broadcastReorgEvent(
  forkLedger: number,
  depth: number,
): Promise<number> {
  try {
    const { sseManager } = await import('../lib/sse.js');
    if (!sseManager || typeof sseManager.broadcast !== 'function') return 0;
    return sseManager.broadcast('reorg', {
      forkLedger,
      depth,
      detectedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      `[IndexerService] Failed to broadcast reorg SSE event (forkLedger=${forkLedger}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
}

/**
 * Repair indexed projections after a reorg has been classified.
 *
 * Within a single transaction we:
 *   1. Delete every StreamEvent whose ledger is above `forkLedger`.
 *   2. Delete every Stream whose creation ledger is above `forkLedger`.
 *   3. Roll the indexer cursor back to `forkLedger`.
 *   4. Persist a ReorgRecord for auditability.
 *
 * After the transaction commits we broadcast a corrective SSE event so clients
 * converge on the canonical chain.
 */
export async function repairReorg(
  classification: ReorgClassification,
  customRequestId?: string,
): Promise<ReorgRepairResult> {
  const requestId =
    customRequestId || requestContext.getStore()?.requestId || randomUUID();
  const { forkLedger, depth, orphanedLedgers } = classification;

  return requestContext.run({ requestId }, async () => {
    const result = await sorobanEventWorker.runExclusive(async () => {
      const state = await prisma.indexerState.findUnique({
        where: { id: INDEXER_STATE_ID },
      });
      const previousLastLedger = state?.lastLedger ?? 0;
      const previousLastCursor = state?.lastCursor ?? null;

      return prisma.$transaction(async (tx) => {
        const deletedEvents = await tx.streamEvent.deleteMany({
          where: { ledgerSequence: { gt: forkLedger } },
        });
        const deletedStreams = await tx.stream.deleteMany({
          where: { createdLedger: { gt: forkLedger } },
        });
        await tx.indexerState.upsert({
          where: { id: INDEXER_STATE_ID },
          create: {
            id: INDEXER_STATE_ID,
            lastLedger: forkLedger,
            lastCursor: null,
          },
          update: { lastLedger: forkLedger, lastCursor: null },
        });
        const record = await tx.reorgRecord.create({
          data: {
            forkLedger,
            depth,
            orphanedLedgers: JSON.stringify(orphanedLedgers),
            requestId,
          },
        });
        return {
          deletedEvents: deletedEvents.count,
          deletedStreams: deletedStreams.count,
          previousLastLedger,
          previousLastCursor,
          reorgRecordId: record.id,
        };
      });
    });

    await broadcastReorgEvent(forkLedger, depth);

    logger.info(
      `[IndexerService] Repaired reorg (requestId=${requestId}, forkLedger=${forkLedger}, depth=${depth}, deletedEvents=${result.deletedEvents}, deletedStreams=${result.deletedStreams})`,
    );

    return {
      requestId,
      forkLedger,
      depth,
      orphanedLedgers,
      deletedEvents: result.deletedEvents,
      deletedStreams: result.deletedStreams,
      previousLastLedger: result.previousLastLedger,
      previousLastCursor: result.previousLastCursor,
      newLastLedger: forkLedger,
      newLastCursor: null,
      reorgRecordId: result.reorgRecordId,
    };
  });
}

/**
 * Record an observed ledger header so future polls can detect reorgs by
 * comparing the stored hash against the canonical chain.
 */
export async function recordObservedLedger(entry: ObservedLedger): Promise<void> {
  await prisma.chainBlock.upsert({
    where: { ledgerSequence: entry.ledgerSequence },
    create: {
      ledgerSequence: entry.ledgerSequence,
      ledgerHash: entry.ledgerHash,
      parentHash: entry.parentHash,
    },
    update: {
      ledgerHash: entry.ledgerHash,
      parentHash: entry.parentHash,
    },
  });
}

/**
 * Detect and repair a reorg given the canonical chain observed from the
 * network. Returns `null` when no reorg is detected.
 */
export async function detectAndRepairReorg(
  canonical: ObservedLedger[],
  customRequestId?: string,
): Promise<ReorgRepairResult | null> {
  const recorded = await prisma.chainBlock.findMany({
    orderBy: { ledgerSequence: 'asc' },
  });
  if (recorded.length === 0) return null;

  const classification = classifyReorg(
    recorded.map((r) => ({
      ledgerSequence: r.ledgerSequence,
      ledgerHash: r.ledgerHash,
      parentHash: r.parentHash,
    })),
    canonical,
  );
  if (!classification.detected) return null;

  return repairReorg(classification, customRequestId);
}

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
    // Drop recorded block headers above the reset point so a subsequent poll
    // does not treat stale hashes as canonical (reorg detection relies on
    // ChainBlock being in sync with the indexer cursor).
    await prisma.chainBlock.deleteMany({
      where: { ledgerSequence: { gt: toLedger } },
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
