import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerUser, getUser, getUserEvents, getCurrentUser } from '../src/controllers/user.controller.js';
import { prisma } from '../src/lib/prisma.js';
import { ApiError } from '../src/lib/errors.js';
import type { Request, Response } from 'express';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    streamEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('User Controller', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: any;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {};
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  describe('registerUser', () => {
    it('should register a new user', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.body = { publicKey };
      (prisma.user.findUnique as any).mockResolvedValue(null);
      (prisma.user.create as any).mockResolvedValue({ publicKey });

      await registerUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ publicKey });
    });

    it('should return 200 if user already exists', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.body = { publicKey };
      (prisma.user.findUnique as any).mockResolvedValue({ publicKey });

      await registerUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ publicKey });
    });

    it('should call next with error if prisma fails', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.body = { publicKey };
      (prisma.user.findUnique as any).mockRejectedValue(new Error('DB error'));

      await registerUser(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getUser', () => {
    it('should throw ApiError 400 if publicKey is missing', async () => {
      req.params = {};

      await expect(getUser(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_PUBLIC_KEY',
      });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should throw ApiError 400 if publicKey is malformed', async () => {
      req.params = { publicKey: 'invalid-key' };

      await expect(getUser(req as Request, res as Response, next)).rejects.toBeInstanceOf(ApiError);
      await expect(getUser(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_PUBLIC_KEY',
        message: 'Invalid Stellar public key format',
      });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should throw ApiError 404 if user not found', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      (prisma.user.findUnique as any).mockResolvedValue(null);

      await expect(getUser(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 404,
        code: 'USER_NOT_FOUND',
      });
    });

    it('should return user if found and requester owns the wallet', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.params = { publicKey };
      (req as any).user = { publicKey };
      const mockUser = { publicKey, sentStreams: [], receivedStreams: [] };
      (prisma.user.findUnique as any).mockResolvedValue(mockUser);

      await getUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockUser);
    });

    it('should throw ApiError 403 when requesting another wallet', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      (req as any).user = { publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' };

      await expect(getUser(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should throw ApiError 401 when unauthenticated', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };

      await expect(getUser(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    });

    it('should query with an explicit select clause excluding internal-only fields', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.params = { publicKey };
      (req as any).user = { publicKey };
      const mockUser = { id: 'uuid-1', publicKey, createdAt: new Date(), updatedAt: new Date(), sentStreams: [], receivedStreams: [] };
      (prisma.user.findUnique as any).mockResolvedValue(mockUser);

      await getUser(req as Request, res as Response, next);

      const call = (prisma.user.findUnique as any).mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.include).toBeUndefined();

      const jsonArg = (res.json as any).mock.calls[0][0];
      expect(jsonArg).not.toHaveProperty('passwordHash');
      expect(jsonArg).not.toHaveProperty('internalNotes');
      expect(jsonArg).not.toHaveProperty('apiSecret');
    });
  });

  describe('getUserEvents', () => {
    const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';

    beforeEach(() => {
      (req as any).user = { publicKey };
    });

    it('should throw ApiError 400 if publicKey is missing', async () => {
      req.params = {};
      await expect(getUserEvents(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_PUBLIC_KEY',
      });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should throw ApiError 400 if publicKey is malformed', async () => {
      req.params = { publicKey: 'invalid-key' };
      await expect(getUserEvents(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_PUBLIC_KEY',
        message: 'Invalid Stellar public key format',
      });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should throw ApiError 400 if publicKey has wrong format (too short)', async () => {
      req.params = { publicKey: 'GTOOSHORT' };
      await expect(getUserEvents(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_PUBLIC_KEY',
      });
    });

    it('should throw ApiError 403 when requesting another wallet events', async () => {
      req.params = { publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' };
      req.query = {};

      await expect(getUserEvents(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
      });
      expect(prisma.streamEvent.findMany).not.toHaveBeenCalled();
    });

    it('should return paginated events', async () => {
      req.params = { publicKey };
      req.query = { limit: '10', offset: '0' };
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { timestamp: 'desc' },
        }),
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: [],
        total: 0,
        limit: 10,
        offset: 0
      }));
    });

    it('includes the related stream by default', async () => {
      req.params = { publicKey };
      req.query = {};
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: { stream: true } }),
      );
    });

    it('omits the related stream when includeStream=false', async () => {
      req.params = { publicKey };
      req.query = { includeStream: 'false' };
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.include).toBeUndefined();
    });

    it('forwards a comma-separated type filter to the shared query helper', async () => {
      req.params = { publicKey };
      req.query = { type: 'PAUSED,RESUMED' };
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.where.eventType).toEqual({ in: ['PAUSED', 'RESUMED'] });
    });

    it('throws ApiError 400 when the type filter has no valid values', async () => {
      req.params = { publicKey };
      req.query = { type: 'BOGUS' };

      await expect(getUserEvents(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_QUERY',
      });
      expect(prisma.streamEvent.findMany).not.toHaveBeenCalled();
    });

    it('throws ApiError 400 for out-of-range pagination values', async () => {
      req.params = { publicKey };
      req.query = { limit: '1000' };

      await expect(getUserEvents(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_QUERY',
      });
      expect(prisma.streamEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentUser', () => {
    it('should return 200 with user from DB', async () => {
      (req as any).user = { publicKey: 'GME' };
      (prisma.user.findUnique as any).mockResolvedValue({ publicKey: 'GME' });

      await getCurrentUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ publicKey: 'GME' });
    });

    it('should return in-memory user if not in DB', async () => {
      (req as any).user = { publicKey: 'GME' };
      (prisma.user.findUnique as any).mockResolvedValue(null);

      await getCurrentUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        publicKey: 'GME',
        inMemory: true
      }));
    });

    it('should throw ApiError 401 when unauthenticated', async () => {
      await expect(getCurrentUser(req as Request, res as Response, next)).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });
});
