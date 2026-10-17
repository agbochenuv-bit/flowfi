import { prisma } from './prisma.js';
import type { IndexerState } from '../generated/prisma/index.js';
import logger from '../logger.js';
import { alertService } from '../services/alert.service.js';

export const INDEXER_STATE_ID = 'singleton';

export type IndexerStateRow = IndexerState;

/**
 * Ensure the singleton indexer_state row exists.
 * Uses a catch-and-retry pattern to handle the race condition where two
 * concurrent callers attempt the first insert simultaneously. If the
 * unique-constraint violation fires, we treat it as success and re-read.
 */
export async function ensureIndexerState(
  startLedger: number,
): Promise<IndexerStateRow> {
  const existing = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  if (existing) return existing;

  try {
    const created = await prisma.indexerState.create({
      data: {
        id: INDEXER_STATE_ID,
        lastLedger: startLedger,
        lastCursor: null,
      },
    });
    return created;
  } catch (err: unknown) {
    // P2002 = Prisma unique-constraint violation (code "P2002")
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      logger.warn(
        '[IndexerState] Concurrent first-insert detected; re-reading existing row.',
      );
      const existingAfterRace = await prisma.indexerState.findUnique({
        where: { id: INDEXER_STATE_ID },
      });
      if (!existingAfterRace) {
        throw new Error(
          '[IndexerState] Unique-constraint violation but row not found after race.',
        );
      }
      return existingAfterRace;
    }
    throw err;
  }
}

/**
 * Snapshot of indexer health inputs used for operational alert evaluation.
 */
export interface IndexerHealthSnapshot {
  /** Number of events currently sitting in the dead-letter queue. */
  deadLetterCount: number;
  /** Number of ledgers the indexer is behind the chain head. */
  indexerLag: number;
}

/**
 * Read dead-letter counts and indexer lag from Prisma and forward them to the
 * alert service's operational evaluation.
 *
 * This helper is intentionally best-effort: any failure (database error,
 * alerting misconfiguration, etc.) is logged and swallowed so that it can be
 * called from the indexer loop without ever breaking ingestion.
 *
 * @param chainHeadLedger Optional current chain head ledger. When omitted the
 *   lag is derived from the persisted indexer state only (lag of 0).
 * @returns The evaluated snapshot, or `null` when evaluation failed.
 */
export async function evaluateIndexerHealthAlerts(
  chainHeadLedger?: number,
): Promise<IndexerHealthSnapshot | null> {
  try {
    const [deadLetterCount, state] = await Promise.all([
      prisma.deadLetterEvent.count(),
      prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } }),
    ]);

    const lastLedger = state?.lastLedger ?? 0;
    const indexerLag =
      typeof chainHeadLedger === 'number' && chainHeadLedger > lastLedger
        ? chainHeadLedger - lastLedger
        : 0;

    const snapshot: IndexerHealthSnapshot = { deadLetterCount, indexerLag };

    await alertService.evaluateOperationalAlerts(snapshot);

    return snapshot;
  } catch (err) {
    logger.error(
      '[IndexerState] Operational alert evaluation failed; continuing indexer loop.',
      err,
    );
    return null;
  }
}
