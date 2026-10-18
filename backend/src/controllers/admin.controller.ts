import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import {
  DeadLetterNotFoundError,
  DEFAULT_DEAD_LETTER_PAGE_SIZE,
  MAX_DEAD_LETTER_PAGE_SIZE,
  discardDeadLetterEvent,
  listDeadLetterEvents,
  previewDeadLetterReplay,
  replayAllDeadLetterEvents,
  replayDeadLetterEvent,
} from '../services/indexerService.js';
import { ApiError } from '../errors/ApiError.js';
import logger from '../logger.js';

/**
 * Validated query shape for the dead-letter listing endpoint. Values are
 * produced by the route-level Zod schema; this helper only normalizes the
 * already-validated input into the service contract.
 */
export interface DeadLetterListQuery {
  page?: number;
  limit?: number;
  ledgerSequence?: number;
  startDate?: Date;
  endDate?: Date;
  eventType?: string;
}

function requireParamId(req: Request): string {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    throw new ApiError(400, 'id is required', 'invalid_path_param');
  }
  return id;
}

/**
 * GET /api/v1/admin/indexer/dead-letter
 *
 * Paginated, filterable view of quarantined indexer events, including the raw
 * payload and the full error history needed to diagnose them.
 */
export const listDeadLetterHandler = async (req: Request, res: Response) => {
  const query = (req.validated?.query ?? {}) as DeadLetterListQuery;

  const page = query.page ?? 1;
  const limit = Math.min(
    query.limit ?? DEFAULT_DEAD_LETTER_PAGE_SIZE,
    MAX_DEAD_LETTER_PAGE_SIZE,
  );

  if (query.startDate && query.endDate && query.startDate > query.endDate) {
    throw new ApiError(400, 'startDate must be before endDate', 'invalid_query');
  }

  const result = await listDeadLetterEvents({
    page,
    limit,
    ...(query.ledgerSequence !== undefined
      ? { ledgerSequence: query.ledgerSequence }
      : {}),
    ...(query.startDate ? { startDate: query.startDate } : {}),
    ...(query.endDate ? { endDate: query.endDate } : {}),
    ...(query.eventType ? { eventType: query.eventType } : {}),
  });

  return res.status(200).json(result);
};

/**
 * GET /api/v1/admin/indexer/dead-letter/:id/replay/preview
 *
 * Read-only preview of a single-record replay. Performs no writes: it reports
 * the affected ledger range and the record changes the replay would produce so
 * an operator can audit the mutation before triggering it.
 */
export const previewDeadLetterReplayHandler = async (
  req: Request,
  res: Response,
) => {
  const rawId = req.params.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const preview = await previewDeadLetterReplay(id);

    if (preview.outcome === 'not_found') {
      return res.status(404).json({ error: 'Dead-letter event not found' });
    }

    if (preview.outcome === 'undecodable') {
      return res.status(422).json({
        error: 'Dead-letter payload could not be decoded',
        code: 'undecodable_payload',
        id,
        errorMessage: preview.errorMessage,
        preview,
      });
    }

    return res.status(200).json({ ok: true, id, preview });
  } catch (err) {
    logger.error(
      `[AdminController] Preview of dead-letter ${id} threw:`,
      err,
    );
    return res.status(500).json({ error: 'Preview failed' });
  }
};

/**
 * POST /api/v1/admin/indexer/dead-letter/:id/replay
 *
 * Re-injects the quarantined payload through the indexer pipeline. On success
 * the row is removed and the Stream / StreamEvent records are created by the
 * worker; on failure the attempt counter and error message are updated.
 *
 * The response always carries a structured execution report (requestId,
 * duration, counts, failure position) so the outcome is auditable. The live
 * indexer cursor is preserved when a replay fails.
 */
export const replayDeadLetterHandler = async (req: Request, res: Response) => {
  const id = requireParamId(req);

  const result = await replayDeadLetterEvent(id);

  if (result.outcome === 'not_found') {
    throw new ApiError(404, 'Dead-letter event not found', 'not_found');
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
        report: result.report,
      });
    }

    if (result.outcome === 'failed') {
      return res.status(422).json({
        error: 'Replay failed; the event remains quarantined',
        code: 'replay_failed',
        id,
        attempts: result.attempts,
        errorMessage: result.errorMessage,
        report: result.report,
      });
    }

    return res.status(200).json({
      ok: true,
      id,
      outcome: result.outcome,
      attempts: result.attempts,
      report: result.report,
    });
  } catch (err) {
    logger.error(`[AdminController] Replay of dead-letter ${id} threw:`, err);
    return res.status(500).json({ error: 'Replay failed' });
  }

  if (result.outcome === 'failed') {
    throw new ApiError(
      422,
      'Replay failed; the event remains quarantined',
      'replay_failed',
    );
  }

  return res.status(200).json({
    ok: true,
    id,
    outcome: result.outcome,
    attempts: result.attempts,
  });
};

/**
 * POST /api/v1/admin/indexer/dead-letter/replay-all
 *
 * Replays every pending record sequentially, oldest ledger first.
 */
export const replayAllDeadLetterHandler = async (_req: Request, res: Response) => {
  try {
    const summary = await replayAllDeadLetterEvents();
    // A partial batch is reported with 207 so callers can distinguish a
    // reproducible partial success from a clean run without breaking the
    // existing 200 shape for full success.
    const status = summary.failed > 0 ? 207 : 200;
    return res.status(status).json({ ok: true, ...summary });
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
  const id = requireParamId(req);

  const discardedBy = (req as AuthenticatedRequest).user?.publicKey ?? 'unknown';

  try {
    const discarded = await discardDeadLetterEvent(id, discardedBy);
    return res.status(200).json({ ok: true, discarded });
  } catch (err) {
    if (err instanceof DeadLetterNotFoundError) {
      throw new ApiError(404, 'Dead-letter event not found', 'not_found');
    }
    throw err;
  }
};
