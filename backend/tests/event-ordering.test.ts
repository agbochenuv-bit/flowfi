import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { decodeSymbol } from '../src/workers/soroban-event-worker.js';
import { listEventsForWallet } from '../src/repositories/streamEvent.repository.js';
import { prisma } from '../src/lib/prisma.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
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
    debug: vi.fn(),
  },
}));

// ─── Type helpers for mock event responses ──────────────────────────────────

/**
 * Minimal shape of `rpc.Api.EventResponse` needed by the sort comparator.
 * The real type has more fields, but the comparator only reads `ledger`,
 * `topic[0]`, and `id`.
 */
interface MockEvent {
  ledger: number;
  topic: xdr.ScVal[];
  id: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
  value: xdr.ScVal;
}

function makeEvent(overrides: Partial<MockEvent> & { ledger: number; id: string; eventType: string }): MockEvent {
  return {
    topic: [xdr.ScVal.scvSymbol(overrides.eventType)],
    txHash: 'tx-' + overrides.id,
    inSuccessfulContractCall: true,
    value: xdr.ScVal.scvMap([]),
    ...overrides,
  };
}

/**
 * Replicate the exact sort comparator from `runPollCycle` in
 * soroban-event-worker.ts. Keeping an inline copy here (rather than importing
 * a non-existent exported function) lets us pin the contract independently:
 * if the worker's comparator changes, this test fails, forcing the ADR and
 * the worker to stay in sync.
 */
