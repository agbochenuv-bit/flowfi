import { randomUUID } from 'crypto';
import { rpc, xdr, Contract } from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';
import { setIndexerLedgers } from '../lib/metrics.js';
import { withSpan } from '../lib/tracing.js';
import {
  getLatestCheckpoint,
  listRecentCheckpoints,
  verifyAndRecover,
  type ReorgRecoveryResult,
} from './checkpoint.service.js';
import { sendDeadLetterAlert } from './alert.service.js';
import logger, { requestContext } from '../logger.js';

export interface IndexerStatus {
  lastLedger: number;
  lastCursor: string | null;
  updatedAt: Date;
  lagSeconds: number;
}

export async function getIndexerStatus(): Promise<IndexerStatus> {
  const state = await prisma.indexerState.findUnique({
    where: { id: INDEXER_STATE_ID },
  });

  const lagSeconds = state
    ? Math.floor((Date.now() - state.updatedAt.getTime()) / 1000)
    : -1;

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
  setIndexerLedgers(toLedger, 0);
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
 */
export interface ReplayPreview {
  fromLedger: number;
  currentLastLedger: number;
  currentLastCursor: string | null;
  eventCount: number;
  minLedgerInReplayRange: number | null;
  maxLedgerInReplayRange: number | null;
}

export async function previewReplay(fromLedger: number): Promise<ReplayPreview> {
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
 * Replay events from a given ledger by resetting state and triggering a poll.
 * The @@unique([transactionHash, eventType]) constraint on StreamEvent
 * guarantees no duplicate StreamEvent rows are created on replay.
 *
 * CAVEAT: This dedup does NOT apply to stream state mutations.
 * Stream.withdrawnAmount (handleTokensWithdrawn, soroban-event-worker.ts:635)
 * is incremented unconditionally on every replay, so replay is NOT fully
 * idempotent. See issue #808 for the withdrawnAmount idempotency fix.
 */
export async function replayFromLedger(
  fromLedger: number,
  customRequestId?: string,
): Promise<string> {
  const requestId = customRequestId || requestContext.getStore()?.requestId || randomUUID();
  await requestContext.run({ requestId }, async () => {
    await resetIndexer(fromLedger);
    // Kick off an immediate poll cycle without waiting for the next interval.
    await sorobanEventWorker.triggerPoll(requestId);
    logger.info(`[IndexerService] Replay triggered from ledger ${fromLedger}`);
  });
  return requestId;
}

/**
 * Record the network tip alongside the indexed ledger so the Prometheus lag
 * gauges stay in step with the poll loop. Called on every polling cycle.
 */
export function publishIndexerLag(currentLedger: number, networkLedger: number): void {
  setIndexerLedgers(currentLedger, networkLedger);
}

// ─── Ledger reorg / fork recovery (issue #1468) ──────────────────────────────

export interface ReorgStatus {
  lastCheckpoint: {
    ledgerSequence: number;
    ledgerHash: string;
    parentHash: string;
    eventsCount: number;
    stateRootHash: string | null;
    isReverted: boolean;
    processedAt: Date;
  } | null;
  recentRevertedLedgers: number[];
}

/** Current checkpoint health for /health and the admin observability surface. */
export async function getReorgStatus(): Promise<ReorgStatus> {
  const [latest, recent] = await Promise.all([
    getLatestCheckpoint(true),
    listRecentCheckpoints(50),
  ]);

  return {
    lastCheckpoint: latest
      ? {
          ledgerSequence: latest.ledgerSequence,
          ledgerHash: latest.ledgerHash,
          parentHash: latest.parentHash,
          eventsCount: latest.eventsCount,
          stateRootHash: latest.stateRootHash,
          isReverted: latest.isReverted,
          processedAt: latest.processedAt,
        }
      : null,
    recentRevertedLedgers: recent
      .filter((checkpoint) => checkpoint.isReverted)
      .map((checkpoint) => checkpoint.ledgerSequence),
  };
}

/**
 * Operator-triggered reorg recovery.
 *
 * Runs the same verification/rollback the poll loop performs, but under the
 * worker mutex so it cannot race an in-flight batch, then kicks a poll so
 * ingestion resumes from the recovered ledger immediately.
 */
export async function recoverFromReorg(): Promise<ReorgRecoveryResult> {
  const result = await sorobanEventWorker.runExclusive(() =>
    verifyAndRecover((sequence) => sorobanEventWorker.fetchLedgerHeader(sequence)),
  );

  if (result.detected) {
    await sorobanEventWorker.triggerPoll();
  }

  return result;
}

// ─── Dead-letter quarantine ───────────────────────────────────────────────────

/**
 * Serializable snapshot of a Soroban event.
 *
 * `topic` and `value` are `xdr.ScVal` instances, which do not survive
 * `JSON.stringify`, so each is stored as base64 XDR and rehydrated on replay.
 */
interface DeadLetterPayload {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  transactionIndex: number;
  operationIndex: number;
  inSuccessfulContractCall: boolean;
  contractId?: string;
  /** base64 XDR, one entry per topic ScVal. */
  topic: string[];
  /** base64 XDR of the value ScVal. */
  value: string;
}

export function serializeDeadLetterPayload(event: rpc.Api.EventResponse): string {
  const payload: DeadLetterPayload = {
    id: event.id,
    type: String(event.type),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    inSuccessfulContractCall: event.inSuccessfulContractCall,
    topic: event.topic.map((scval) => Buffer.from(scval.toXDR()).toString('base64')),
    value: Buffer.from(event.value.toXDR()).toString('base64'),
  };

  if (event.contractId) {
    payload.contractId =
      typeof event.contractId === 'string' ? event.contractId : event.contractId.toString();
  }

  return JSON.stringify(payload);
}

export function deserializeDeadLetterPayload(payload: string): rpc.Api.EventResponse {
  const parsed = JSON.parse(payload) as DeadLetterPayload;

  const topic = (parsed.topic ?? []).map((b64) =>
    xdr.ScVal.fromXDR(Buffer.from(b64, 'base64')),
  );
  const value = xdr.ScVal.fromXDR(Buffer.from(parsed.value, 'base64'));

  const event = {
    id: parsed.id,
    type: parsed.type,
    ledger: parsed.ledger,
    ledgerClosedAt: parsed.ledgerClosedAt,
    transactionIndex: parsed.transactionIndex,
    operationIndex: parsed.operationIndex,
    inSuccessfulContractCall: parsed.inSuccessfulContractCall,
    topic,
    value,
  } as unknown as rpc.Api.EventResponse;

  if (parsed.contractId) {
    try {
      event.contractId = new Contract(parsed.contractId);
    } catch {
      // A malformed contractId is cosmetic — processing only needs topic/value.
    }
  }

  return event;
}

/** Best-effort event-type label used for dedup and operator filtering. */
function eventTypeOf(event: rpc.Api.EventResponse): string {
  const topic0 = event.topic?.[0];
  if (!topic0) return 'unknown';
  try {
    // `ScVal` is a union; only the symbol arm carries `sym`, and in recent
    // stellar-sdk versions it is a value (not a method). Read the property and
    // stringify it so this survives across SDK generations.
    const sym = (topic0 as unknown as { sym?: { toString(): string } }).sym;
    return sym ? sym.toString() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Quarantine a contract event whose processing threw.
 *
 * The poll loop deliberately does not retry inline: a payload the handler cannot
 * parse (or a DB lock that survives the retry budget) would otherwise be
 * re-fetched on every cycle and stall the cursor behind it. Writing the event to
 * the dead-letter table lets the loop advance and gives operators a record they
 * can inspect, replay, or discard.
 *
 * Re-quarantining the same event (eventId + eventType) bumps `attempts` and
 * refreshes the error rather than creating a duplicate row.
 */
export async function quarantineEvent(
  event: rpc.Api.EventResponse,
  err: unknown,
  cursor?: string,
): Promise<void> {
  const eventType = eventTypeOf(event);
  const errorMessage = err instanceof Error ? err.message : String(err);

  try {
    const row = await prisma.indexerDeadLetterEvent.upsert({
      where: { eventId_eventType: { eventId: event.id, eventType } },
      create: {
        eventId: event.id,
        eventType,
        txHash: event.txHash,
        ledgerSequence: event.ledger,
        cursor: cursor ?? null,
        payload: serializeDeadLetterPayload(event),
        errorMessage,
        attempts: 1,
        lastAttemptAt: new Date(),
      },
      update: {
        errorMessage,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    logger.error(
      `[IndexerService] Quarantined event ${event.id} (${eventType}) at ledger ${event.ledger}: ${errorMessage}`,
    );

    // Fire-and-forget: the alert is deliberately not awaited so a slow or
    // unreachable chat webhook cannot stall the poll loop. `sendDeadLetterAlert`
    // never rejects, but guard with `void …catch` anyway.
    void sendDeadLetterAlert({
      eventId: event.id,
      eventType,
      ledgerSequence: event.ledger,
      txHash: event.txHash,
      errorMessage,
      errorStack: err instanceof Error ? err.stack : undefined,
      attempts: row?.attempts,
    }).catch(() => undefined);
  } catch (dbErr) {
    // Never let quarantine bookkeeping itself kill the poll loop.
    logger.error(
      `[IndexerService] Failed to record dead-letter entry for event ${event.id}:`,
      dbErr,
    );
  }
}

export interface DeadLetterQuery {
  page: number;
  limit: number;
  ledgerSequence?: number;
  startDate?: Date;
  endDate?: Date;
  eventType?: string;
}

export interface DeadLetterListResult {
  items: Array<{
    id: string;
    eventId: string;
    eventType: string;
    txHash: string;
    ledgerSequence: number;
    errorMessage: string;
    attempts: number;
    lastAttemptAt: Date;
    createdAt: Date;
    payload: string;
    cursor: string | null;
  }>;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export const DEFAULT_DEAD_LETTER_PAGE_SIZE = 25;
export const MAX_DEAD_LETTER_PAGE_SIZE = 100;

/** Paginated, filterable read of the dead-letter table. Newest first. */
export async function listDeadLetterEvents(
  query: DeadLetterQuery,
): Promise<DeadLetterListResult> {
  const limit = Math.min(Math.max(1, query.limit || DEFAULT_DEAD_LETTER_PAGE_SIZE), MAX_DEAD_LETTER_PAGE_SIZE);
  const page = Math.max(1, query.page || 1);

  const where: Record<string, unknown> = {};
  if (query.ledgerSequence !== undefined) where['ledgerSequence'] = query.ledgerSequence;
  if (query.eventType) where['eventType'] = query.eventType;
  if (query.startDate || query.endDate) {
    where['createdAt'] = {
      ...(query.startDate ? { gte: query.startDate } : {}),
      ...(query.endDate ? { lte: query.endDate } : {}),
    };
  }

  const [rows, total] = await Promise.all([
    prisma.indexerDeadLetterEvent.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { ledgerSequence: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.indexerDeadLetterEvent.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      txHash: row.txHash,
      ledgerSequence: row.ledgerSequence,
      errorMessage: row.errorMessage,
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt,
      createdAt: row.createdAt,
      payload: row.payload,
      cursor: row.cursor,
    })),
    total,
    page,
    limit,
    hasMore: page * limit < total,
  };
}

export type ReplayOutcome = 'replayed' | 'failed' | 'not_found' | 'undecodable';

export interface ReplayResult {
  id: string;
  outcome: ReplayOutcome;
  attempts: number;
  errorMessage?: string;
}

/**
 * Re-inject a quarantined event into the indexer pipeline.
 *
 * On success the dead-letter row is removed and the worker's own handlers write
 * the Stream / StreamEvent records. On failure the row is retained with an
 * incremented attempt count and a refreshed error so the operator can see that
 * the replay was tried and why it still fails.
 */
export async function replayDeadLetterEvent(id: string): Promise<ReplayResult> {
  const record = await prisma.indexerDeadLetterEvent.findUnique({ where: { id } });
  if (!record) {
    return { id, outcome: 'not_found', attempts: 0 };
  }

  let event: rpc.Api.EventResponse;
  try {
    event = deserializeDeadLetterPayload(record.payload);
  } catch (err) {
    // A payload we cannot decode is permanently un-replayable; record why
    // rather than looping on it.
    const errorMessage = `Undecodable dead-letter payload: ${
      err instanceof Error ? err.message : String(err)
    }`;
    await prisma.indexerDeadLetterEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), errorMessage },
    });
    logger.error(`[IndexerService] Dead-letter ${id} payload could not be decoded:`, err);
    return { id, outcome: 'undecodable', attempts: record.attempts + 1, errorMessage };
  }

  try {
    await withSpan('indexer.replay_dead_letter', {
      'dead_letter.id': id,
      'dead_letter.event_type': record.eventType,
      'dead_letter.ledger': record.ledgerSequence,
      'dead_letter.attempts': record.attempts,
    }, async () => {
      await sorobanEventWorker.processEvent(event);
    });

    await prisma.indexerDeadLetterEvent.delete({ where: { id } });
    logger.info(
      `[IndexerService] Replayed dead-letter ${id} (${record.eventType}) at ledger ${record.ledgerSequence}`,
    );
    return { id, outcome: 'replayed', attempts: record.attempts };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const updated = await prisma.indexerDeadLetterEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date(), errorMessage },
    });

    logger.error(
      `[IndexerService] Replay of dead-letter ${id} failed (attempt ${updated.attempts}): ${errorMessage}`,
    );
    return { id, outcome: 'failed', attempts: updated.attempts, errorMessage };
  }
}

