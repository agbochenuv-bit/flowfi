import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  updateStatus,
  findStreams,
  encodeStreamCursor,
  decodeStreamCursor,
} from '../src/repositories/stream.repository.js';
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

  describe('stream cursor encode/decode', () => {
    it('should round-trip a cursor with startTime and streamId', () => {
      const startTime = new Date('2024-05-01T12:34:56.789Z');
      const cursor = encodeStreamCursor({ startTime, streamId: 42n });

      expect(typeof cursor).toBe('string');
      expect(cursor).not.toContain('42');
      expect(cursor).not.toContain('2024');

      const decoded = decodeStreamCursor(cursor);
      expect(decoded).not.toBeNull();
      expect(decoded!.streamId).toBe(42n);
      expect(decoded!.startTime.toISOString()).toBe(startTime.toISOString());
    });

    it('should produce an opaque, URL-safe cursor', () => {
      const cursor = encodeStreamCursor({
        startTime: new Date('2024-01-01T00:00:00.000Z'),
        streamId: 1n,
      });

      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('should return null for malformed cursors', () => {
      expect(decodeStreamCursor('')).toBeNull();
      expect(decodeStreamCursor('not-a-cursor')).toBeNull();
      expect(decodeStreamCursor('!!!')).toBeNull();
    });

    it('should return null for a cursor with an invalid timestamp', () => {
      const bad = Buffer.from(JSON.stringify({ t: 'nope', id: '1' })).toString('base64url');
      expect(decodeStreamCursor(bad)).toBeNull();
    });

    it('should return null for a cursor with an invalid streamId', () => {
      const bad = Buffer.from(
        JSON.stringify({ t: '2024-01-01T00:00:00.000Z', id: 'abc' }),
      ).toString('base64url');
      expect(decodeStreamCursor(bad)).toBeNull();
    });

    it('should return null for a cursor missing required fields', () => {
      const missingId = Buffer.from(
        JSON.stringify({ t: '2024-01-01T00:00:00.000Z' }),
      ).toString('base64url');
      const missingTime = Buffer.from(JSON.stringify({ id: '1' })).toString('base64url');

      expect(decodeStreamCursor(missingId)).toBeNull();
      expect(decodeStreamCursor(missingTime)).toBeNull();
    });

    it('should preserve large streamIds without precision loss', () => {
      const streamId = 9007199254740993n;
      const cursor = encodeStreamCursor({
        startTime: new Date('2024-01-01T00:00:00.000Z'),
        streamId,
      });

      expect(decodeStreamCursor(cursor)!.streamId).toBe(streamId);
    });
  });

  describe('findStreams with cursor pagination', () => {
    const row = (streamId: bigint, startTime: string) => ({
      streamId,
      startTime: new Date(startTime),
    });

    it('should apply deterministic ordering with streamId tiebreaker', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await findStreams({ limit: 10, offset: 0 });

      expect(prisma.stream.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ startTime: 'desc' }, { streamId: 'desc' }],
        }),
      );
    });

    it('should translate a cursor into a keyset where clause', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      const startTime = new Date('2024-05-01T12:00:00.000Z');
      const cursor = encodeStreamCursor({ startTime, streamId: 100n });

      await findStreams({ limit: 10, offset: 0, cursor });

      const call = (prisma.stream.findMany as any).mock.calls[0][0];
      expect(call.skip).toBeUndefined();
      expect(call.cursor).toBeUndefined();
      expect(call.where).toEqual(
        expect.objectContaining({
          OR: [
            { startTime: { lt: startTime } },
            { startTime, streamId: { lt: 100n } },
          ],
        }),
      );
    });

    it('should combine cursor keyset with existing filters', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      const startTime = new Date('2024-05-01T12:00:00.000Z');
      const cursor = encodeStreamCursor({ startTime, streamId: 100n });

      await findStreams({ limit: 10, offset: 0, cursor, sender: 'GSENDER' });

      const call = (prisma.stream.findMany as any).mock.calls[0][0];
      expect(call.where).toEqual(
        expect.objectContaining({
          sender: 'GSENDER',
          OR: [
            { startTime: { lt: startTime } },
            { startTime, streamId: { lt: 100n } },
          ],
        }),
      );
    });

    it('should ignore offset when a cursor is supplied', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      const cursor = encodeStreamCursor({
        startTime: new Date('2024-05-01T12:00:00.000Z'),
        streamId: 100n,
      });

      await findStreams({ limit: 10, offset: 50, cursor });

      const call = (prisma.stream.findMany as any).mock.calls[0][0];
      expect(call.skip).toBeUndefined();
    });

    it('should return nextCursor from the last row when hasMore is true', async () => {
      const rows = [
        row(105n, '2024-05-01T12:00:05.000Z'),
        row(104n, '2024-05-01T12:00:04.000Z'),
        row(103n, '2024-05-01T12:00:03.000Z'),
      ];
      (prisma.stream.findMany as any).mockResolvedValue(rows);
      (prisma.stream.count as any).mockResolvedValue(10);

      const result = await findStreams({ limit: 3, offset: 0 });

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeTruthy();

      const decoded = decodeStreamCursor(result.nextCursor!);
      expect(decoded!.streamId).toBe(103n);
      expect(decoded!.startTime.toISOString()).toBe('2024-05-01T12:00:03.000Z');
    });

    it('should return null nextCursor when at the end of results', async () => {
      const rows = [row(2n, '2024-05-01T12:00:02.000Z')];
      (prisma.stream.findMany as any).mockResolvedValue(rows);
      (prisma.stream.count as any).mockResolvedValue(1);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('should return null nextCursor for an empty page', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      const result = await findStreams({ limit: 10, offset: 0 });

      expect(result.streams).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('should throw on an invalid cursor', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await expect(
        findStreams({ limit: 10, offset: 0, cursor: 'garbage' }),
      ).rejects.toThrow();
      expect(prisma.stream.findMany).not.toHaveBeenCalled();
    });

    it('should not skip or duplicate rows across page boundaries with equal timestamps', async () => {
      const ts = '2024-05-01T12:00:00.000Z';
      const all = [row(9n, ts), row(8n, ts), row(7n, ts), row(6n, ts), row(5n, ts)];

      const page1 = all.slice(0, 2);
      (prisma.stream.findMany as any).mockResolvedValueOnce(page1);
      (prisma.stream.count as any).mockResolvedValue(5);

      const first = await findStreams({ limit: 2, offset: 0 });
      expect(first.streams.map((s: any) => s.streamId)).toEqual([9n, 8n]);
      expect(first.hasMore).toBe(true);

      const page2 = all.slice(2, 4);
      (prisma.stream.findMany as any).mockResolvedValueOnce(page2);
      (prisma.stream.count as any).mockResolvedValue(5);

      const second = await findStreams({ limit: 2, offset: 0, cursor: first.nextCursor! });
      expect(second.streams.map((s: any) => s.streamId)).toEqual([7n, 6n]);

      const page3 = all.slice(4);
      (prisma.stream.findMany as any).mockResolvedValueOnce(page3);
      (prisma.stream.count as any).mockResolvedValue(5);

      const third = await findStreams({ limit: 2, offset: 0, cursor: second.nextCursor! });
      expect(third.streams.map((s: any) => s.streamId)).toEqual([5n]);
      expect(third.hasMore).toBe(false);

      const seen = [
        ...first.streams,
        ...second.streams,
        ...third.streams,
      ].map((s: any) => s.streamId);
      expect(seen).toEqual([9n, 8n, 7n, 6n, 5n]);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('should remain stable when rows are inserted concurrently between pages', async () => {
      const ts = '2024-05-01T12:00:00.000Z';
      const original = [row(9n, ts), row(8n, ts), row(7n, ts), row(6n, ts)];

      (prisma.stream.findMany as any).mockResolvedValueOnce(original.slice(0, 2));
      (prisma.stream.count as any).mockResolvedValue(4);

      const first = await findStreams({ limit: 2, offset: 0 });

      // A newer row is inserted after page 1; keyset pagination must not shift page 2.
      const withInsert = [row(10n, ts), ...original];
      (prisma.stream.findMany as any).mockResolvedValueOnce(withInsert.slice(2, 4));
      (prisma.stream.count as any).mockResolvedValue(5);

      const second = await findStreams({ limit: 2, offset: 0, cursor: first.nextCursor! });

      expect(second.streams.map((s: any) => s.streamId)).toEqual([7n, 6n]);

      const call = (prisma.stream.findMany as any).mock.calls[1][0];
      expect(call.skip).toBeUndefined();
      expect(call.where.OR).toBeDefined();
    });

    it('should handle a cursor at the exact boundary of the last row', async () => {
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(1);

      const cursor = encodeStreamCursor({
        startTime: new Date('2024-05-01T12:00:00.000Z'),
        streamId: 1n,
      });

      const result = await findStreams({ limit: 10, offset: 0, cursor });

      expect(result.streams).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });
  });
});
