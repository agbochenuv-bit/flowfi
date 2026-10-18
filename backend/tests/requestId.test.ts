import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestIdMiddleware } from '../src/middleware/requestId.js';
import type { Request, Response, NextFunction } from 'express';

describe('RequestId Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      headers: {},
      method: 'GET',
      path: '/test',
    };
    res = {
      setHeader: vi.fn(),
      on: vi.fn(),
    };
    next = vi.fn();
  });

  it('should generate a new requestId if missing', () => {
    requestIdMiddleware(req as Request, res as Response, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String));
    expect(next).toHaveBeenCalled();
  });

  it('should use existing requestId from header', () => {
    req.headers = { 'x-request-id': 'existing-id' };
    requestIdMiddleware(req as Request, res as Response, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'existing-id');
    expect(next).toHaveBeenCalled();
  });

  it('should generate new id if header is too long', () => {
    req.headers = { 'x-request-id': 'a'.repeat(129) };
    requestIdMiddleware(req as Request, res as Response, next);
    const call = (res.setHeader as any).mock.calls[0];
    expect(call[1]).not.toBe('a'.repeat(129));
  });

  it('should reject a header containing a newline and generate a safe id instead', () => {
    const malicious = 'abc123\nfake log line injected';
    req.headers = { 'x-request-id': malicious };
    requestIdMiddleware(req as Request, res as Response, next);
    const call = (res.setHeader as any).mock.calls[0];
    expect(call[1]).not.toBe(malicious);
    expect(call[1]).not.toMatch(/\n/);
    expect(call[1]).toMatch(/^[a-f0-9-]+$/i);
  });

  it('should reject a header with other control/special characters', () => {
    req.headers = { 'x-request-id': 'id\r\nSet-Cookie: evil=1' };
    requestIdMiddleware(req as Request, res as Response, next);
    const call = (res.setHeader as any).mock.calls[0];
    expect(call[1]).toMatch(/^[a-f0-9-]+$/i);
  });

  it('should expose the generated correlation id on the request for error envelopes', () => {
    requestIdMiddleware(req as Request, res as Response, next);
    const headerValue = (res.setHeader as any).mock.calls[0][1];
    expect((req as any).requestId).toBe(headerValue);
    expect((req as any).requestId).toMatch(/^[a-f0-9-]+$/i);
  });

  it('should expose a preserved inbound correlation id on the request', () => {
    req.headers = { 'x-request-id': 'inbound-correlation-id' };
    requestIdMiddleware(req as Request, res as Response, next);
    expect((req as any).requestId).toBe('inbound-correlation-id');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'inbound-correlation-id');
  });

  it('should echo the correlation id in the response header so clients can correlate errors', () => {
    requestIdMiddleware(req as Request, res as Response, next);
    expect(res.setHeader).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String));
    const headerValue = (res.setHeader as any).mock.calls[0][1];
    expect(typeof headerValue).toBe('string');
    expect(headerValue.length).toBeGreaterThan(0);
  });

  it('should generate distinct ids across separate requests', () => {
    const firstRes: Partial<Response> = { setHeader: vi.fn(), on: vi.fn() };
    const secondRes: Partial<Response> = { setHeader: vi.fn(), on: vi.fn() };
    requestIdMiddleware(req as Request, firstRes as Response, next);
    requestIdMiddleware(req as Request, secondRes as Response, next);
    const first = (firstRes.setHeader as any).mock.calls[0][1];
    const second = (secondRes.setHeader as any).mock.calls[0][1];
    expect(first).not.toBe(second);
  });

  it('should not echo a malformed inbound id in the response header', () => {
    const malicious = 'abc123\nfake log line injected';
    req.headers = { 'x-request-id': malicious };
    requestIdMiddleware(req as Request, res as Response, next);
    const headerValue = (res.setHeader as any).mock.calls[0][1];
    expect(headerValue).not.toBe(malicious);
    expect((req as any).requestId).toBe(headerValue);
  });
});
