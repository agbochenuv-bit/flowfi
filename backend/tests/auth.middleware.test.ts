import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAuth, optionalAuth } from '../src/middleware/auth.js';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../src/services/auth.service.js', () => ({
  verifyToken: vi.fn(),
}));

import { verifyToken } from '../src/services/auth.service.js';

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

  describe('requireAuth', () => {
    it('should return 401 if no auth header', () => {
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if auth header is not Bearer', () => {
      req.headers = { authorization: 'Basic 123' };
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if Bearer token is missing', () => {
      req.headers = { authorization: 'Bearer ' };
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if token is invalid', () => {
      req.headers = { authorization: 'Bearer invalid-token' };
      vi.mocked(verifyToken).mockReturnValue(null);
      requireAuth(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('should attach user and call next for a valid token', () => {
      req.headers = { authorization: 'Bearer valid-token' };
      const user = { wallet: 'WalletA' };
      vi.mocked(verifyToken).mockReturnValue(user as never);
      requireAuth(req as Request, res as Response, next);
      expect((req as { user?: unknown }).user).toEqual(user);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    it('should call next without user when no auth header', () => {
      optionalAuth(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect((req as { user?: unknown }).user).toBeUndefined();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should call next without user when token is invalid', () => {
      req.headers = { authorization: 'Bearer invalid-token' };
      vi.mocked(verifyToken).mockReturnValue(null);
      optionalAuth(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect((req as { user?: unknown }).user).toBeUndefined();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should attach user when a valid token is present', () => {
      req.headers = { authorization: 'Bearer valid-token' };
      const user = { wallet: 'WalletA' };
      vi.mocked(verifyToken).mockReturnValue(user as never);
      optionalAuth(req as Request, res as Response, next);
      expect((req as { user?: unknown }).user).toEqual(user);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});