/**
 * Typed application error carrying an HTTP status and optional machine-readable
 * remediation hints.
 *
 * `errorHandler` reads `err.status`, so throwing an `ApiError` from anywhere in
 * a handler chain produces the right status code without a try/catch at every
 * call site. The optional `code` lets clients branch on the failure class rather
 * than string-matching a message.
 *
 * Codes are drawn from the stable, versioned registry in `error-codes.ts`.
 * The constructor signature is preserved for backward compatibility: callers
 * that pass an arbitrary string still work, but new code should use the
 * convenience factories below so that emitted codes stay within the registry.
 */

import { ErrorCode, type ErrorCodeValue } from './error-codes.js';

/**
 * Normalize arbitrary detail values into a plain, JSON-safe object.
 *
 * - `undefined` / `null` are dropped.
 * - `Error` instances are reduced to their `name` (never their `message`,
 *   which may contain internal exception text).
 * - Functions and symbols are dropped.
 * - `bigint` is stringified.
 * - Cycles are broken with a placeholder.
 */
function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return undefined;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'function' || t === 'symbol') return undefined;

  if (value instanceof Error) {
    // Never leak internal exception text; expose only the error class name.
    return { name: value.name };
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = value
      .map((item) => toJsonSafe(item, seen))
      .filter((item) => item !== undefined);
    seen.delete(value);
    return out;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const normalized = toJsonSafe(obj[key], seen);
      if (normalized !== undefined) out[key] = normalized;
    }
    seen.delete(obj);
    return out;
  }

  return undefined;
}

/**
 * Normalize a details bag into a plain JSON-safe object, or `undefined` when
 * nothing usable remains.
 */
function normalizeDetails(
  details?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (details === undefined || details === null) return undefined;
  const normalized = toJsonSafe(details);
  if (
    normalized === undefined ||
    normalized === null ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  ) {
    return undefined;
  }
  const keys = Object.keys(normalized as Record<string, unknown>);
  if (keys.length === 0) return undefined;
  return normalized as Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code: string = ErrorCode.INTERNAL,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    const normalized = normalizeDetails(details);
    if (normalized !== undefined) this.details = normalized;
  }
}

export const badRequest = (
  message: string,
  code: string = ErrorCode.VALIDATION_FAILED,
  details?: Record<string, unknown>,
) => new ApiError(400, message, code, details);

export const unauthorized = (
  message = 'Authentication required.',
  code: string = ErrorCode.UNAUTHORIZED,
  details?: Record<string, unknown>,
) => new ApiError(401, message, code, details);

export const forbidden = (
  message = 'You do not have permission to perform this action.',
  code: string = ErrorCode.FORBIDDEN,
  details?: Record<string, unknown>,
) => new ApiError(403, message, code, details);

export const notFound = (
  message = 'The requested resource was not found.',
  code: string = ErrorCode.NOT_FOUND,
  details?: Record<string, unknown>,
) => new ApiError(404, message, code, details);

export const conflict = (
  message = 'The request conflicts with the current state of the resource.',
  code: string = ErrorCode.CONFLICT,
  details?: Record<string, unknown>,
) => new ApiError(409, message, code, details);

export const rateLimited = (
  message = 'Too many requests. Please try again later.',
  code: string = ErrorCode.RATE_LIMITED,
  details?: Record<string, unknown>,
) => new ApiError(429, message, code, details);

export const internal = (
  message = 'An unexpected error occurred.',
  code: string = ErrorCode.INTERNAL,
  details?: Record<string, unknown>,
) => new ApiError(500, message, code, details);

export type { ErrorCodeValue };