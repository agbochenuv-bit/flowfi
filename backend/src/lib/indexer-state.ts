import { prisma } from './prisma.js';
import type { IndexerState } from '../generated/prisma/index.js';
import logger from '../logger.js';
import { alertService } from '../services/alert.service.js';

export const INDEXER_STATE_ID = 'singleton';

export type IndexerStateRow = IndexerState;

/**
 * Lease metadata persisted alongside the singleton cursor row.
 *
 * - `leaseOwner`: identity of the replica currently allowed to poll.
 * - `leaseToken`: monotonically increasing fencing token. Bumped on every
 *   successful acquisition/takeover so stale writers can be rejected.
 * - `leaseExpiresAt`: wall-clock expiry; `null` means no active lease.
 */
export interface IndexerLease {
  owner: string;
  fencingToken: number;
  expiresAt: Date;
}

export interface AcquireLeaseResult {
  acquired: boolean;
  fencingToken: number | null;
  expiresAt: Date | null;
}

export interface RenewLeaseResult {
  renewed: boolean;
  expiresAt: Date | null;
}

export interface ReleaseLeaseResult {
  released: boolean;
}

export interface WriteCursorResult {
  written: boolean;
  lastLedger: number | null;
  lastCursor: string | null;
}

/**
 * Error thrown when a cursor write is attempted with a fencing token that is
 * no longer the current lease token (e.g. the lease expired and another
 * replica took over). Callers should stop polling and re-acquire.
 */
export class StaleLeaseError extends Error {
  readonly suppliedToken: number;
  readonly currentToken: number | null;

  constructor(suppliedToken: number, currentToken: number | null) {
    super(
      `[IndexerState] Stale lease fencing token ${suppliedToken} (current: ${
        currentToken ?? 'none'
      }).`,
    );
    this.name = 'StaleLeaseError';
    this.suppliedToken = suppliedToken;
    this.currentToken = currentToken;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code: string }).code === 'P2002'
  );
}

/**
 * Atomically acquire the poll lease for `ownerId`.
 *
 * Succeeds only when there is no active (unexpired) lease, or when the
 * current lease has expired (takeover). On success the fencing token is
 * incremented and the expiry is set to `now + ttlMs`. The conditional
 * UPDATE is executed inside a transaction so concurrent replicas cannot
 * both observe "expired" and both take over: the loser's WHERE clause no
 * longer matches and it observes `acquired: false`.
 *
 * Returns the new fencing token on success.
 */
export async function acquireLease(
  ownerId: string,
  ttlMs: number,
): Promise<AcquireLeaseResult> {
  if (!ownerId) throw new Error('[IndexerState] ownerId is required.');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('[IndexerState] ttlMs must be a positive number.');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  return prisma.$transaction(async (tx) => {
    // Conditional takeover: only matches when the lease is absent or expired.
    // `leaseToken` is bumped so any in-flight writer from the previous owner
    // is fenced out.
    const updated = await tx.$executeRaw`
      UPDATE "indexer_state"
      SET "lease_owner" = ${ownerId},
          "lease_token" = COALESCE("lease_token", 0) + 1,
          "lease_expires_at" = ${expiresAt}
      WHERE "id" = ${INDEXER_STATE_ID}
        AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ${now})
    `;

    if (updated === 1) {
      const row = await tx.indexerState.findUnique({
        where: { id: INDEXER_STATE_ID },
      });
      return {
        acquired: true,
        fencingToken: row?.leaseToken ?? null,
        expiresAt: row?.leaseExpiresAt ?? expiresAt,
      };
    }

    // No row yet: attempt to create the singleton with the lease already held.
    try {
      const created = await tx.indexerState.create({
        data: {
          id: INDEXER_STATE_ID,
          lastLedger: 0,
          lastCursor: null,
          leaseOwner: ownerId,
          leaseToken: 1,
          leaseExpiresAt: expiresAt,
        },
      });
      return {
        acquired: true,
        fencingToken: created.leaseToken,
        expiresAt: created.leaseExpiresAt ?? expiresAt,
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // Another replica created the row first; we did not win the lease.
        return { acquired: false, fencingToken: null, expiresAt: null };
      }
      throw err;
    }
  });
}

