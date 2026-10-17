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
import logger from '../logger.js';
import { ApiError, sendApiError } from '../errors/index.js';

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
    return sendApiError(
      req,
      res,
      new ApiError('VALIDATION_FAILED', startDate.error, {
        details: [{ field: 'startDate', message: startDate.error }],
      }),
    );
  }

  const endDate = parseOptionalDate(
    readSingleQueryParam(req.query.endDate),
    'endDate',
  );
  if (endDate.error) {
    return sendApiError(
      req,
      res,
      new ApiError('VALIDATION_FAILED', endDate.error, {
        details: [{ field: 'endDate', message: endDate.error }],
      }),
    );
  }

  if (startDate.value && endDate.value && startDate.value > endDate.value) {
    return sendApiError(
      req,
      res,
      new ApiError('VALIDATION_FAILED', 'startDate must be before endDate', {
        details: [
          {
            field: 'startDate',
            message: 'startDate must be before endDate',
          },
        ],
      }),
    );
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
    return sendApiError(req, res, new ApiError('INTERNAL_ERROR'));
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
    return sendApiError(
      req,
      res,
      new ApiError('VALIDATION_FAILED', 'id is required', {
        details: [{ field: 'id', message: 'id is required' }],
      }),
    );
  }

  try {
    const result = await replayDeadLetterEvent(id);

    if (result.outcome === 'not_found') {
      return sendApiError(req, res, new ApiError('NOT_FOUND'));
    }

    if (result.outcome === 'undecodable') {
      return sendApiError(
        req,
        res,
        new ApiError('UNPROCESSABLE_ENTITY', undefined, {
          details: [{ field: 'id', message: 'payload could not be decoded' }],
        }),
      );
    }

    if (result.outcome === 'failed') {
      return sendApiError(
        req,
        res,
        new ApiError('UNPROCESSABLE_ENTITY', undefined, {
          details: [
            {
              field: 'id',
              message: 'replay failed; the event remains quarantined',
            },
          ],
        }),
      );
    }

    return res.status(200).json({
      ok: true,
      id,
      outcome: result.outcome,
      attempts: result.attempts,
    });
  } catch (err) {
    logger.error(`[AdminController] Replay of dead-letter ${id} threw:`, err);
    return sendApiError(req, res, new ApiError('INTERNAL_ERROR'));
  }
};

/**
 * POST /api/v1/admin/indexer/dead-letter/replay-all
 *
 * Replays every pending record sequentially, oldest ledger first.
 */
export const replayAllDeadLetterHandler = async (req: Request, res: Response) => {
  try {
    const summary = await replayAllDeadLetterEvents();
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    logger.error('[AdminController] Dead-letter replay-all threw:', err);
    return sendApiError(req, res, new ApiError('INTERNAL_ERROR'));
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
    return sendApiError(
      req,
      res,
      new ApiError('VALIDATION_FAILED', 'id is required', {
        details: [{ field: 'id', message: 'id is required' }],
      }),
    );
  }

  const discardedBy = (req as AuthenticatedRequest).user?.publicKey ?? 'unknown';

  try {
    const discarded = await discardDeadLetterEvent(id, discardedBy);
    return res.status(200).json({ ok: true, discarded });
  } catch (err) {
    if (err instanceof DeadLetterNotFoundError) {
      return sendApiError(req, res, new ApiError('NOT_FOUND'));
    }
    logger.error(`[AdminController] Discard of dead-letter ${id} threw:`, err);
    return sendApiError(req, res, new ApiError('INTERNAL_ERROR'));
  }
};
