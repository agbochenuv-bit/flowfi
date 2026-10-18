import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import {
  DeadLetterNotFoundError,
  DEFAULT_DEAD_LETTER_PAGE_SIZE,
  MAX_DEAD_LETTER_PAGE_SIZE,
  discardDeadLetterEvent,
  listDeadLetterEvents,
  replayAllDeadLetterEvents,
  replayDeadLetterEvent,
  startBackfill,
  getBackfillStatus,
  getBackfillProgress,
  listBackfillJobs,
  pauseBackfill,
  resumeBackfill,
  cancelBackfill,
  BackfillStatus,
} from '../services/indexerService.js';
import logger from '../logger.js';

/** Parse an optional positive-integer query param. */
function parseOptionalInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Parse an optional ISO-8601 date query param, rejecting unparseable values. */
function parseOptionalDate(
  raw: unknown,
  field: string,
): { value?: Date; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {};
  const value = new Date(String(raw));
  if (Number.isNaN(value.getTime())) {
    return { error: `${field} must be a valid ISO-8601 date` };
  }
  return { value };
}

function readSingleQueryParam(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * GET /api/v1/admin/indexer/dead-letter
 *
 * Paginated, filterable view of quarantined indexer events, including the raw
 * payload and the full error history needed to diagnose them.
 */
export const listDeadLetterHandler = async (req: Request, res: Response) => {
  const page = parseOptionalInt(readSingleQueryParam(req.query.page)) ?? 1;
  const rawLimit = parseOptionalInt(readSingleQueryParam(req.query.limit));
  const ledgerSequence = parseOptionalInt(
    readSingleQueryParam(req.query.ledgerSequence),
  );

  const startDate = parseOptionalDate(
    readSingleQueryParam(req.query.startDate),
    'startDate',
  );
  if (startDate.error) {
    return res.status(400).json({ error: startDate.error });
  }

  const endDate = parseOptionalDate(
    readSingleQueryParam(req.query.endDate),
    'endDate',
  );
  if (endDate.error) {
    return res.status(400).json({ error: endDate.error });
  }

  if (startDate.value && endDate.value && startDate.value > endDate.value) {
    return res.status(400).json({ error: 'startDate must be before endDate' });
  }

  try {
    const eventType = readSingleQueryParam(req.query.eventType);

    const result = await listDeadLetterEvents({
      page,
      limit: Math.min(
        rawLimit ?? DEFAULT_DEAD_LETTER_PAGE_SIZE,
        MAX_DEAD_LETTER_PAGE_SIZE,
      ),
      ...(ledgerSequence !== undefined ? { ledgerSequence } : {}),
      ...(startDate.value ? { startDate: startDate.value } : {}),
      ...(endDate.value ? { endDate: endDate.value } : {}),
      ...(eventType ? { eventType } : {}),
    });

    return res.status(200).json(result);
  } catch (err) {
    logger.error('[AdminController] Failed to list dead-letter events:', err);
    return res.status(500).json({ error: 'Failed to list dead-letter events' });
  }
};

/**
 * POST /api/v1/admin/indexer/dead-letter/:id/replay
 *
 * Re-injects the quarantined payload through the indexer pipeline. On success
 * the row is removed and the Stream / StreamEvent records are created by the
 * worker; on failure the attempt counter and error message are updated.
 */
export const replayDeadLetterHandler = async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const result = await replayDeadLetterEvent(id);

    if (result.outcome === 'not_found') {
      return res.status(404).json({ error: 'Dead-letter event not found' });
    }

    if (result.outcome === 'undecodable') {
      return res.status(422).json({
        error: 'Dead-letter payload could not be decoded',
        code: 'undecodable_payload',
        id,
        errorMessage: result.errorMessage,
      });
    }

    if (result.outcome === 'failed') {
      return res.status(422).json({
        error: 'Replay failed; the event remains quarantined',
        code: 'replay_failed',
        id,
        attempts: result.attempts,
        errorMessage: result.errorMessage,
      });
    }

    return res.status(200).json({
      ok: true,
      id,
      outcome: result.outcome,
      attempts: result.attempts,
    });
  } catch (err) {
    logger.error(`[AdminController] Replay of dead-letter ${id} threw:`, err);
    return res.status(500).json({ error: 'Replay failed' });
  }
};

/**
 * POST /api/v1/admin/indexer/dead-letter/replay-all
 *
 * Replays every pending record sequentially, oldest ledger first.
 */
export const replayAllDeadLetterHandler = async (_req: Request, res: Response) => {
  try {
    const summary = await replayAllDeadLetterEvents();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    logger.error('[AdminController] Dead-letter replay-all threw:', err);
    return res.status(500).json({ error: 'Replay-all failed' });
  }
};