/**
 * Extend the lease expiry, but only if `ownerId` and `fencingToken` still
 * match the persisted lease. Returns `renewed: false` when the lease was
 * lost (expired and taken over, released, or token mismatch).
 */
export async function renewLease(
  ownerId: string,
  fencingToken: number,
  ttlMs: number,
): Promise<RenewLeaseResult> {
  if (!ownerId) throw new Error('[IndexerState] ownerId is required.');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('[IndexerState] ttlMs must be a positive number.');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const updated = await prisma.$executeRaw`
    UPDATE "indexer_state"
    SET "lease_expires_at" = ${expiresAt}
    WHERE "id" = ${INDEXER_STATE_ID}
      AND "lease_owner" = ${ownerId}
      AND "lease_token" = ${fencingToken}
      AND "lease_expires_at" IS NOT NULL
      AND "lease_expires_at" > ${now}
  `;

  if (updated === 1) {
    return { renewed: true, expiresAt };
  }
  return { renewed: false, expiresAt: null };
}

/**
 * Release the lease held by `ownerId` with `fencingToken`. Only clears the
 * lease when both match; the fencing token is left in place so any late
 * writer from this owner is still rejected until the next takeover bumps it.
 */
export async function releaseLease(
  ownerId: string,
  fencingToken: number,
): Promise<ReleaseLeaseResult> {
  if (!ownerId) throw new Error('[IndexerState] ownerId is required.');

  const updated = await prisma.$executeRaw`
    UPDATE "indexer_state"
    SET "lease_owner" = NULL,
        "lease_expires_at" = NULL
    WHERE "id" = ${INDEXER_STATE_ID}
      AND "lease_owner" = ${ownerId}
      AND "lease_token" = ${fencingToken}
  `;

  return { released: updated === 1 };
}

/**
 * Read the current lease, if any. Returns `null` when no lease is held.
 */
export async function getLease(): Promise<IndexerLease | null> {
  const row = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });
  if (!row || !row.leaseOwner || row.leaseToken === null) return null;
  return {
    owner: row.leaseOwner,
    fencingToken: row.leaseToken,
    expiresAt: row.leaseExpiresAt ?? new Date(0),
  };
}

/**
 * Assert that `fencingToken` is the current lease token. Throws
 * `StaleLeaseError` otherwise. This is the fencing check used before any
 * cursor advancement.
 */
export async function assertLeaseFence(fencingToken: number): Promise<void> {
  const row = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
    select: { leaseToken: true },
  });
  const current = row?.leaseToken ?? null;
  if (current === null || current !== fencingToken) {
    throw new StaleLeaseError(fencingToken, current);
  }
}

/**
 * Advance the cursor, but only if `fencingToken` is still the current lease
 * token. The check and the write happen in a single conditional UPDATE so a
 * takeover between check and write cannot let a stale writer through.
 *
 * Returns `written: false` (without throwing) when the fence is stale; use
 * `assertLeaseFence` when a thrown error is preferred.
 */
export async function writeCursorWithFence(
  fencingToken: number,
  lastLedger: number,
  lastCursor: string | null,
): Promise<WriteCursorResult> {
  const updated = await prisma.$executeRaw`
    UPDATE "indexer_state"
    SET "last_ledger" = ${lastLedger},
        "last_cursor" = ${lastCursor}
    WHERE "id" = ${INDEXER_STATE_ID}
      AND "lease_token" = ${fencingToken}
  `;

  if (updated === 1) {
    return { written: true, lastLedger, lastCursor };
  }

  const row = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
    select: { leaseToken: true },
  });
  return {
    written: false,
    lastLedger: row ? null : null,
    lastCursor: null,
  };
}

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
    if (isUniqueViolation(err)) {
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
