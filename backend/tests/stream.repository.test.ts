import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the database module before importing the repository.
jest.mock('../src/db', () => {
  const state = {
    streams: new Map<string, any>(),
  };

  const makeQuery = () => {
    let filters: Record<string, any> = {};
    let updatePayload: Record<string, any> | null = null;
    let isUpdate = false;

    const matches = (row: any) => {
      return Object.entries(filters).every(([key, value]) => row[key] === value);
    };

    const query: any = {
      where: (cond: Record<string, any>) => {
        filters = { ...filters, ...cond };
        return query;
      },
      first: async () => {
        for (const row of state.streams.values()) {
          if (matches(row)) {
            return { ...row };
          }
        }
        return undefined;
      },
      update: async (payload: Record<string, any>) => {
        isUpdate = true;
        updatePayload = payload;
        let count = 0;
        for (const [id, row] of state.streams.entries()) {
          if (matches(row)) {
            state.streams.set(id, { ...row, ...payload });
            count += 1;
          }
        }
        return count;
      },
      insert: async (payload: Record<string, any>) => {
        const id = payload.id ?? `stream-${state.streams.size + 1}`;
        state.streams.set(id, { ...payload, id });
        return [id];
      },
      del: async () => {
        let count = 0;
        for (const [id, row] of state.streams.entries()) {
          if (matches(row)) {
            state.streams.delete(id);
            count += 1;
          }
        }
        return count;
      },
      then: (resolve: any, reject: any) => {
        if (isUpdate && updatePayload) {
          let count = 0;
          for (const [id, row] of state.streams.entries()) {
            if (matches(row)) {
              state.streams.set(id, { ...row, ...updatePayload });
              count += 1;
            }
          }
          return Promise.resolve(count).then(resolve, reject);
        }
        const rows: any[] = [];
        for (const row of state.streams.values()) {
          if (matches(row)) {
            rows.push({ ...row });
          }
        }
        return Promise.resolve(rows).then(resolve, reject);
      },
    };

    return query;
  };

  const db = (table: string) => {
    if (table !== 'streams') {
      throw new Error(`Unexpected table: ${table}`);
    }
    return makeQuery();
  };

  return {
    __esModule: true,
    default: db,
    db,
    __state: state,
  };
});

import * as dbModule from '../src/db';
import {
  createStream,
  getStreamById,
  compareAndSetStreamVersion,
} from '../src/repositories/stream.repository';

const mockState = (dbModule as any).__state as { streams: Map<string, any> };

describe('stream.repository compare-and-set', () => {
  beforeEach(() => {
    mockState.streams.clear();
  });

  it('bumps the version when the expected version matches', async () => {
    const created = await createStream({
      id: 'stream-1',
      ownerId: 'wallet-owner',
      version: 1,
      status: 'active',
    } as any);

    const streamId = (created as any).id ?? 'stream-1';

    const result = await compareAndSetStreamVersion(streamId, 1, {
      status: 'paused',
    });

    expect(result).toBe(true);

    const updated = await getStreamById(streamId);
    expect(updated).toBeDefined();
    expect(updated!.version).toBe(2);
    expect(updated!.status).toBe('paused');
  });

  it('returns false and does not mutate when the expected version mismatches', async () => {
    const created = await createStream({
      id: 'stream-2',
      ownerId: 'wallet-owner',
      version: 3,
      status: 'active',
    } as any);

    const streamId = (created as any).id ?? 'stream-2';

    const result = await compareAndSetStreamVersion(streamId, 1, {
      status: 'paused',
    });

    expect(result).toBe(false);

    const unchanged = await getStreamById(streamId);
    expect(unchanged).toBeDefined();
    expect(unchanged!.version).toBe(3);
    expect(unchanged!.status).toBe('active');
  });

  it('returns false when the stream does not exist', async () => {
    const result = await compareAndSetStreamVersion('missing-stream', 1, {
      status: 'paused',
    });

    expect(result).toBe(false);
    expect(mockState.streams.size).toBe(0);
  });

  it('allows only one of two concurrent updates to succeed', async () => {
    const created = await createStream({
      id: 'stream-3',
      ownerId: 'wallet-owner',
      version: 5,
      status: 'active',
    } as any);

    const streamId = (created as any).id ?? 'stream-3';

    const [first, second] = await Promise.all([
      compareAndSetStreamVersion(streamId, 5, { status: 'paused' }),
      compareAndSetStreamVersion(streamId, 5, { status: 'cancelled' }),
    ]);

    const successes = [first, second].filter(Boolean);
    expect(successes).toHaveLength(1);

    const finalState = await getStreamById(streamId);
    expect(finalState).toBeDefined();
    expect(finalState!.version).toBe(6);

    // The winning update determines the final status; the loser must not apply.
    const winningStatus = first ? 'paused' : 'cancelled';
    expect(finalState!.status).toBe(winningStatus);
  });

  it('does not apply a stale update after a successful bump', async () => {
    const created = await createStream({
      id: 'stream-4',
      ownerId: 'wallet-owner',
      version: 2,
      status: 'active',
    } as any);

    const streamId = (created as any).id ?? 'stream-4';

    const first = await compareAndSetStreamVersion(streamId, 2, {
      status: 'paused',
    });
    expect(first).toBe(true);

    const stale = await compareAndSetStreamVersion(streamId, 2, {
      status: 'cancelled',
    });
    expect(stale).toBe(false);

    const finalState = await getStreamById(streamId);
    expect(finalState!.version).toBe(3);
    expect(finalState!.status).toBe('paused');
  });
});