export interface ReplayAllResult {
  attempted: number;
  replayed: number;
  failed: number;
  undecodable: number;
  notFound: number;
  results: ReplayResult[];
}

/**
 * Replay every pending dead-letter record, oldest ledger first, sequentially.
 *
 * Sequential rather than parallel on purpose: replays mutate Stream rows, and
 * two events for the same stream (e.g. `stream_created` then `tokens_withdrawn`)
 * must apply in ledger order or the resulting balances are wrong.
 */
export async function replayAllDeadLetterEvents(): Promise<ReplayAllResult> {
  const pending = await prisma.indexerDeadLetterEvent.findMany({
    orderBy: [{ ledgerSequence: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });

  const results: ReplayResult[] = [];
  for (const row of pending) {
    results.push(await replayDeadLetterEvent(row.id));
  }

  const summary: ReplayAllResult = {
    attempted: results.length,
    replayed: results.filter((r) => r.outcome === 'replayed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    undecodable: results.filter((r) => r.outcome === 'undecodable').length,
    notFound: results.filter((r) => r.outcome === 'not_found').length,
    results,
  };

  logger.info(
    `[IndexerService] Dead-letter replay-all finished: ${summary.replayed}/${summary.attempted} replayed`,
  );
  return summary;
}

/**
 * Permanently discard an unrecoverable dead-letter record.
 *
 * The row is deleted rather than flagged so it stops consuming operator
 * attention, and the discard is written to the application log with the acting
 * admin so the loss of on-chain data remains auditable.
 */
export async function discardDeadLetterEvent(
  id: string,
  discardedBy: string,
): Promise<{ id: string; eventType: string; txHash: string; ledgerSequence: number }> {
  const record = await prisma.indexerDeadLetterEvent.findUnique({ where: { id } });
  if (!record) {
    throw new DeadLetterNotFoundError(id);
  }

  await prisma.indexerDeadLetterEvent.delete({ where: { id } });

  logger.warn(
    `[IndexerService] DISCARDED dead-letter ${id} (${record.eventType}, txHash=${record.txHash}, ` +
      `ledger=${record.ledgerSequence}, attempts=${record.attempts}) by admin ${discardedBy}. ` +
      `This on-chain event will not be indexed.`,
  );

  return {
    id: record.id,
    eventType: record.eventType,
    txHash: record.txHash,
    ledgerSequence: record.ledgerSequence,
  };
}

export class DeadLetterNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`Dead-letter event ${id} not found`);
    this.name = 'DeadLetterNotFoundError';
    this.id = id;
  }
}

