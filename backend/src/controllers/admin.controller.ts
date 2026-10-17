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
 * POST /api/v1/admin/indexer/dead-letter/:id/replay
 *
 * Re-injects the quarantined payload through the indexer pipeline. On success
 * the row is removed and the Stream / StreamEvent records are created by the
 * worker; on failure the attempt counter and error message are updated.
 */
export const replayDeadLetterHandler = async (req: Request, res: Response) => {
  const id = requireParamId(req);

  const result = await replayDeadLetterEvent(id);

  if (result.outcome === 'not_found') {
    throw new ApiError(404, 'Dead-letter event not found', 'not_found');
  }

  if (result.outcome === 'undecodable') {
    throw new ApiError(
      422,
      'Dead-letter payload could not be decoded',
      'undecodable_payload',
    );
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
  const summary = await replayAllDeadLetterEvents();
  return res.status(200).json({ ok: true, ...summary });
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
