/**
 * API error helpers.
 *
 * Every helper returns a plain object that matches the shared API error
 * envelope so middleware and controllers can construct structured errors
 * without duplicating the envelope shape.
 */

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface ApiErrorOptions {
  details?: Record<string, unknown>;
  message?: string;
}

/**
 * Generic structured API error.
 */
export function apiError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorEnvelope {
  const envelope: ApiErrorEnvelope = {
    error: {
      code,
      message,
    },
  };

  if (details !== undefined) {
    envelope.error.details = details;
  }

  return envelope;
}

/**
 * 400 - malformed or invalid request payload.
 */
export function badRequestError(
  message = 'Bad request',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError('BAD_REQUEST', options.message ?? message, options.details);
}

/**
 * 401 - missing or invalid authentication.
 */
export function unauthorizedError(
  message = 'Unauthorized',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError('UNAUTHORIZED', options.message ?? message, options.details);
}

/**
 * 403 - authenticated but not permitted.
 */
export function forbiddenError(
  message = 'Forbidden',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError('FORBIDDEN', options.message ?? message, options.details);
}

/**
 * 404 - resource not found.
 */
export function notFoundError(
  message = 'Not found',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError('NOT_FOUND', options.message ?? message, options.details);
}

/**
 * 409 - request conflicts with current resource state.
 */
export function conflictError(
  message = 'Conflict',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError('CONFLICT', options.message ?? message, options.details);
}

/**
 * 422 - request is well-formed but semantically invalid.
 */
export function unprocessableEntityError(
  message = 'Unprocessable entity',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError(
    'UNPROCESSABLE_ENTITY',
    options.message ?? message,
    options.details,
  );
}

/**
 * 429 - request count rate limit exceeded.
 */
export function rateLimitExceededError(
  retryAfterMs?: number,
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  const details: Record<string, unknown> = { ...(options.details ?? {}) };
  if (retryAfterMs !== undefined) {
    details.retryAfterMs = retryAfterMs;
  }

  return apiError(
    'RATE_LIMIT_EXCEEDED',
    options.message ?? 'Rate limit exceeded',
    Object.keys(details).length > 0 ? details : undefined,
  );
}

/**
 * 429 - request cost budget exceeded.
 *
 * Used by expensive read operations (analytics, exports, multi-resource
 * queries) that are governed by a complexity budget rather than a plain
 * request count. The envelope mirrors `rateLimitExceededError` but carries a
 * distinct `COST_BUDGET_EXCEEDED` code plus the cost accounting details so
 * clients can back off intelligently.
 *
 * @param cost        Cost units consumed by the rejected request.
 * @param limit       Maximum cost units allowed in the window.
 * @param windowMs    Length of the budget window in milliseconds.
 * @param retryAfterMs Optional hint for when the client may retry.
 */
export function costBudgetExceededError(
  cost: number,
  limit: number,
  windowMs: number,
  retryAfterMs?: number,
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  const details: Record<string, unknown> = {
    cost,
    limit,
    windowMs,
    ...(options.details ?? {}),
  };

  if (retryAfterMs !== undefined) {
    details.retryAfterMs = retryAfterMs;
  }

  return apiError(
    'COST_BUDGET_EXCEEDED',
    options.message ?? 'Request cost budget exceeded',
    details,
  );
}

/**
 * 500 - unexpected server failure.
 */
export function internalServerError(
  message = 'Internal server error',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError(
    'INTERNAL_SERVER_ERROR',
    options.message ?? message,
    options.details,
  );
}

/**
 * 503 - upstream dependency unavailable.
 */
export function serviceUnavailableError(
  message = 'Service unavailable',
  options: ApiErrorOptions = {},
): ApiErrorEnvelope {
  return apiError(
    'SERVICE_UNAVAILABLE',
    options.message ?? message,
    options.details,
  );
}