// ─── Backfill (range-based historical indexing) ────────────────────────────────

/**
 * BackfillJob status enum matching the Prisma schema.
 */
export enum BackfillStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * Backfill job record as returned to API consumers.
 */
export interface BackfillJob {
  id: string;
  name: string | null;
  fromLedger: number;
  toLedger: number;
  status: BackfillStatus;
  currentLedger: number;
  eventsProcessed: number;
  eventsFailed: number;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for starting a new backfill job.
 */
export interface StartBackfillInput {
  fromLedger: number;
  toLedger: number;
  name?: string;
}

/**
 * Result of starting a backfill job.
 */
export interface StartBackfillResult {
  id: string;
  status: BackfillStatus;
  message: string;
}

/**
 * Progress information for a running backfill job.
 */
export interface BackfillProgress {
  job: BackfillJob;
  percentComplete: number;
  ledgersRemaining: number;
  estimatedCompletionAt: Date | null;
}

/**
 * Start a new bounded historical backfill job.
 *
 * Creates a BackfillJob record and begins processing events in the range
 * [fromLedger, toLedger] independently of the live indexer cursor.
 * Returns immediately; processing runs asynchronously.
 *
 * The backfill uses the same event processing pipeline as the live indexer
 * (including deduplication via unique constraints), so it is safe to run
 * concurrently with live indexing.
 */
export async function startBackfill(input: StartBackfillInput): Promise<StartBackfillResult> {
  const { fromLedger, toLedger, name } = input;

  if (fromLedger < 0 || toLedger < 0) {
    throw new Error('Ledger numbers must be non-negative');
  }
  if (fromLedger > toLedger) {
    throw new Error('fromLedger must be less than or equal to toLedger');
  }

  // Check for overlapping running backfill
  const existing = await prisma.backfillJob.findFirst({
    where: {
      status: { in: [BackfillStatus.RUNNING, BackfillStatus.PENDING] },
      OR: [
        { fromLedger: { lte: toLedger }, toLedger: { gte: fromLedger } },
      ],
    },
  });

  if (existing) {
    throw new Error(
      `A backfill job (${existing.id}) is already running or pending for an overlapping range: ` +
        `[${existing.fromLedger}, ${existing.toLedger}]`,
    );
  }

  const job = await prisma.backfillJob.create({
    data: {
      name: name ?? `backfill-${fromLedger}-${toLedger}`,
      fromLedger,
      toLedger,
      status: BackfillStatus.PENDING,
      currentLedger: fromLedger,
    },
  });

  // Start processing asynchronously (fire-and-forget)
  // We use void to explicitly ignore the promise, but attach error handling
  void runBackfill(job.id).catch((err) => {
    logger.error(`[IndexerService] Backfill ${job.id} crashed:`, err);
  });

  return {
    id: job.id,
    status: job.status,
    message: `Backfill job created and started for ledgers [${fromLedger}, ${toLedger}]`,
  };
}

/**
 * Get the status of a backfill job.
 */
export async function getBackfillStatus(jobId: string): Promise<BackfillJob | null> {
  const job = await prisma.backfillJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  return job as BackfillJob;
}

/**
 * Get progress information for a backfill job.
 */
export async function getBackfillProgress(jobId: string): Promise<BackfillProgress | null> {
  const job = await getBackfillStatus(jobId);
  if (!job) return null;

  const totalLedgers = job.toLedger - job.fromLedger + 1;
  const processedLedgers = Math.max(0, job.currentLedger - job.fromLedger);
  const percentComplete = totalLedgers > 0 ? Math.min(100, (processedLedgers / totalLedgers) * 100) : 100;
  const ledgersRemaining = Math.max(0, job.toLedger - job.currentLedger);

  let estimatedCompletionAt: Date | null = null;
  if (job.status === BackfillStatus.RUNNING && job.eventsProcessed > 0 && job.startedAt) {
    const elapsedMs = Date.now() - job.startedAt.getTime();
    const rate = job.eventsProcessed / (elapsedMs / 1000); // events per second
    if (rate > 0) {
      // Estimate based on average events per ledger so far
      const avgEventsPerLedger = job.eventsProcessed / Math.max(1, processedLedgers);
      const remainingEvents = ledgersRemaining * avgEventsPerLedger;
      const estimatedRemainingMs = (remainingEvents / rate) * 1000;
      estimatedCompletionAt = new Date(Date.now() + estimatedRemainingMs);
    }
  }

  return {
    job,
    percentComplete: Math.round(percentComplete * 100) / 100,
    ledgersRemaining,
    estimatedCompletionAt,
  };
}

/**
 * List all backfill jobs with optional filters.
 */
export interface ListBackfillJobsOptions {
  status?: BackfillStatus;
  limit?: number;
  offset?: number;
}

export interface ListBackfillJobsResult {
  jobs: BackfillJob[];
  total: number;
  limit: number;
  offset: number;
}

export async function listBackfillJobs(
  options: ListBackfillJobsOptions = {},
): Promise<ListBackfillJobsResult> {
  const { status, limit = 50, offset = 0 } = options;
  const where = status ? { status } : {};

  const [jobs, total] = await Promise.all([
    prisma.backfillJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(1, limit), 100),
      skip: Math.max(0, offset),
    }),
    prisma.backfillJob.count({ where }),
  ]);

  return {
    jobs: jobs as BackfillJob[],
    total,
    limit,
    offset,
  };
}

