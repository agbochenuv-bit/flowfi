import { describe, it, expect } from 'vitest';
import {
  sanitizeTraceAttributes,
  injectTraceContext,
  extractTraceContext,
  withSpan,
} from '../src/lib/tracing.js';

describe('OpenTelemetry Trace Context Propagation & Sanitization', () => {
  it('redacts sensitive credentials and secrets from span attributes', () => {
    const rawAttributes = {
      'http.method': 'POST',
      'stream.id': 'stream-12345',
      'auth.token': 'secret-bearer-jwt-value',
      'user.password': 'super-secret-password',
      'stellar.private_key': 'SDXXXXXXXXXXXXX',
      'webhook.secret': 'whsec_999999',
    };

    const sanitized = sanitizeTraceAttributes(rawAttributes);

    expect(sanitized['http.method']).toBe('POST');
    expect(sanitized['stream.id']).toBe('stream-12345');
    expect(sanitized['auth.token']).toBe('[REDACTED]');
    expect(sanitized['user.password']).toBe('[REDACTED]');
    expect(sanitized['stellar.private_key']).toBe('[REDACTED]');
    expect(sanitized['webhook.secret']).toBe('[REDACTED]');
  });

  it('truncates excessively long attribute strings to prevent high cardinality', () => {
    const longString = 'a'.repeat(500);
    const sanitized = sanitizeTraceAttributes({ payload: longString });

    expect(typeof sanitized.payload).toBe('string');
    expect((sanitized.payload as string).length).toBeLessThan(300);
    expect((sanitized.payload as string).endsWith('...[TRUNCATED]')).toBe(true);
  });

  it('preserves primitive numbers and booleans', () => {
    const sanitized = sanitizeTraceAttributes({
      'batch.size': 25,
      'is.retry': true,
    });

    expect(sanitized['batch.size']).toBe(25);
    expect(sanitized['is.retry']).toBe(true);
  });

  it('injects and extracts trace context across carriers', () => {
    const carrier: Record<string, string> = {};
    injectTraceContext(carrier);
    const extractedContext = extractTraceContext(carrier);
    expect(extractedContext).toBeDefined();
  });

  it('executes operation inside withSpan and returns result safely', async () => {
    const result = await withSpan(
      'test.operation',
      { 'operation.type': 'unit_test' },
      async (span) => {
        expect(span).toBeDefined();
        return 'success';
      }
    );

    expect(result).toBe('success');
  });
});
