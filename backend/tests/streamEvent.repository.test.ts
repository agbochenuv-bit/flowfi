import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listEventsForWallet,
  parseEventTypeFilter,
  resolveEventsOffset,
  resolveEventsPageSize,
  encodeEventsCursor,
  decodeEventsCursor,
  DEFAULT_EVENTS_PAGE_SIZE,
  MAX_EVENTS_PAGE_SIZE,
} from '../src/repositories/streamEvent.repository.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    streamEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

describe('streamEvent.repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseEventTypeFilter', () => {
    it('returns no requested/types for an empty filter', () => {
      expect(parseEventTypeFilter(undefined)).toEqual({ requested: [], types: [] });
      expect(parseEventTypeFilter('')).toEqual({ requested: [], types: [] });
    });

    it('parses a comma-separated, case-insensitive list of valid types', () => {
      const result = parseEventTypeFilter('paused, resumed ,Withdrawn');
      expect(result.requested).toEqual(['PAUSED', 'RESUMED', 'WITHDRAWN']);
      expect(result.types).toEqual(['PAUSED', 'RESUMED', 'WITHDRAWN']);
    });

    it('drops unknown types from `types` while keeping them in `requested`', () => {
      const result = parseEventTypeFilter('PAUSED,BOGUS,RESUMED');
      expect(result.requested).toEqual(['PAUSED', 'BOGUS', 'RESUMED']);
      expect(result.types).toEqual(['PAUSED', 'RESUMED']);
    });

    it('returns an empty types list when every requested value is unknown', () => {
      const result = parseEventTypeFilter('BOGUS,ALSO_BOGUS');
      expect(result.requested).toEqual(['BOGUS', 'ALSO_BOGUS']);
      expect(result.types).toEqual([]);
    });

    it('ignores non-string input', () => {
      expect(parseEventTypeFilter(undefined)).toEqual({ requested: [], types: [] });
      expect(parseEventTypeFilter(['PAUSED'])).toEqual({ requested: [], types: [] });
    });
  });

  describe('resolveEventsPageSize', () => {
    it('falls back to the default when limit is missing or invalid', () => {
      expect(resolveEventsPageSize(undefined)).toBe(DEFAULT_EVENTS_PAGE_SIZE);
      expect(resolveEventsPageSize('not-a-number')).toBe(DEFAULT_EVENTS_PAGE_SIZE);
      expect(resolveEventsPageSize('0')).toBe(DEFAULT_EVENTS_PAGE_SIZE);
      expect(resolveEventsPageSize('-5')).toBe(DEFAULT_EVENTS_PAGE_SIZE);
    });

    it('uses the requested limit when within bounds', () => {
      expect(resolveEventsPageSize('25')).toBe(25);
    });

    it('clamps to MAX_EVENTS_PAGE_SIZE', () => {
      expect(resolveEventsPageSize('999999')).toBe(MAX_EVENTS_PAGE_SIZE);
    });
  });

  describe('resolveEventsOffset', () => {
    it('defaults to 0 with no offset or page', () => {
      expect(resolveEventsOffset({ rawOffset: undefined, limit: 10 })).toBe(0);
    });

    it('uses an explicit non-negative offset', () => {
      expect(resolveEventsOffset({ rawOffset: '20', limit: 10 })).toBe(20);
    });

    it('falls back to page-based offset when offset is missing', () => {
      expect(
        resolveEventsOffset({ rawOffset: undefined, rawPage: '4', limit: 10 }),
      ).toBe(30);
    });

    it('falls back to page-based offset when offset is invalid', () => {
      expect(
        resolveEventsOffset({ rawOffset: '-1', rawPage: '3', limit: 10 }),
      ).toBe(20);
    });
  });

  describe('listEventsForWallet', () => {
    const ADDR = 'GADDR123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';

    it('builds a sender/recipient OR where-clause scoped to the wallet', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stream: { OR: [{ sender: ADDR }, { recipient: ADDR }] } },
          orderBy: { timestamp: 'desc' },
          take: 10,
          skip: 0,
        }),
      );
      expect(prisma.streamEvent.count).toHaveBeenCalledWith({
        where: { stream: { OR: [{ sender: ADDR }, { recipient: ADDR }] } },
      });
    });

    it('adds an eventType `in` filter when types are provided', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({
        address: ADDR,
        types: ['PAUSED', 'RESUMED'],
        limit: 10,
        offset: 0,
      });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.where.eventType).toEqual({ in: ['PAUSED', 'RESUMED'] });
    });

    it('omits the eventType filter when no types are provided', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({ address: ADDR, types: [], limit: 10, offset: 0 });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.where.eventType).toBeUndefined();
    });

    it('applies skip/take for pagination', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({ address: ADDR, limit: 5, offset: 15 });

      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 15 }),
      );
    });

    it('does not include the related stream by default', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.include).toBeUndefined();
    });

    it('includes the related stream when includeStream is true', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({ address: ADDR, limit: 10, offset: 0, includeStream: true });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.include).toEqual({ stream: true });
    });

    it('computes hasMore from offset, returned count, and total', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue(Array(10).fill({}));
      (prisma.streamEvent.count as any).mockResolvedValue(25);

      const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

      expect(result.total).toBe(25);
      expect(result.hasMore).toBe(true);
    });

    it('returns hasMore false at the end of results', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue(Array(5).fill({}));
      (prisma.streamEvent.count as any).mockResolvedValue(20);

      const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 15 });

      expect(result.hasMore).toBe(false);
    });

    describe('ordering and pagination stability', () => {
      const makeEvent = (id: string, timestamp: Date) => ({ id, timestamp });

      it('always orders by timestamp desc so index-backed reads are deterministic', async () => {
        (prisma.streamEvent.findMany as any).mockResolvedValue([]);
        (prisma.streamEvent.count as any).mockResolvedValue(0);

        await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

        const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
        expect(callArgs.orderBy).toEqual({ timestamp: 'desc' });
      });

      it('preserves the order returned by the database without re-sorting', async () => {
        const rows = [
          makeEvent('evt-3', new Date('2024-03-03T00:00:00.000Z')),
          makeEvent('evt-2', new Date('2024-03-02T00:00:00.000Z')),
          makeEvent('evt-1', new Date('2024-03-01T00:00:00.000Z')),
        ];
        (prisma.streamEvent.findMany as any).mockResolvedValue(rows);
        (prisma.streamEvent.count as any).mockResolvedValue(3);

        const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

        expect(result.events.map((e: any) => e.id)).toEqual(['evt-3', 'evt-2', 'evt-1']);
      });

      it('keeps tie-breaker ordering stable for events sharing a timestamp', async () => {
        const ts = new Date('2024-05-01T12:00:00.000Z');
        const rows = [
          makeEvent('evt-b', ts),
          makeEvent('evt-a', ts),
          makeEvent('evt-c', ts),
        ];
        (prisma.streamEvent.findMany as any).mockResolvedValue(rows);
        (prisma.streamEvent.count as any).mockResolvedValue(3);

        const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

        // The repository must not reorder rows; the database tie-breaker wins.
        expect(result.events.map((e: any) => e.id)).toEqual(['evt-b', 'evt-a', 'evt-c']);
      });

      it('returns an empty page with hasMore false when there are no events', async () => {
        (prisma.streamEvent.findMany as any).mockResolvedValue([]);
        (prisma.streamEvent.count as any).mockResolvedValue(0);

        const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

        expect(result.events).toEqual([]);
        expect(result.total).toBe(0);
        expect(result.hasMore).toBe(false);
      });

      it('reports hasMore true on the first page when more rows exist', async () => {
        (prisma.streamEvent.findMany as any).mockResolvedValue(Array(10).fill({}));
        (prisma.streamEvent.count as any).mockResolvedValue(11);

        const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 0 });

        expect(result.hasMore).toBe(true);
      });

      it('reports hasMore false on the last page when the page is exactly full', async () => {
        (prisma.streamEvent.findMany as any).mockResolvedValue(Array(10).fill({}));
        (prisma.streamEvent.count as any).mockResolvedValue(20);

        const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 10 });

        expect(result.hasMore).toBe(false);
      });

      it('reports hasMore false when the offset is beyond the total', async () => {
        (prisma.streamEvent.findMany as any).mockResolvedValue([]);
        (prisma.streamEvent.count as any).mockResolvedValue(5);

        const result = await listEventsForWallet({ address: ADDR, limit: 10, offset: 50 });

        expect(result.events).toEqual([]);
        expect(result.hasMore).toBe(false);
      });

      it('passes skip/take unchanged for the last partial page', async () => {
        (prisma.streamEvent.findMany as any).mockResolvedValue(Array(3).fill({}));
        (prisma.streamEvent.count as any).mockResolvedValue(23);

        await listEventsForWallet({ address: ADDR, limit: 10, offset: 20 });

        expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ take: 10, skip: 20 }),
        );
      });

      it('uses the same where-clause for the page and the count query', async () => {
        (prisma.streamEvent.findMany as any).mockResolvedValue([]);
        (prisma.streamEvent.count as any).mockResolvedValue(0);

        await listEventsForWallet({
          address: ADDR,
          types: ['PAUSED'],
          limit: 10,
          offset: 0,
        });

        const findArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
        const countArgs = (prisma.streamEvent.count as any).mock.calls[0][0];
        expect(countArgs.where).toEqual(findArgs.where);
      });
    });
  });

  describe('encodeEventsCursor / decodeEventsCursor', () => {
    const TS = new Date('2024-05-01T12:00:00.000Z');

    it('round-trips a timestamp and id', () => {
      const cursor = encodeEventsCursor({ timestamp: TS, id: 'evt_1' });
      expect(typeof cursor).toBe('string');
      expect(decodeEventsCursor(cursor)).toEqual({ timestamp: TS, id: 'evt_1' });
    });

    it('produces an opaque, URL-safe token', () => {
      const cursor = encodeEventsCursor({ timestamp: TS, id: 'evt_1' });
      expect(cursor).not.toContain('evt_1');
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('produces distinct cursors for equal timestamps with different ids', () => {
      const a = encodeEventsCursor({ timestamp: TS, id: 'evt_1' });
      const b = encodeEventsCursor({ timestamp: TS, id: 'evt_2' });
      expect(a).not.toBe(b);
    });

    it('returns null for malformed cursors', () => {
      expect(decodeEventsCursor('not-a-cursor')).toBeNull();
      expect(decodeEventsCursor('')).toBeNull();
      expect(decodeEventsCursor('%%%')).toBeNull();
    });

    it('returns null for a cursor with an invalid timestamp', () => {
      const bad = Buffer.from(JSON.stringify({ t: 'nope', id: 'evt_1' })).toString(
        'base64url',
      );
      expect(decodeEventsCursor(bad)).toBeNull();
    });

    it('returns null for a cursor missing the id', () => {
      const bad = Buffer.from(JSON.stringify({ t: TS.toISOString() })).toString(
        'base64url',
      );
      expect(decodeEventsCursor(bad)).toBeNull();
    });
  });

  describe('listEventsForWallet with cursor pagination', () => {
    const ADDR = 'GADDR123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';
    const TS = new Date('2024-05-01T12:00:00.000Z');

    it('uses a deterministic (timestamp, id) ordering', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({ address: ADDR, limit: 10, cursor: null });

      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('does not use skip when a cursor is supplied', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      const cursor = encodeEventsCursor({ timestamp: TS, id: 'evt_5' });
      await listEventsForWallet({ address: ADDR, limit: 10, cursor });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.skip).toBeUndefined();
      expect(callArgs.take).toBe(11);
    });

    it('applies a keyset where-clause for the cursor position', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      const cursor = encodeEventsCursor({ timestamp: TS, id: 'evt_5' });
      await listEventsForWallet({ address: ADDR, limit: 10, cursor });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.where.AND).toEqual([
        {
          OR: [
            { timestamp: { lt: TS } },
            { timestamp: TS, id: { lt: 'evt_5' } },
          ],
        },
      ]);
    });

    it('returns a nextCursor when more rows exist', async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({
        id: `evt_${i}`,
        timestamp: new Date(TS.getTime() - i * 1000),
      }));
      (prisma.streamEvent.findMany as any).mockResolvedValue(rows);
      (prisma.streamEvent.count as any).mockResolvedValue(50);

      const result = await listEventsForWallet({ address: ADDR, limit: 10, cursor: null });

      expect(result.items).toHaveLength(10);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe(
        encodeEventsCursor({ timestamp: rows[9].timestamp, id: rows[9].id }),
      );
    });

    it('returns nextCursor null on the last page', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        id: `evt_${i}`,
        timestamp: new Date(TS.getTime() - i * 1000),
      }));
      (prisma.streamEvent.findMany as any).mockResolvedValue(rows);
      (prisma.streamEvent.count as any).mockResolvedValue(3);

      const result = await listEventsForWallet({ address: ADDR, limit: 10, cursor: null });

      expect(result.items).toHaveLength(3);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('returns an empty page with nextCursor null when no rows match', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      const result = await listEventsForWallet({ address: ADDR, limit: 10, cursor: null });

      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it('treats a malformed cursor as the start of the list', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      const result = await listEventsForWallet({
        address: ADDR,
        limit: 10,
        cursor: 'not-a-cursor',
      });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.where.AND).toBeUndefined();
      expect(result.nextCursor).toBeNull();
    });

    it('treats an expired cursor as the start of the list', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      const expired = encodeEventsCursor({
        timestamp: TS,
        id: 'evt_5',
        expiresAt: new Date(Date.now() - 1000),
      });
      const result = await listEventsForWallet({ address: ADDR, limit: 10, cursor: expired });

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.where.AND).toBeUndefined();
      expect(result.nextCursor).toBeNull();
    });

    it('does not skip or duplicate rows across page boundaries with equal timestamps', async () => {
      // Three events share the same timestamp; ordering must fall back to id.
      const all = [
        { id: 'evt_c', timestamp: TS },
        { id: 'evt_b', timestamp: TS },
        { id: 'evt_a', timestamp: TS },
        { id: 'evt_z', timestamp: new Date(TS.getTime() - 1000) },
      ];

      const page = (cursor: string | null) => {
        const decoded = cursor ? decodeEventsCursor(cursor) : null;
        let filtered = all;
        if (decoded) {
          filtered = all.filter(
            (r) =>
              r.timestamp < decoded.timestamp ||
              (r.timestamp.getTime() === decoded.timestamp.getTime() &&
                r.id < decoded.id),
          );
        }
        return filtered.slice(0, 2);
      };

      (prisma.streamEvent.count as any).mockResolvedValue(all.length);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const rows = page(cursor);
        (prisma.streamEvent.findMany as any).mockResolvedValueOnce(rows);
        const result = await listEventsForWallet({ address: ADDR, limit: 2, cursor });
        seen.push(...result.items.map((r: any) => r.id));
        cursor = result.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toEqual(['evt_c', 'evt_b', 'evt_a', 'evt_z']);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('remains stable when new rows are inserted between pages', async () => {
      const older = [
        { id: 'evt_3', timestamp: new Date(TS.getTime() - 3000) },
        { id: 'evt_2', timestamp: new Date(TS.getTime() - 2000) },
      ];
      const firstPage = [
        { id: 'evt_5', timestamp: new Date(TS.getTime() - 1000) },
        { id: 'evt_4', timestamp: new Date(TS.getTime() - 1500) },
      ];

      (prisma.streamEvent.count as any).mockResolvedValue(4);
      (prisma.streamEvent.findMany as any).mockResolvedValueOnce(firstPage);

      const page1 = await listEventsForWallet({ address: ADDR, limit: 2, cursor: null });
      expect(page1.items.map((r: any) => r.id)).toEqual(['evt_5', 'evt_4']);

      // A concurrent insert lands at the head of the list; keyset pagination
      // must ignore it because it sorts before the cursor position.
      (prisma.streamEvent.findMany as any).mockResolvedValueOnce(older);
      const page2 = await listEventsForWallet({
        address: ADDR,
        limit: 2,
        cursor: page1.nextCursor,
      });

      expect(page2.items.map((r: any) => r.id)).toEqual(['evt_3', 'evt_2']);
      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[1][0];
      expect(callArgs.where.AND).toBeDefined();
    });
  });
});