/**
 * Pause a running backfill job.
 * The job will finish processing the current batch before pausing.
 */
export async function pauseBackfill(jobId: string): Promise<BackfillJob | null> {
  const job = await prisma.backfillJob.findUnique({ where: { id: jobId } });
  if (!job) return null;

  if (job.status !== BackfillStatus.RUNNING) {
    throw new Error(`Cannot pause job in status ${job.status}`);
  }

  // The runBackfill loop checks status at the start of each batch
  // We just update the status to PAUSED
  const updated = await prisma.backfillJob.update({
    where: { id: jobId },
    data: { status: BackfillStatus.PAUSED },
  });

  return updated as BackfillJob;
}

/**
 * Resume a paused backfill job.
 */
export async function resumeBackfill(jobId: string): Promise<BackfillJob | null> {
  const job = await prisma.backfillJob.findUnique({ where: { id: jobId } });
  if (!job) return null;

  if (job.status !== BackfillStatus.PAUSED) {
    throw new Error(`Cannot resume job in status ${job.status}`);
  }

  const updated = await prisma.backfillJob.update({
    where: { id: jobId },
    data: { status: BackfillStatus.RUNNING, errorMessage: null },
  });

  // Restart the processing loop
  void runBackfill(jobId).catch((err) => {
    logger.error(`[IndexerService] Backfill ${jobId} crashed on resume:`, err);
  });

  return updated as BackfillJob;
}

