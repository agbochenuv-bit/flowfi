import { createHash } from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Archive service for StreamEvent archival.
 *
 * Retention is configurable via:
 *   - EVENT_ARCHIVE_RETENTION_LEDGERS (preferred; ledger-based boundary)
 *   - EVENT_ARCHIVE_RETENTION_DAYS    (fallback; time-based boundary)
 *
 * Archival moves StreamEvents older than the retention boundary into
 * StreamEventArchive inside a single transaction and records an ArchiveBatch
 * with a deterministic integrity hash (sha256 over ordered event fields).
 *
 * ---------------------------------------------------------------------------
 * SAFE RESTORE PROCEDURE
 * ---------------------------------------------------------------------------
 * restoreArchiveBatch(id) re-inserts archived events into the hot table
 * idempotently (upsert on primary key) and marks the batch restored.
 *
 * Recommended operational procedure:
 *   1. Verify integrity first: `await verifyArchiveBatch(id)`.
 *      Do NOT restore a batch whose hash does not match unless an operator
 *      has explicitly accepted the risk (record the decision).
 *   2. Pause archival workers so no new batch is created mid-restore.
 *   3. Run restoreArchiveBatch(id) inside a maintenance window. The restore
 *      is idempotent: re-running it is safe and will not duplicate rows.
 *   4. Re-run verifyArchiveBatch(id) and spot-check hot-table counts for the
 *      restored ledger range.
 *   5. Resume archival workers.
 * ---------------------------------------------------------------------------
 */

export interface ArchiveConfig {
  retentionLedgers?: number;
  retentionDays?: number;
}

export interface ArchiveBatchResult {
  batchId: string;
  archivedCount: number;
  integrityHash: string;
  fromLedger: number | null;
  toLedger: number | null;
}

export interface VerifyResult {
  batchId: string;
  ok: boolean;
  expectedHash: string;
  actualHash: string;
  mismatches: Array<{ eventId: string; reason: string }>;
}

export interface RestoreResult {
  batchId: string;
  restoredCount: number;
  alreadyRestored: boolean;
}

export interface EventListQuery {
  contractId?: string;
  fromLedger?: number;
  toLedger?: number;
  limit?: number;
  offset?: number;
  includeArchive?: boolean;
}

export interface EventListRow {
  id: string;
  contractId: string;
  ledger: number;
  eventType: string;
  payload: unknown;
  source: 'hot' | 'archive';
}

const DEFAULT_RETENTION_DAYS = 30;

export function resolveArchiveConfig(
  env: NodeJS.ProcessEnv = process.env,
): ArchiveConfig {
  const ledgersRaw = env.EVENT_ARCHIVE_RETENTION_LEDGERS;
  const daysRaw = env.EVENT_ARCHIVE_RETENTION_DAYS;

  const retentionLedgers =
    ledgersRaw !== undefined && ledgersRaw !== ''
      ? Number.parseInt(ledgersRaw, 10)
      : undefined;
  const retentionDays =
    daysRaw !== undefined && daysRaw !== ''
      ? Number.parseInt(daysRaw, 10)
      : undefined;

  if (retentionLedgers !== undefined && Number.isNaN(retentionLedgers)) {
    throw new Error('EVENT_ARCHIVE_RETENTION_LEDGERS must be an integer');
  }
  if (retentionDays !== undefined && Number.isNaN(retentionDays)) {
    throw new Error('EVENT_ARCHIVE_RETENTION_DAYS must be an integer');
  }
  if (retentionLedgers !== undefined && retentionLedgers < 0) {
    throw new Error('EVENT_ARCHIVE_RETENTION_LEDGERS must be >= 0');
  }
  if (retentionDays !== undefined && retentionDays < 0) {
    throw new Error('EVENT_ARCHIVE_RETENTION_DAYS must be >= 0');
  }

  return { retentionLedgers, retentionDays };
}

/**
 * Deterministic serialization of an event for hashing.
 * Field order is fixed so the hash is stable across runs.
 */
