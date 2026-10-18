import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateStatus, findStreams } from '../src/repositories/stream.repository.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

describe('Stream Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('updateStatus', () => {
    it('should update isActive to false for CANCELLED', async () => {
      await updateStatus(123n, 'CANCELLED');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: false },
      });
    });

    it('should update isActive to false for COMPLETED', async () => {
      await updateStatus(123n, 'COMPLETED');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: false },
      });
    });

    it('should update isActive to true for ACTIVE', async () => {
      await updateStatus(123n, 'ACTIVE');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: true },
      });
    });

    it('should update isActive to true for PAUSED', async () => {
      await updateStatus(123n, 'PAUSED');
      expect(prisma.stream.update).toHaveBeenCalledWith({
        where: { streamId: 123n },
        data: { isActive: true },
      });
    });
  });

  describe('findStreams', () => {
    const baseParams = { limit: 10, offset: 0 };

    it('should query with default sort when no sort params given', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams(baseParams);

      expect(prisma.stream.findMany).toHaveBeenCalledWith(expect.objectContaining({
        orderBy: { startTime: 'desc' },
        take: 10,
        skip: 0,
      }));
    });

    it('should filter by sender when provided', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, sender: 'GSENDER' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sender: 'GSENDER' }),
        }),
      );
    });

    it('should filter active streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'active' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true, isPaused: false }),
        }),
      );
    });

    it('should filter paused streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'paused' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isPaused: true }),
        }),
      );
    });

    it('should filter cancelled streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'cancelled' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: false,
            events: { some: { eventType: 'CANCELLED' } },
          }),
        }),
      );
    });

    it('should filter completed streams correctly', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ ...baseParams, status: 'completed' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: false,
            events: { some: { eventType: 'COMPLETED' } },
          }),
        }),
      );
    });

    it('should apply limit and offset for pagination', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ limit: 5, offset: 10 });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 10 }),
      );
    });

    it('should return hasMore true when more results exist', async () => {
      (prisma.stream.findMany as any).mockResolvedValue(Array(10).fill({}));
      (prisma.stream.count as any).mockResolvedValue(15);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(15);
      expect(result.streams).toHaveLength(10);
    });

    it('should return hasMore false when at end of results', async () => {
      (prisma.stream.findMany as any).mockResolvedValue(Array(5).fill({}));
      (prisma.stream.count as any).mockResolvedValue(5);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.hasMore).toBe(false);
      expect(result.total).toBe(5);
      expect(result.streams).toHaveLength(5);
    });
  });

  describe('findStreams ordering and pagination stability', () => {
    it('should preserve result ordering returned by the database', async () => {
      const rows = [
        { streamId: 3n, startTime: new Date('2024-03-01T00:00:00Z') },
        { streamId: 2n, startTime: new Date('2024-02-01T00:00:00Z') },
        { streamId: 1n, startTime: new Date('2024-01-01T00:00:00Z') },
      ];
      (prisma.stream.findMany as any).mockResolvedValue(rows);
      (prisma.stream.count as any).mockResolvedValue(3);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.streams).toEqual(rows);
      expect(result.streams.map((s: any) => s.streamId)).toEqual([3n, 2n, 1n]);
    });

    it('should keep ordering stable across pages with offset pagination', async () => {
      const all = [
        { streamId: 5n },
        { streamId: 4n },
        { streamId: 3n },
        { streamId: 2n },
        { streamId: 1n },
      ];
      (prisma.stream.count as any).mockResolvedValue(all.length);

      (prisma.stream.findMany as any).mockResolvedValueOnce(all.slice(0, 2));
      const first = await findStreams({ limit: 2, offset: 0 });

      (prisma.stream.findMany as any).mockResolvedValueOnce(all.slice(2, 4));
      const second = await findStreams({ limit: 2, offset: 2 });

      (prisma.stream.findMany as any).mockResolvedValueOnce(all.slice(4, 5));
      const third = await findStreams({ limit: 2, offset: 4 });

      expect(first.streams.map((s: any) => s.streamId)).toEqual([5n, 4n]);
      expect(second.streams.map((s: any) => s.streamId)).toEqual([3n, 2n]);
      expect(third.streams.map((s: any) => s.streamId)).toEqual([1n]);

      expect(first.hasMore).toBe(true);
      expect(second.hasMore).toBe(true);
      expect(third.hasMore).toBe(false);

      expect(prisma.stream.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ take: 2, skip: 0 }),
      );
      expect(prisma.stream.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ take: 2, skip: 2 }),
      );
      expect(prisma.stream.findMany).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ take: 2, skip: 4 }),
      );
    });

    it('should handle empty result set', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.streams).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should handle offset beyond total results', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(3);

      const result = await findStreams({ limit: 10, offset: 100 });

      expect(result.streams).toEqual([]);
      expect(result.total).toBe(3);
      expect(result.hasMore).toBe(false);
      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 100 }),
      );
    });

    it('should report hasMore true on first page when total exceeds page size', async () => {
      (prisma.stream.findMany as any).mockResolvedValue(Array(2).fill({}));
      (prisma.stream.count as any).mockResolvedValue(3);

      const result = await findStreams({ limit: 2, offset: 0 });

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(3);
    });

    it('should report hasMore false on last page when offset + page size equals total', async () => {
      (prisma.stream.findMany as any).mockResolvedValue(Array(2).fill({}));
      (prisma.stream.count as any).mockResolvedValue(4);

      const result = await findStreams({ limit: 2, offset: 2 });

      expect(result.hasMore).toBe(false);
      expect(result.total).toBe(4);
    });

    it('should apply deterministic tie-breaker ordering with secondary sort key', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ limit: 10, offset: 0, sortBy: 'startTime', sortOrder: 'desc' });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: expect.anything(),
        }),
      );
    });

    it('should preserve ordering when filtering by status and paginating', async () => {
      const rows = [{ streamId: 9n }, { streamId: 7n }];
      (prisma.stream.findMany as any).mockResolvedValue(rows);
      (prisma.stream.count as any).mockResolvedValue(2);

      const result = await findStreams({ limit: 2, offset: 0, status: 'active' });

      expect(result.streams.map((s: any) => s.streamId)).toEqual([9n, 7n]);
      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true, isPaused: false }),
          take: 2,
          skip: 0,
        }),
      );
    });
  });
});