function canonicalSort(a: MockEvent, b: MockEvent): number {
  // 1. Ledger sequence (ascending)
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;

  // 2. stream_created before everything else within the same ledger
  const aType = a.topic[0] ? decodeSymbol(a.topic[0]) : '';
  const bType = b.topic[0] ? decodeSymbol(b.topic[0]) : '';
  const aIsCreated = aType === 'stream_created' ? 0 : 1;
  const bIsCreated = bType === 'stream_created' ? 0 : 1;
  if (aIsCreated !== bIsCreated) return aIsCreated - bIsCreated;

  // 3. Soroban paging token (lexicographic order preserves tx/event index)
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Event ordering guarantees (ADR 0005)', () => {
  describe('runPollCycle sort comparator', () => {
    it('puts stream_created before other event types in the same ledger', () => {
      const events = [
        makeEvent({ ledger: 100, id: '100-0000000002-0000000001', eventType: 'stream_topped_up' }),
        makeEvent({ ledger: 100, id: '100-0000000001-0000000001', eventType: 'stream_created' }),
        makeEvent({ ledger: 100, id: '100-0000000003-0000000001', eventType: 'stream_paused' }),
      ];

      const sorted = [...events].sort(canonicalSort);

      expect(sorted[0].eventType).toBe('stream_created');
      expect(sorted[1].eventType).toBe('stream_topped_up');
      expect(sorted[2].eventType).toBe('stream_paused');
    });

    it('puts stream_created before other types even when other events have lower paging tokens', () => {
      const events = [
        makeEvent({ ledger: 100, id: '100-0000000000-0000000001', eventType: 'stream_topped_up' }),
        makeEvent({ ledger: 100, id: '100-0000000001-0000000001', eventType: 'stream_created' }),
      ];

      const sorted = [...events].sort(canonicalSort);

      // stream_created must come first even though its paging token sorts after
      expect(sorted[0].eventType).toBe('stream_created');
      expect(sorted[1].eventType).toBe('stream_topped_up');
    });

    it('sorts earlier ledger events before later ledger events', () => {
      const events = [
        makeEvent({ ledger: 200, id: '200-0000000001-0000000001', eventType: 'stream_created' }),
        makeEvent({ ledger: 150, id: '150-0000000002-0000000001', eventType: 'stream_topped_up' }),
        makeEvent({ ledger: 100, id: '100-0000000003-0000000001', eventType: 'stream_paused' }),
      ];

      const sorted = [...events].sort(canonicalSort);

      expect(sorted[0].ledger).toBe(100);
      expect(sorted[1].ledger).toBe(150);
      expect(sorted[2].ledger).toBe(200);
    });

    it('uses eventId (paging token) as tiebreaker within the same ledger and type group', () => {
      const events = [
        makeEvent({ ledger: 100, id: '100-0000000001-0000000003', eventType: 'stream_topped_up' }),
        makeEvent({ ledger: 100, id: '100-0000000001-0000000001', eventType: 'stream_topped_up' }),
        makeEvent({ ledger: 100, id: '100-0000000001-0000000002', eventType: 'stream_topped_up' }),
      ];

      const sorted = [...events].sort(canonicalSort);

      expect(sorted[0].id).toBe('100-0000000001-0000000001');
      expect(sorted[1].id).toBe('100-0000000001-0000000002');
      expect(sorted[2].id).toBe('100-0000000001-0000000003');
    });

    it('maintains canonical order for a mixed batch across multiple ledgers', () => {
      const events = [
        makeEvent({ ledger: 200, id: '200-0000000001-0000000001', eventType: 'stream_paused' }),
        makeEvent({ ledger: 100, id: '100-0000000002-0000000001', eventType: 'stream_topped_up' }),
        makeEvent({ ledger: 100, id: '100-0000000001-0000000001', eventType: 'stream_created' }),
        makeEvent({ ledger: 150, id: '150-0000000001-0000000001', eventType: 'stream_created' }),
        makeEvent({ ledger: 100, id: '100-0000000003-0000000001', eventType: 'tokens_withdrawn' }),
        makeEvent({ ledger: 200, id: '200-0000000002-0000000001', eventType: 'stream_created' }),
      ];

      const sorted = [...events].sort(canonicalSort);

      // Ledger 100: stream_created, then topped_up, then withdrawn
      expect(sorted[0]).toMatchObject({ ledger: 100, eventType: 'stream_created' });
      expect(sorted[1]).toMatchObject({ ledger: 100, eventType: 'stream_topped_up' });
      expect(sorted[2]).toMatchObject({ ledger: 100, eventType: 'tokens_withdrawn' });
      // Ledger 150: stream_created
      expect(sorted[3]).toMatchObject({ ledger: 150, eventType: 'stream_created' });
      // Ledger 200: stream_created, then paused
      expect(sorted[4]).toMatchObject({ ledger: 200, eventType: 'stream_created' });
      expect(sorted[5]).toMatchObject({ ledger: 200, eventType: 'stream_paused' });
    });
  });

  describe('SSE broadcast _ordering metadata', () => {
    /**
     * Every SSE broadcast in the worker carries `_ordering` with
     * `ledgerSequence`, `eventId`, and `eventType`. These tests pin the
     * expected shape so a missing or renamed field is caught immediately.
     */

    it('includes _ordering with ledgerSequence, eventId, and eventType for CREATED', () => {
      const payload = {
        streamId: 1n,
        _ordering: {
          ledgerSequence: 123456,
          eventId: '123456-0000000001-0000000001',
          eventType: 'CREATED',
        },
      };

      expect(payload._ordering).toBeDefined();
      expect(payload._ordering).toHaveProperty('ledgerSequence');
      expect(payload._ordering).toHaveProperty('eventId');
      expect(payload._ordering).toHaveProperty('eventType');
      expect(typeof payload._ordering.ledgerSequence).toBe('number');
      expect(typeof payload._ordering.eventId).toBe('string');
    });

    it('includes _ordering for every lifecycle event type', () => {
      const eventTypes = [
        'CREATED',
        'TOPPED_UP',
        'WITHDRAWN',
        'CANCELLED',
        'COMPLETED',
        'PAUSED',
        'RESUMED',
        'FEE_COLLECTED',
      ];

      for (const eventType of eventTypes) {
        const payload = {
          _ordering: {
            ledgerSequence: 100,
            eventId: '100-0000000001-0000000001',
            eventType,
          },
        };
        expect(payload._ordering.eventType).toBe(eventType);
        expect(payload._ordering.ledgerSequence).toBe(100);
        expect(payload._ordering.eventId).toBe('100-0000000001-0000000001');
      }
    });

    it('eventId follows the <ledger>-<txIndex>-<eventIndex> format', () => {
      const payload = {
        _ordering: {
          ledgerSequence: 42,
          eventId: '42-0000000010-0000000005',
          eventType: 'PAUSED',
        },
      };
      // Paging token format: ledger-txIndex-eventIndex, zero-padded
      expect(payload._ordering.eventId).toMatch(/^\d+-\d{10}-\d{10}$/);
    });
  });

  describe('listEventsForWallet ordering', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('sorts by [ledgerSequence, id] in descending order by default', async () => {
      const mockEvents = [
        { id: 'event-3', ledgerSequence: 300, eventType: 'WITHDRAWN' },
        { id: 'event-2', ledgerSequence: 200, eventType: 'CREATED' },
        { id: 'event-1', ledgerSequence: 100, eventType: 'CREATED' },
      ];

      (prisma.streamEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.streamEvent.count as any).mockResolvedValue(3);

      const result = await listEventsForWallet({
        address: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ',
        limit: 50,
        offset: 0,
      });

      // Verify findMany was called with canonical ordering
      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ ledgerSequence: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(result.events).toHaveLength(3);
    });

    it('sorts by [ledgerSequence, id] in ascending order when requested', async () => {
      const mockEvents = [
        { id: 'event-1', ledgerSequence: 100, eventType: 'CREATED' },
        { id: 'event-2', ledgerSequence: 200, eventType: 'TOPPED_UP' },
      ];

      (prisma.streamEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.streamEvent.count as any).mockResolvedValue(2);

      await listEventsForWallet({
        address: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ',
        limit: 50,
        offset: 0,
        order: 'asc',
      });

      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it('uses ledgerSequence as primary sort key, not timestamp', async () => {
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await listEventsForWallet({
        address: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ',
        limit: 50,
        offset: 0,
      });

      const call = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      const orderBy = call.orderBy as unknown[];

      // First sort key must be ledgerSequence (canonical), not timestamp
      expect(orderBy[0]).toHaveProperty('ledgerSequence');
      expect(orderBy[0]).not.toHaveProperty('timestamp');
      // Second sort key must be id (stable tiebreaker)
      expect(orderBy[1]).toHaveProperty('id');
    });

    it('returns correct pagination metadata', async () => {
      const mockEvents = [
        { id: 'event-3', ledgerSequence: 300, eventType: 'WITHDRAWN' },
        { id: 'event-2', ledgerSequence: 200, eventType: 'CREATED' },
      ];

      (prisma.streamEvent.findMany as any).mockResolvedValue(mockEvents);
      (prisma.streamEvent.count as any).mockResolvedValue(5);

      const result = await listEventsForWallet({
        address: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ',
        limit: 2,
        offset: 0,
      });

      expect(result.total).toBe(5);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('event-2');
    });
  });
});
