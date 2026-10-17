import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAuth } from '../src/middleware/auth.js';
import type { Request, Response, NextFunction } from 'express';

describe('Auth Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = { headers: {} };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('should return 401 if no auth header', () => {
    requireAuth(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 401 if auth header is not Bearer', () => {
    req.headers = { authorization: 'Basic 123' };
    requireAuth(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  describe('JWT signing-key rotation', () => {
    const SECRET_ACTIVE = 'active-secret-value-should-never-leak';
    const SECRET_OVERLAP = 'overlap-secret-value-should-never-leak';
    const SECRET_RETIRED = 'retired-secret-value-should-never-leak';

    const buildToken = (kid: string, secret: string): string => {
      // Minimal unsigned-payload token with a kid header; the middleware is
      // expected to resolve the verification key by kid and reject unknown or
      // retired kids before any signature check.
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid })).toString(
        'base64url',
      );
      const payload = Buffer.from(
        JSON.stringify({ sub: 'user-1', iat: Math.floor(Date.now() / 1000) }),
      ).toString('base64url');
      const signature = Buffer.from(`${secret}:${header}.${payload}`).toString('base64url');
      return `${header}.${payload}.${signature}`;
    };

    const assertNoSecretLeak = (value: unknown) => {
      const serialized = JSON.stringify(value ?? '');
      expect(serialized).not.toContain(SECRET_ACTIVE);
      expect(serialized).not.toContain(SECRET_OVERLAP);
      expect(serialized).not.toContain(SECRET_RETIRED);
    };

    it('accepts a token signed by the active key', () => {
      req.headers = { authorization: `Bearer ${buildToken('active-1', SECRET_ACTIVE)}` };
      requireAuth(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(401);
    });

    it('accepts a token signed by an overlap key during the rotation window', () => {
      req.headers = { authorization: `Bearer ${buildToken('overlap-1', SECRET_OVERLAP)}` };
      requireAuth(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(401);
    });

    it('rejects a token signed by a retired key with 401', () => {
      req.headers = { authorization: `Bearer ${buildToken('retired-1', SECRET_RETIRED)}` };
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a token with an unknown kid with 401', () => {
      req.headers = { authorization: `Bearer ${buildToken('unknown-kid', SECRET_ACTIVE)}` };
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('does not expose secret values in the error response', () => {
      req.headers = { authorization: `Bearer ${buildToken('retired-1', SECRET_RETIRED)}` };
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      const jsonCalls = (res.json as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of jsonCalls) {
        assertNoSecretLeak(call[0]);
      }
      assertNoSecretLeak(res.json);
    });

    it('does not expose secret values in diagnostics/logs', () => {
      const consoleSpies = [
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
        vi.spyOn(console, 'info').mockImplementation(() => {}),
        vi.spyOn(console, 'debug').mockImplementation(() => {}),
      ];
      try {
        req.headers = { authorization: `Bearer ${buildToken('retired-1', SECRET_RETIRED)}` };
        requireAuth(req as Request, res as Response, next);
        for (const spy of consoleSpies) {
          for (const call of spy.mock.calls) {
            assertNoSecretLeak(call);
          }
        }
      } finally {
        for (const spy of consoleSpies) {
          spy.mockRestore();
        }
      }
    });
  });
});