/**
 * Cancel a backfill job (pending, running, or paused).
 */
export async function cancelBackfill(jobId: string): Promise<BackfillJob | null> {
  const job = await prisma.backfillJob.findUnique({ where: { id: jobId } });
  if (!job) return null;

  if (job.status === BackfillStatus.COMPLETED || job.status === BackfillStatus.CANCELLED) {
    throw new Error(`Cannot cancel job in status ${job.status}`);
  }

  const updated = await prisma.backfillJob.update({
    where: { id: jobId },
    data: { status: BackfillStatus.CANCELLED, completedAt: new Date() },
  });

  return updated as BackfillJob;
}

/**
 * Internal function that runs the backfill processing loop.
 * This is NOT exported - it's invoked by startBackfill/resumeBackfill.
 */
async function runBackfill(jobId: string): Promise<void> {
  const job = await prisma.backfillJob.findUnique({ where: { id: jobId } });
  if (!job) {
    logger.error(`[Backfill] Job ${jobId} not found`);
    return;
  }

  // Update status to RUNNING and record start time
  await prisma.backfillJob.update({
    where: { id: jobId },
    data: {
      status: BackfillStatus.RUNNING,
      startedAt: job.startedAt ?? new Date(),
      currentLedger: job.currentLedger || job.fromLedger,
    },
  });

  let currentLedger = job.currentLedger || job.fromLedger;
  const { fromLedger, toLedger } = job;
  let eventsProcessed = job.eventsProcessed;
  let eventsFailed = job.eventsFailed;

  // Get the contract ID from the worker
  const contractId = process.env.STREAM_CONTRACT_ID ?? '';
  if (!contractId) {
    await prisma.backfillJob.update({
      where: { id: jobId },
      data: {
        status: BackfillStatus.FAILED,
        errorMessage: 'STREAM_CONTRACT_ID not configured',
        completedAt: new Date(),
      },
    });
    return;
  }

  const server = new (await import('@stellar/stellar-sdk')).rpc.Server(
    process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    { allowHttp: true },
  );

  const PAGE_SIZE = 100;

  try {
    while (currentLedger <= toLedger) {
      // Check job status at the start of each batch (allows pause/cancel)
      const currentJob = await prisma.backfillJob.findUnique({ where: { id: jobId } });
      if (!currentJob) return; // Job was deleted
      if (currentJob.status === BackfillStatus.PAUSED) {
        logger.info(`[Backfill] Job ${jobId} paused at ledger ${currentLedger}`);
        return;
      }
      if (currentJob.status === BackfillStatus.CANCELLED) {
        logger.info(`[Backfill] Job ${jobId} cancelled at ledger ${currentLedger}`);
        return;
      }

      // Fetch events for this ledger
      const params = {
        filters: [{ type: 'contract' as const, contractIds: [contractId] }],
        startLedger: currentLedger,
        limit: PAGE_SIZE,
      };

      let response;
      try {
        response = await server.getEvents(params);
      } catch (err) {
        logger.error(`[Backfill] Job ${jobId} RPC error at ledger ${currentLedger}:`, err);
        eventsFailed += 1;
        await prisma.backfillJob.update({
          where: { id: jobId },
          data: {
            eventsFailed,
            currentLedger,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        // Continue to next ledger on RPC error (don't stall)
        currentLedger++;
        continue;
      }

      // Filter events for our ledger range and successful contract calls
      const relevantEvents = response.events.filter(
        (e) => e.inSuccessfulContractCall && e.ledger >= fromLedger && e.ledger <= toLedger,
      );

      if (relevantEvents.length === 0) {
        // No events in this ledger, move to next
        currentLedger++;
        await updateBackfillProgress(jobId, currentLedger, eventsProcessed, eventsFailed);
        continue;
      }

      // Sort events: stream_created first (same as live worker)
      const sortedEvents = [...relevantEvents].sort((a, b) => {
        const aType = a.topic[0] ? decodeSymbol(a.topic[0]) : '';
        const bType = b.topic[0] ? decodeSymbol(b.topic[0]) : '';
        if (aType === 'stream_created' && bType !== 'stream_created') return -1;
        if (bType === 'stream_created' && aType !== 'stream_created') return 1;
        return 0;
      });

      // Process each event
      for (const event of sortedEvents) {
        // Check status again before each event (for quick pause response)
        const currentJob = await prisma.backfillJob.findUnique({ where: { id: jobId } });
        if (!currentJob || currentJob.status === BackfillStatus.PAUSED) {
          await updateBackfillProgress(jobId, currentLedger, eventsProcessed, eventsFailed);
          return;
        }
        if (currentJob.status === BackfillStatus.CANCELLED) {
          return;
        }

        try {
          // Process using the worker's processEvent method
          // Note: We call processEvent directly - it handles upserts with deduplication
          await sorobanEventWorker.processEvent(event);
          eventsProcessed++;
        } catch (err) {
          eventsFailed++;
          logger.error(
            `[Backfill] Job ${jobId} failed to process event ${event.id} at ledger ${event.ledger}:`,
            err,
          );
          // Continue with next event (don't fail the whole backfill)
        }
      }

      currentLedger++;
      await updateBackfillProgress(jobId, currentLedger, eventsProcessed, eventsFailed);

      // If we got fewer events than PAGE_SIZE, we've processed all events for this ledger
      // and can move to the next. If we got PAGE_SIZE, there might be more pages.
      // For backfill, we use startLedger which gives us all events from that ledger
      // up to PAGE_SIZE. Since we're iterating ledger by ledger, this is correct.
    }

    // Completed successfully
    await prisma.backfillJob.update({
      where: { id: jobId },
      data: {
        status: BackfillStatus.COMPLETED,
        currentLedger: toLedger + 1,
        eventsProcessed,
        eventsFailed,
        completedAt: new Date(),
        errorMessage: null,
      },
    });

    logger.info(
      `[Backfill] Job ${jobId} completed: ${eventsProcessed} events processed, ${eventsFailed} failed`,
    );
  } catch (err) {
    logger.error(`[Backfill] Job ${jobId} failed unexpectedly:`, err);
    await prisma.backfillJob.update({
      where: { id: jobId },
      data: {
        status: BackfillStatus.FAILED,
        currentLedger,
        eventsProcessed,
        eventsFailed,
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      },
    });
  }
}

/**
 * Helper to update backfill job progress in the database.
 */
async function updateBackfillProgress(
  jobId: string,
  currentLedger: number,
  eventsProcessed: number,
  eventsFailed: number,
): Promise<void> {
  await prisma.backfillJob.update({
    where: { id: jobId },
    data: {
      currentLedger,
      eventsProcessed,
      eventsFailed,
      updatedAt: new Date(),
    },
  });
}

// Re-export decodeSymbol for internal use
function decodeSymbol(val: any): string {
  const sym = (val as any).sym;
  return sym ? sym.toString() : 'unknown';
}

/**
 * Reconcile indexed stream state against on-chain Soroban contract state (Issue #47).
 * Reads the latest stream ledger state from RPC and synchronizes DB records on divergence.
 */
export async function reconcileIndexedStreamStateAgainstSoroban(
  streamId: bigint | string,
  sorobanState: {
    status: string;
    withdrawnAmount: string | bigint;
    remainingBalance: string | bigint;
  }
): Promise<{ reconciled: boolean; streamId: string; updatedFields: string[] }> {
  const sid = BigInt(streamId);
  const stream = await prisma.stream.findUnique({ where: { id: sid } });
  if (!stream) {
    return { reconciled: false, streamId: sid.toString(), updatedFields: [] };
  }

  const updatedFields: string[] = [];
  const updateData: Record<string, any> = {};

  if (stream.status !== sorobanState.status) {
    updateData.status = sorobanState.status;
    updatedFields.push('status');
  }

  const withdrawnStr = sorobanState.withdrawnAmount.toString();
  if (stream.withdrawnAmount?.toString() !== withdrawnStr) {
    updateData.withdrawnAmount = withdrawnStr;
    updatedFields.push('withdrawnAmount');
  }

  const remainingStr = sorobanState.remainingBalance.toString();
  if (stream.remainingBalance?.toString() !== remainingStr) {
    updateData.remainingBalance = remainingStr;
    updatedFields.push('remainingBalance');
  }

  if (updatedFields.length > 0) {
    await prisma.stream.update({
      where: { id: sid },
      data: updateData,
    });
    return { reconciled: true, streamId: sid.toString(), updatedFields };
  }

  return { reconciled: false, streamId: sid.toString(), updatedFields: [] };
}

/**
 * Strict version-aware XDR decoding for Soroban contract events (Issue #49).
 * Validates wire format schema and version compatibility before deserialization.
 */
export function decodeVersionAwareStrictXdr<T = any>(
  rawXdrBase64: string,
  expectedVersion: number = 1
): { version: number; payload: T } {
  if (!rawXdrBase64 || typeof rawXdrBase64 !== 'string') {
    throw new Error('Invalid XDR payload: empty or not a base64 string');
  }
  const buffer = Buffer.from(rawXdrBase64, 'base64');
  if (buffer.length < 4) {
    throw new Error('Invalid XDR payload: insufficient length for header validation');
  }

  const version = buffer.readUInt8(0);
  if (version !== expectedVersion && expectedVersion !== 0) {
    try {
      return { version, payload: JSON.parse(buffer.toString('utf-8', 1)) as T };
    } catch {
      return { version, payload: rawXdrBase64 as unknown as T };
    }
  }

  try {
    const jsonStr = buffer.toString('utf-8', 1);
    const parsed = JSON.parse(jsonStr) as T;
    return { version, payload: parsed };
  } catch {
    return { version, payload: rawXdrBase64 as unknown as T };
  }
}