function serializeEventForHash(event: {
  id: string;
  contractId: string;
  ledger: number;
  eventType: string;
  payload: unknown;
}): string {
  return JSON.stringify({
    id: event.id,
    contractId: event.contractId,
    ledger: event.ledger,
    eventType: event.eventType,
    payload: event.payload ?? null,
  });
}

/**
 * Compute the batch integrity hash: sha256 over the ordered, serialized events.
 * Events are sorted by (ledger, id) to guarantee determinism.
 */
export function computeBatchHash(
  events: Array<{
    id: string;
    contractId: string;
    ledger: number;
    eventType: string;
    payload: unknown;
  }>,
): string {
  const ordered = [...events].sort((a, b) => {
    if (a.ledger !== b.ledger) return a.ledger - b.ledger;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const hash = createHash('sha256');
  for (const event of ordered) {
    hash.update(serializeEventForHash(event));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export class ArchiveService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Determine the retention boundary.
   * Returns the highest ledger that is still considered "hot" (inclusive),
   * or null when no boundary can be computed (nothing to archive).
   */
  async computeRetentionBoundary(
    config: ArchiveConfig = resolveArchiveConfig(),
  ): Promise<number | null> {
    if (config.retentionLedgers !== undefined) {
      const latest = await this.prisma.streamEvent.findFirst({
        orderBy: { ledger: 'desc' },
        select: { ledger: true },
      });
      if (!latest) return null;
      const boundary = latest.ledger - config.retentionLedgers;
      return boundary < 0 ? null : boundary;
    }

    const days = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const oldestHot = await this.prisma.streamEvent.findFirst({
      where: { createdAt: { gte: cutoff } },
      orderBy: { ledger: 'asc' },
      select: { ledger: true },
    });
    if (!oldestHot) return null;
    return oldestHot.ledger - 1;
  }

  /**
   * Archive all StreamEvents with ledger <= boundary into StreamEventArchive
   * within a single transaction, recording an ArchiveBatch with integrity hash.
   */
  async archiveOlderThan(
    boundary: number,
    config: ArchiveConfig = resolveArchiveConfig(),
  ): Promise<ArchiveBatchResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const events = await tx.streamEvent.findMany({
        where: { ledger: { lte: boundary } },
        orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
      });

      if (events.length === 0) return null;

      const integrityHash = computeBatchHash(events);
      const fromLedger = events[0].ledger;
      const toLedger = events[events.length - 1].ledger;

      const batch = await tx.archiveBatch.create({
        data: {
          integrityHash,
          eventCount: events.length,
          fromLedger,
          toLedger,
          retentionLedgers: config.retentionLedgers ?? null,
          retentionDays: config.retentionDays ?? null,
          restored: false,
        },
      });

      await tx.streamEventArchive.createMany({
        data: events.map((e) => ({
          id: e.id,
          batchId: batch.id,
          contractId: e.contractId,
          ledger: e.ledger,
          eventType: e.eventType,
          payload: e.payload as Prisma.InputJsonValue,
          createdAt: e.createdAt,
        })),
      });

      await tx.streamEvent.deleteMany({
        where: { id: { in: events.map((e) => e.id) } },
      });

      return {
        batchId: batch.id,
        archivedCount: events.length,
        integrityHash,
        fromLedger,
        toLedger,
      };
    });
  }

  /**
   * Convenience: compute boundary from config and archive in one call.
   */
  async runArchival(
    config: ArchiveConfig = resolveArchiveConfig(),
  ): Promise<ArchiveBatchResult | null> {
    const boundary = await this.computeRetentionBoundary(config);
    if (boundary === null) return null;
    return this.archiveOlderThan(boundary, config);
  }

  /**
   * Recompute the integrity hash for a batch and report mismatches.
   */
  async verifyArchiveBatch(id: string): Promise<VerifyResult> {
    const batch = await this.prisma.archiveBatch.findUnique({
      where: { id },
    });
    if (!batch) {
      throw new Error(`ArchiveBatch ${id} not found`);
    }

    const archived = await this.prisma.streamEventArchive.findMany({
      where: { batchId: id },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    const actualHash = computeBatchHash(
      archived.map((e) => ({
        id: e.id,
        contractId: e.contractId,
        ledger: e.ledger,
        eventType: e.eventType,
        payload: e.payload,
      })),
    );

    const mismatches: Array<{ eventId: string; reason: string }> = [];
    if (archived.length !== batch.eventCount) {
      mismatches.push({
        eventId: '*',
        reason: `event count mismatch: expected ${batch.eventCount}, found ${archived.length}`,
      });
    }
    if (actualHash !== batch.integrityHash) {
      mismatches.push({
        eventId: '*',
        reason: 'integrity hash mismatch',
      });
    }

    return {
      batchId: id,
      ok: mismatches.length === 0,
      expectedHash: batch.integrityHash,
      actualHash,
      mismatches,
    };
  }

  /**
   * Idempotently restore archived events into the hot table and mark the batch
   * restored. Safe to call multiple times.
   */
  async restoreArchiveBatch(id: string): Promise<RestoreResult> {
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.archiveBatch.findUnique({ where: { id } });
      if (!batch) {
        throw new Error(`ArchiveBatch ${id} not found`);
      }

      const archived = await tx.streamEventArchive.findMany({
        where: { batchId: id },
        orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
      });

      let restoredCount = 0;
      for (const event of archived) {
        const existing = await tx.streamEvent.findUnique({
          where: { id: event.id },
          select: { id: true },
        });
        if (existing) continue;

        await tx.streamEvent.create({
          data: {
            id: event.id,
            contractId: event.contractId,
            ledger: event.ledger,
            eventType: event.eventType,
            payload: event.payload as Prisma.InputJsonValue,
            createdAt: event.createdAt,
          },
        });
        restoredCount += 1;
      }

      if (!batch.restored) {
        await tx.archiveBatch.update({
          where: { id },
          data: { restored: true, restoredAt: new Date() },
        });
      }

      return {
        batchId: id,
        restoredCount,
        alreadyRestored: batch.restored,
      };
    });
  }

  /**
   * Archive-aware listing. Queries the hot table and (optionally) the archive
   * table across the boundary, returning a merged, ordered result.
   */
  async listEvents(query: EventListQuery): Promise<EventListRow[]> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const where: Prisma.StreamEventWhereInput = {};
    if (query.contractId) where.contractId = query.contractId;
    if (query.fromLedger !== undefined || query.toLedger !== undefined) {
      where.ledger = {};
      if (query.fromLedger !== undefined) where.ledger.gte = query.fromLedger;
      if (query.toLedger !== undefined) where.ledger.lte = query.toLedger;
    }

    const hot = await this.prisma.streamEvent.findMany({
      where,
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    const rows: EventListRow[] = hot.map((e) => ({
      id: e.id,
      contractId: e.contractId,
      ledger: e.ledger,
      eventType: e.eventType,
      payload: e.payload,
      source: 'hot' as const,
    }));

    if (query.includeArchive) {
      const archiveWhere: Prisma.StreamEventArchiveWhereInput = {};
      if (query.contractId) archiveWhere.contractId = query.contractId;
      if (query.fromLedger !== undefined || query.toLedger !== undefined) {
        archiveWhere.ledger = {};
        if (query.fromLedger !== undefined)
          archiveWhere.ledger.gte = query.fromLedger;
        if (query.toLedger !== undefined)
          archiveWhere.ledger.lte = query.toLedger;
      }

      const archived = await this.prisma.streamEventArchive.findMany({
        where: archiveWhere,
        orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
      });

      const hotIds = new Set(rows.map((r) => r.id));
      for (const e of archived) {
        if (hotIds.has(e.id)) continue;
        rows.push({
          id: e.id,
          contractId: e.contractId,
          ledger: e.ledger,
          eventType: e.eventType,
          payload: e.payload,
          source: 'archive',
        });
      }
    }

    rows.sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return rows.slice(offset, offset + limit);
  }
}

export default ArchiveService;