/**
 * DELETE /api/v1/admin/indexer/dead-letter/:id
 *
 * Permanently discards an unrecoverable record. The discard is written to the
 * application log with the acting admin so the loss stays auditable.
 */
export const discardDeadLetterHandler = async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  const discardedBy = (req as AuthenticatedRequest).user?.publicKey ?? 'unknown';

  try {
    const discarded = await discardDeadLetterEvent(id, discardedBy);
    return res.status(200).json({ ok: true, discarded });
  } catch (err) {
    if (err instanceof DeadLetterNotFoundError) {
      return res.status(404).json({ error: 'Dead-letter event not found' });
    }
    logger.error(`[AdminController] Discard of dead-letter ${id} threw:`, err);
    return res.status(500).json({ error: 'Discard failed' });
  }
};

/**
 * POST /api/v1/admin/indexer/backfill
 *
 * Start a new bounded historical backfill job.
 */
export const startBackfillHandler = async (req: Request, res: Response) => {
  const fromLedger = parseOptionalInt(req.body?.fromLedger);
  const toLedger = parseOptionalInt(req.body?.toLedger);
  const name = readSingleQueryParam(req.body?.name);

  if (fromLedger === undefined || toLedger === undefined) {
    return res.status(400).json({ error: 'fromLedger and toLedger are required non-negative integers' });
  }

  if (fromLedger > toLedger) {
    return res.status(400).json({ error: 'fromLedger must be less than or equal to toLedger' });
  }

  try {
    const result = await startBackfill({ fromLedger, toLedger, name });
    return res.status(202).json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already running')) {
      return res.status(409).json({ error: message });
    }
    logger.error('[AdminController] Start backfill threw:', err);
    return res.status(500).json({ error: 'Failed to start backfill' });
  }
};

/**
 * GET /api/v1/admin/indexer/backfill
 *
 * List backfill jobs with optional filtering.
 */
export const listBackfillJobsHandler = async (req: Request, res: Response) => {
  const statusRaw = readSingleQueryParam(req.query.status);
  const status = statusRaw && Object.values(BackfillStatus).includes(statusRaw as BackfillStatus)
    ? (statusRaw as BackfillStatus)
    : undefined;
  const limit = parseOptionalInt(readSingleQueryParam(req.query.limit)) ?? 50;
  const offset = parseOptionalInt(readSingleQueryParam(req.query.offset)) ?? 0;

  try {
    const result = await listBackfillJobs({ status, limit, offset });
    return res.status(200).json(result);
  } catch (err) {
    logger.error('[AdminController] List backfill jobs threw:', err);
    return res.status(500).json({ error: 'Failed to list backfill jobs' });
  }
};

/**
 * GET /api/v1/admin/indexer/backfill/:id
 *
 * Get backfill job status and progress metadata.
 */
export const getBackfillStatusHandler = async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const progress = await getBackfillProgress(id);
    if (!progress) {
      return res.status(404).json({ error: 'Backfill job not found' });
    }
    return res.status(200).json(progress);
  } catch (err) {
    logger.error(`[AdminController] Get backfill status ${id} threw:`, err);
    return res.status(500).json({ error: 'Failed to get backfill status' });
  }
};

/**
 * POST /api/v1/admin/indexer/backfill/:id/pause
 *
 * Pause a running backfill job.
 */
export const pauseBackfillHandler = async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const job = await pauseBackfill(id);
    if (!job) {
      return res.status(404).json({ error: 'Backfill job not found' });
    }
    return res.status(200).json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Cannot pause')) {
      return res.status(400).json({ error: message });
    }
    logger.error(`[AdminController] Pause backfill ${id} threw:`, err);
    return res.status(500).json({ error: 'Failed to pause backfill' });
  }
};

/**
 * POST /api/v1/admin/indexer/backfill/:id/resume
 *
 * Resume a paused backfill job.
 */
export const resumeBackfillHandler = async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const job = await resumeBackfill(id);
    if (!job) {
      return res.status(404).json({ error: 'Backfill job not found' });
    }
    return res.status(200).json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Cannot resume')) {
      return res.status(400).json({ error: message });
    }
    logger.error(`[AdminController] Resume backfill ${id} threw:`, err);
    return res.status(500).json({ error: 'Failed to resume backfill' });
  }
};

/**
 * POST /api/v1/admin/indexer/backfill/:id/cancel
 *
 * Cancel a backfill job.
 */
export const cancelBackfillHandler = async (req: Request, res: Response) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const job = await cancelBackfill(id);
    if (!job) {
      return res.status(404).json({ error: 'Backfill job not found' });
    }
    return res.status(200).json({ ok: true, job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Cannot cancel')) {
      return res.status(400).json({ error: message });
    }
    logger.error(`[AdminController] Cancel backfill ${id} threw:`, err);
    return res.status(500).json({ error: 'Failed to cancel backfill' });
  }
};
