import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { ZodError } from 'zod';
import { Prisma } from '../src/generated/prisma/index.js';
import type { Request, Response, NextFunction } from 'express';

describe('Error Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {};
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('should handle ZodError', () => {
    const error = new ZodError([{ path: ['field'], message: 'invalid', code: 'custom' }]);
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    }));
  });

  it('should handle Prisma P2002 error', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Conflict', { code: 'P2002', clientVersion: '1.0', meta: { target: ['email'] } });
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'CONFLICT' }),
    }));
  });

  it('should handle Prisma P2025 error', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: '1.0' });
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('should handle generic error', () => {
    const error = new Error('Generic error');
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  describe('error envelope contract', () => {
    const getBody = () => {
      const jsonMock = res.json as unknown as ReturnType<typeof vi.fn>;
      expect(jsonMock).toHaveBeenCalledTimes(1);
      return jsonMock.mock.calls[0][0];
    };

    it('should return a versioned envelope with a stable code for validation errors', () => {
      const error = new ZodError([
        { path: ['email'], message: 'Invalid email', code: 'invalid_string' },
        { path: ['password'], message: 'Too short', code: 'too_small' },
      ]);
      errorHandler(error, req as Request, res as Response, next);

      const body = getBody();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(body).toEqual(expect.objectContaining({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          version: expect.any(String),
          requestId: expect.any(String),
        }),
      }));
      expect(body.error.details).toEqual([
        { path: 'email', message: 'Invalid email' },
        { path: 'password', message: 'Too short' },
      ]);
    });

    it('should normalize nested validation paths into dotted details', () => {
      const error = new ZodError([
        { path: ['user', 'address', 'zip'], message: 'Required', code: 'invalid_type' },
      ]);
      errorHandler(error, req as Request, res as Response, next);

      const body = getBody();
      expect(body.error.details).toEqual([{ path: 'user.address.zip', message: 'Required' }]);
    });

    it('should return a stable CONFLICT code for Prisma P2002', () => {
      const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
        code: 'P2002',
        clientVersion: '1.0',
        meta: { target: ['email'] },
      });
      errorHandler(error, req as Request, res as Response, next);

      const body = getBody();
      expect(res.status).toHaveBeenCalledWith(409);
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.version).toEqual(expect.any(String));
      expect(body.error.requestId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain('Unique constraint failed');
    });

    it('should return a stable NOT_FOUND code for Prisma P2025', () => {
      const error = new Prisma.PrismaClientKnownRequestError('An operation failed because it depends on one or more records that were required but not found.', {
        code: 'P2025',
        clientVersion: '1.0',
      });
      errorHandler(error, req as Request, res as Response, next);

      const body = getBody();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.version).toEqual(expect.any(String));
      expect(body.error.requestId).toEqual(expect.any(String));
    });

    it('should never expose internal exception text for unknown errors', () => {
      const error = new Error('secret db detail');
      errorHandler(error, req as Request, res as Response, next);

      const body = getBody();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.version).toEqual(expect.any(String));
      expect(body.error.requestId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain('secret db detail');
      expect(body.error).not.toHaveProperty('stack');
    });

    it('should not expose internal text for non-Error thrown values', () => {
      errorHandler('secret db detail', req as Request, res as Response, next);

      const body = getBody();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(body)).not.toContain('secret db detail');
    });

    it('should reuse an incoming request correlation id', () => {
      req = { headers: { 'x-request-id': 'req-abc-123' } } as Partial<Request>;
      errorHandler(new Error('boom'), req as Request, res as Response, next);

      const body = getBody();
      expect(body.error.requestId).toBe('req-abc-123');
    });

    it('should generate a request id when none is supplied', () => {
      req = { headers: {} } as Partial<Request>;
      errorHandler(new Error('boom'), req as Request, res as Response, next);

      const body = getBody();
      expect(typeof body.error.requestId).toBe('string');
      expect(body.error.requestId.length).toBeGreaterThan(0);
    });

    it('should generate a request id when headers are undefined', () => {
      req = {} as Partial<Request>;
      errorHandler(new Error('boom'), req as Request, res as Response, next);

      const body = getBody();
      expect(typeof body.error.requestId).toBe('string');
      expect(body.error.requestId.length).toBeGreaterThan(0);
    });

    it('should ignore an empty incoming request id and generate one', () => {
      req = { headers: { 'x-request-id': '' } } as Partial<Request>;
      errorHandler(new Error('boom'), req as Request, res as Response, next);

      const body = getBody();
      expect(typeof body.error.requestId).toBe('string');
      expect(body.error.requestId.length).toBeGreaterThan(0);
    });

    it('should include a safe message and omit details for unknown errors', () => {
      errorHandler(new Error('secret db detail'), req as Request, res as Response, next);

      const body = getBody();
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message).not.toContain('secret db detail');
      expect(body.error.details).toBeUndefined();
    });
  });

  it('should delegate to next when headers were already sent', () => {
    const error = new Error('Stream failed after headers');
    res.headersSent = true;

    errorHandler(error, req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
