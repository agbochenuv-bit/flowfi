import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { trace } from '@opentelemetry/api';
import logger, { requestContext } from '../logger.js';
import { injectTraceContext } from '../lib/tracing.js';

const MAX_REQUEST_ID_LENGTH = 128;

// Only alphanumeric characters and hyphens are allowed. This prevents log
// injection via newlines or other control characters in a client-supplied
// X-Request-ID header, since the value is echoed back in responses and
// written into every log line for the request.
const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

function isValidRequestId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID_PATTERN.test(value);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-request-id'];
  const requestId = typeof header === 'string' && isValidRequestId(header) ? header : randomUUID();

  res.setHeader('X-Request-ID', requestId);

  // Extract or link active trace context
  const activeSpan = trace.getActiveSpan();
  const traceId = activeSpan?.spanContext().traceId;
  if (traceId && traceId !== '0'.repeat(32)) {
    res.setHeader('X-Trace-ID', traceId);
  }

  const outboundHeaders: Record<string, string> = {};
  injectTraceContext(outboundHeaders);
  if (outboundHeaders.traceparent) {
    res.setHeader('traceparent', outboundHeaders.traceparent);
  }

  const startMs = Date.now();

  res.on('finish', () => {
    logger.info('response sent', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
      requestId,
      ...(traceId && traceId !== '0'.repeat(32) ? { traceId } : {}),
    });
  });

  requestContext.run({ requestId, ...(traceId ? { traceId } : {}) }, () => {
    logger.info('request received', {
      method: req.method,
      path: req.path,
      requestId,
      ...(traceId && traceId !== '0'.repeat(32) ? { traceId } : {}),
    });
    next();
  });
}

