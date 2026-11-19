import type { Response } from 'express';

/**
 * Standard API error envelope used across the backend.
 *
 * Existing error helpers rely on this shape, so it must remain stable.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Stable error code emitted when a client attempts to mutate a stream using a
 * stale state version (i.e. the stream changed between review and execution).
 */
export const STREAM_VERSION_CONFLICT_CODE = 'STREAM_VERSION_CONFLICT' as const;

export type StreamVersionConflictCode = typeof STREAM_VERSION_CONFLICT_CODE;

/**
 * Minimal, stable snapshot of the current stream state returned alongside a
 * version conflict so clients can reconcile and retry.
 */
export interface StreamConflictState {
  id: string;
  version: number;
  updatedAt: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Stable conflict error payload for stale stream mutations.
 *
 * Clients should treat `code === 'STREAM_VERSION_CONFLICT'` as a signal to
 * refresh their view of the stream (using `currentVersion`/`updatedAt` and the
 * embedded `stream` state) before retrying the mutation.
 */
export interface StreamConflictError extends ApiErrorBody {
  error: {
    code: StreamVersionConflictCode;
    message: string;
    details: {
      currentVersion: number;
      updatedAt: string;
      stream: StreamConflictState;
    };
  };
}

/**
 * Build the stable conflict error payload for a given stream.
 */
export function buildStreamConflictError(stream: StreamConflictState): StreamConflictError {
  return {
    error: {
      code: STREAM_VERSION_CONFLICT_CODE,
      message: 'Stream has been modified since the provided version; refresh and retry.',
      details: {
        currentVersion: stream.version,
        updatedAt: stream.updatedAt,
        stream,
      },
    },
  };
}

/**
 * Emit a 409 Conflict with the standard error envelope for a stale stream
 * mutation. Returns the response for convenience.
 */
export function sendStreamConflict(res: Response, stream: StreamConflictState): Response {
  return res.status(409).json(buildStreamConflictError(stream));
}