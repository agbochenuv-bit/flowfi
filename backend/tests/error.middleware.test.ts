import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { ApiError } from '../src/errors/api-error.js';
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

  it('should sanitize ZodError body and not leak stack traces', () => {
    const error = new ZodError([{ path: ['email'], message: 'invalid', code: 'custom' }]);
    errorHandler(error, req as Request, res as Response, next);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual([{ path: 'email', message: 'invalid' }]);
    expect(body.error.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('should handle ApiError with its status and code', () => {
    const error = new ApiError(422, 'UNPROCESSABLE', 'Cannot process');
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'UNPROCESSABLE', message: 'Cannot process' }),
    }));
  });

  it('should not leak ApiError details or stack in response body', () => {
    const error = new ApiError(400, 'BAD_REQUEST', 'Bad input', { internalId: 'secret-123' });
    errorHandler(error, req as Request, res as Response, next);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret-123');
  });

  it('should map unknown Prisma known request errors to 500 without leaking identifiers', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Boom', { code: 'P9999', clientVersion: '1.0', meta: { target: ['secret_column'] } });
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('secret_column');
    expect(body.error.stack).toBeUndefined();
  });

  it('should sanitize generic error body with no stack trace', () => {
    const error = new Error('Generic error');
    errorHandler(error, req as Request, res as Response, next);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Generic error');
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
