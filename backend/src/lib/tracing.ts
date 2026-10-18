import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

/**
 * Thin wrapper over the OpenTelemetry API.
 *
 * The SDK is initialised in `tracing.ts` (imported for its side effects from
 * `index.ts` before anything else) and the Node auto-instrumentations register
 * the express/http/pg spans automatically. This module adds:
 *  - stable span names for domain operations (indexer batches, RPC calls, webhooks),
 *  - W3C trace context propagation across HTTP, SSE, and asynchronous workers,
 *  - low-cardinality sanitization to prevent sensitive data/PII leaks, and
 *  - a no-op span fallback so importing instrumentation from unit tests — or
 *    running with `OTEL_SDK_DISABLED=true` — never throws and never records.
 */

const TRACER_NAME = 'flowfi-backend';

/**
 * Sensitive key patterns that must never be recorded into trace span attributes.
 */
const SENSITIVE_ATTRIBUTE_PATTERNS = [
  /auth/i,
  /token/i,
  /secret/i,
  /password/i,
  /private/i,
  /key/i,
  /signature/i,
  /cookie/i,
];

/** Maximum string length for trace attributes to avoid unbounded high cardinality */
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;

/**
 * Filters and sanitizes attribute maps, stripping sensitive credentials and truncating
 * high-cardinality payload values.
 */
export function sanitizeTraceAttributes(
  attributes: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;

    // Redact sensitive keys
    if (SENSITIVE_ATTRIBUTE_PATTERNS.some((pattern) => pattern.test(key))) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    if (typeof value === 'boolean' || typeof value === 'number') {
      sanitized[key] = value;
      continue;
    }

    if (typeof value === 'string') {
      sanitized[key] =
        value.length > MAX_ATTRIBUTE_VALUE_LENGTH
          ? `${value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH)}...[TRUNCATED]`
          : value;
      continue;
    }

    // Exclude raw objects and arrays to prevent high-cardinality explosions
    sanitized[key] = '[COMPLEX_OBJECT]';
  }

  return sanitized;
}

/**
 * Injects the active trace context into an outbound carrier object (e.g. HTTP headers or webhook headers).
 */
export function injectTraceContext(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

/**
 * Extracts trace context from an inbound carrier (e.g. incoming HTTP headers or message metadata).
 */
export function extractTraceContext(carrier: Record<string, string>): Context {
  return propagation.extract(context.active(), carrier);
}

/**
 * Resolve the tracer on every call rather than caching one at module load.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Stand-in span used when the API has no recording provider installed. */
const NOOP_SPAN = {
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  recordException: () => undefined,
  updateName: () => NOOP_SPAN,
  end: () => undefined,
  isRecording: () => false,
  spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
  addLink: () => NOOP_SPAN,
  addLinks: () => NOOP_SPAN,
} as unknown as Span;

/**
 * Run `fn` inside an active span with automatic attribute sanitization.
 */
export async function withSpan<T>(
  name: string,
  rawAttributes: Record<string, unknown>,
  fn: (span: Span) => Promise<T>,
  parentContext?: Context,
): Promise<T> {
  const attributes = sanitizeTraceAttributes(rawAttributes);
  const activeCtx = parentContext ?? context.active();

  let span: Span;
  let spanContext: Context;
  try {
    span = getTracer().startSpan(name, { attributes }, activeCtx);
    spanContext = trace.setSpan(activeCtx, span);
  } catch {
    // Could not even start a span: run untraced rather than fail the request.
    return fn(NOOP_SPAN);
  }

  let fnRan = false;
  try {
    return await context.with(spanContext, async () => {
      fnRan = true;
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  } catch (err) {
    if (fnRan) {
      throw err;
    }
    span.end();
    return fn(NOOP_SPAN);
  }
}

/** Record an exception on the currently-active span, if there is one. */
export function recordSpanError(err: unknown, rawAttributes?: Record<string, unknown>): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.recordException(err as Error);
  span.setStatus({ code: SpanStatusCode.ERROR });
  if (rawAttributes) {
    span.setAttributes(sanitizeTraceAttributes(rawAttributes));
  }
}

