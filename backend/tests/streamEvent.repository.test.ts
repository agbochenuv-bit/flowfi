import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listEventsForWallet,
  parseEventTypeFilter,
  resolveEventsOffset,
  resolveEventsPageSize,
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
});
