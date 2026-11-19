import type { Response } from 'express';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface SendApiErrorOptions {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Sends a normalized API error response.
 *
 * All error responses share the same envelope so clients can rely on
 * `error.code` for programmatic handling and `error.details` for context.
 */
export function sendApiError(res: Response, options: SendApiErrorOptions): void {
  const { status, code, message, details } = options;

  const body: ApiErrorBody = {
    error: {
      code,
      message,
    },
  };

  if (details !== undefined) {
    body.error.details = details;
  }

  res.status(status).json(body);
}

/**
 * Stable error code returned when a mutation is rejected because the
 * client's reviewed stream version no longer matches the current state.
 */
export const STREAM_VERSION_CONFLICT_CODE = 'STREAM_VERSION_CONFLICT';

export interface StreamConflictMetadata {
  streamId: string;
  version: number;
  updatedAt: string | Date;
  isActive: boolean;
  isPaused: boolean;
}

/**
 * Sends a 409 conflict response for stale stream mutations.
 *
 * This is the single source of truth for the `STREAM_VERSION_CONFLICT`
 * contract. Clients should re-read the stream, review the current state,
 * and resubmit with the returned `version` if the mutation is still desired.
 *
 * Wallet-signed transaction semantics are unchanged: the conflict is
 * detected before any signed transaction is executed, so no on-chain
 * side effects occur for a rejected request.
 */
export function sendStreamConflict(
  res: Response,
  metadata: StreamConflictMetadata,
): void {
  const { streamId, version, updatedAt, isActive, isPaused } = metadata;

  sendApiError(res, {
    status: 409,
    code: STREAM_VERSION_CONFLICT_CODE,
    message:
      'Stream has changed since the reviewed version. Re-read the stream and retry with the current version.',
    details: {
      streamId,
      currentVersion: version,
      updatedAt:
        updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
      isActive,
      isPaused,
    },
  });
}