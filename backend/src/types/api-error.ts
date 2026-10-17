import type { Response } from "express";

/**
 * Versioned, stable machine-readable error codes.
 *
 * This is the single source of truth for error codes returned by the REST API.
 * Codes are part of the public contract and MUST NOT change meaning once
 * released. New codes may be added; existing codes must be preserved.
 *
 * The `ERROR_ENVELOPE_VERSION` tag is bumped only for breaking changes to the
 * envelope shape (not for adding new codes).
 */
export const ERROR_ENVELOPE_VERSION = "1" as const;

export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  CONFLICT: "CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  BAD_REQUEST: "BAD_REQUEST",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Safe, client-facing default messages per code. These are intentionally
 * generic so that internal exception text is never surfaced to clients.
 */
const SAFE_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  [ErrorCode.VALIDATION_FAILED]: "The request failed validation.",
  [ErrorCode.UNAUTHENTICATED]: "Authentication is required.",
  [ErrorCode.FORBIDDEN]: "You do not have permission to perform this action.",
  [ErrorCode.NOT_FOUND]: "The requested resource was not found.",
  [ErrorCode.METHOD_NOT_ALLOWED]: "The HTTP method is not allowed for this resource.",
  [ErrorCode.CONFLICT]: "The request conflicts with the current state of the resource.",
  [ErrorCode.IDEMPOTENCY_CONFLICT]:
    "The idempotency key was reused with a different request payload.",
  [ErrorCode.RATE_LIMITED]: "Too many requests. Please try again later.",
  [ErrorCode.PAYLOAD_TOO_LARGE]: "The request payload is too large.",
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: "The request media type is not supported.",
  [ErrorCode.BAD_REQUEST]: "The request could not be processed.",
  [ErrorCode.SERVICE_UNAVAILABLE]: "The service is temporarily unavailable.",
  [ErrorCode.INTERNAL_ERROR]: "An unexpected error occurred.",
});

/**
 * Returns the safe, client-facing message for a given error code. Falls back
 * to the generic INTERNAL_ERROR message for unknown codes so that internal
 * exception text is never surfaced.
 */
export function safeMessageFor(code: ErrorCode | string): string {
  if (typeof code === "string" && code in SAFE_MESSAGES) {
    return SAFE_MESSAGES[code as ErrorCode];
  }
  return SAFE_MESSAGES[ErrorCode.INTERNAL_ERROR];
}

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
  version: string;
}

export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

export interface BuildErrorEnvelopeInput {
  code: ErrorCode | string;
  message?: string;
  requestId?: string;
  details?: unknown;
}

/**
 * Builds the canonical error envelope:
 *   { error: { code, message, requestId, details?, version } }
 *
 * If `message` is omitted, the safe default message for the code is used.
 */
export function buildErrorEnvelope(input: BuildErrorEnvelopeInput): ApiErrorEnvelope {
  const { code, requestId, details } = input;
  const message =
    typeof input.message === "string" && input.message.length > 0
      ? input.message
      : safeMessageFor(code);

  const error: ApiErrorBody = {
    code,
    message,
    version: ERROR_ENVELOPE_VERSION,
  };
  if (requestId !== undefined) error.requestId = requestId;
  if (details !== undefined) error.details = details;

  return { error };
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Maps an unknown thrown value to a safe INTERNAL_ERROR ApiError. The original
 * error is never attached to the returned value so that internal exception
 * text cannot leak to clients.
 */
export function redactInternalError(_err: unknown): ApiError {
  return new ApiError(
    500,
    ErrorCode.INTERNAL_ERROR,
    safeMessageFor(ErrorCode.INTERNAL_ERROR),
  );
}

export function sendApiError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) {
  const requestId =
    typeof res.locals?.requestId === "string" ? res.locals.requestId : undefined;
  const envelope = buildErrorEnvelope({ code, message, requestId, details });
  return res.status(statusCode).json(envelope);
}