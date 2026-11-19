import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  createExportJob,
  processExportJob,
  getExportJob,
  cancelExportJob,
  expireExportJobs,
  downloadExportJob,
  resetExportJobsForTests,
} from '../src/services/exportJobs';
import {
  buildActivityExport,
  serializeActivityExportCsv,
  parseActivityExportCsv,
  serializeActivityExportJson,
  parseActivityExportJson,
  ACTIVITY_EXPORT_COLUMNS,
  type ActivityExportRow,
} from '../src/services/activityExport';
import {
  createCostBudgetMiddleware,
  COST_BUDGET_EXCEEDED,
  resetCostBudgetsForTests,
} from '../src/middleware/costBudget';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OWNER = 'GOWNERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const NETWORK = 'testnet';

interface FakeEvent {
  id: string;
  wallet: string;
  kind: 'stream_created' | 'stream_cancelled' | 'payment';
  amount: string;
  asset: string;
  txRef: string;
  ledger: number;
  createdAt: string;
}

function makeEvent(overrides: Partial<FakeEvent> & { id: string }): FakeEvent {
  return {
    wallet: OWNER,
    kind: 'payment',
    amount: '10000000',
    asset: 'XLM',
    txRef: `tx-${overrides.id}`,
    ledger: 1000,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvents(count: number, wallet = OWNER): FakeEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent({
      id: `evt-${String(i).padStart(4, '0')}`,
      wallet,
      ledger: 1000 + i,
      createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
    }),
  );
}

// ---------------------------------------------------------------------------
// (a) Snapshot consistency across multiple pages
// ---------------------------------------------------------------------------

describe('export job snapshot consistency', () => {
  beforeEach(() => {
    resetExportJobsForTests();
  });

  it('captures a snapshot at creation and excludes events arriving mid-export', async () => {
    const initial = makeEvents(25);
    const store = new Map(initial.map((e) => [e.id, e]));

    const job = await createExportJob({
      owner: OWNER,
      network: NETWORK,
      kind: 'activity',
      pageSize: 10,
      loadEvents: async () => Array.from(store.values()),
    });

    expect(job.status).toBe('queued');
    expect(job.snapshotEventIds).toHaveLength(25);

    // Events arriving after the snapshot must not appear in the export.
    store.set('evt-late-1', makeEvent({ id: 'evt-late-1', ledger: 9999 }));
    store.set('evt-late-2', makeEvent({ id: 'evt-late-2', ledger: 10000 }));

    let pages = 0;
    let result = await processExportJob(job.id, {
      loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!).filter(Boolean),
    });
    pages += 1;

    while (result.status === 'running') {
      result = await processExportJob(job.id, {
        loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!).filter(Boolean),
      });
      pages += 1;
      expect(pages).toBeLessThan(20);
    }

    expect(result.status).toBe('completed');
    expect(pages).toBeGreaterThan(1);

    const final = await getExportJob(job.id, { principal: OWNER });
    expect(final.status).toBe('completed');
    const ids = final.rows.map((r) => r.eventId);
    expect(ids).toHaveLength(25);
    expect(ids).not.toContain('evt-late-1');
    expect(ids).not.toContain('evt-late-2');
    // Snapshot order is preserved.
    expect(ids).toEqual(initial.map((e) => e.id));
  });
});

// ---------------------------------------------------------------------------
// (b) Idempotent retries resuming from persisted cursor
// ---------------------------------------------------------------------------

describe('export job retries', () => {
  beforeEach(() => {
    resetExportJobsForTests();
  });

  it('resumes from the persisted cursor and is idempotent across retries', async () => {
    const events = makeEvents(15);
    const store = new Map(events.map((e) => [e.id, e]));

    const job = await createExportJob({
      owner: OWNER,
      network: NETWORK,
      kind: 'activity',
      pageSize: 5,
      loadEvents: async () => Array.from(store.values()),
    });

    const first = await processExportJob(job.id, {
      loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!),
    });
    expect(first.status).toBe('running');
    expect(first.cursor).toBe(5);

    // Re-running the same page (simulating a retry) must not duplicate rows.
    const retrySame = await processExportJob(job.id, {
      loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!),
      forceCursor: 0,
    });
    expect(retrySame.cursor).toBe(5);
    expect(retrySame.rows).toHaveLength(5);

    let result = retrySame;
    while (result.status === 'running') {
      result = await processExportJob(job.id, {
        loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!),
      });
    }
    expect(result.status).toBe('completed');

    // A completed job is a no-op on further processing.
    const again = await processExportJob(job.id, {
      loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!),
    });
    expect(again.status).toBe('completed');
    expect(again.rows).toHaveLength(15);

    const final = await getExportJob(job.id, { principal: OWNER });
    const ids = final.rows.map((r) => r.eventId);
    expect(ids).toHaveLength(15);
    expect(new Set(ids).size).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// (c) Ownership checks
// ---------------------------------------------------------------------------

describe('export job ownership', () => {
  beforeEach(() => {
    resetExportJobsForTests();
  });

  it('rejects status, download, and cancel for a different principal', async () => {
    const events = makeEvents(3);
    const store = new Map(events.map((e) => [e.id, e]));

    const job = await createExportJob({
      owner: OWNER,
      network: NETWORK,
      kind: 'activity',
      pageSize: 10,
      loadEvents: async () => Array.from(store.values()),
    });

    await expect(getExportJob(job.id, { principal: OTHER })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      downloadExportJob(job.id, { principal: OTHER }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      cancelExportJob(job.id, { principal: OTHER }),
    ).rejects.toMatchObject({ status: 403 });

    // Unknown job id yields 404.
    await expect(getExportJob('does-not-exist', { principal: OWNER })).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ---------------------------------------------------------------------------
// (d) Expiry
// ---------------------------------------------------------------------------

describe('export job expiry', () => {
  beforeEach(() => {
    resetExportJobsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks the job expired and download returns 410', async () => {
    const events = makeEvents(2);
    const store = new Map(events.map((e) => [e.id, e]));

    const job = await createExportJob({
      owner: OWNER,
      network: NETWORK,
      kind: 'activity',
      pageSize: 10,
      ttlMs: 60_000,
      loadEvents: async () => Array.from(store.values()),
    });

    vi.advanceTimersByTime(61_000);
    await expireExportJobs();

    const expired = await getExportJob(job.id, { principal: OWNER });
    expect(expired.status).toBe('expired');

    await expect(
      downloadExportJob(job.id, { principal: OWNER }),
    ).rejects.toMatchObject({ status: 410 });
  });
});

// ---------------------------------------------------------------------------
// (e) Cancellation
// ---------------------------------------------------------------------------

describe('export job cancellation', () => {
  beforeEach(() => {
    resetExportJobsForTests();
  });

  it('transitions queued to cancelled and rejects download', async () => {
    const events = makeEvents(4);
    const store = new Map(events.map((e) => [e.id, e]));

    const job = await createExportJob({
      owner: OWNER,
      network: NETWORK,
      kind: 'activity',
      pageSize: 10,
      loadEvents: async () => Array.from(store.values()),
    });

    const cancelled = await cancelExportJob(job.id, { principal: OWNER });
    expect(cancelled.status).toBe('cancelled');

    await expect(
      downloadExportJob(job.id, { principal: OWNER }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('transitions running to cancelled and stops further processing', async () => {
    const events = makeEvents(10);
    const store = new Map(events.map((e) => [e.id, e]));

    const job = await createExportJob({
      owner: OWNER,
      network: NETWORK,
      kind: 'activity',
      pageSize: 3,
      loadEvents: async () => Array.from(store.values()),
    });

    const running = await processExportJob(job.id, {
      loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!),
    });
    expect(running.status).toBe('running');

    const cancelled = await cancelExportJob(job.id, { principal: OWNER });
    expect(cancelled.status).toBe('cancelled');

    const after = await processExportJob(job.id, {
      loadEventsByIds: async (ids) => ids.map((id) => store.get(id)!),
    });
    expect(after.status).toBe('cancelled');

    await expect(
      downloadExportJob(job.id, { principal: OWNER }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// (f) Accounting export round-trip
// ---------------------------------------------------------------------------

describe('accounting export round-trip', () => {
  const rows: ActivityExportRow[] = [
    {
      eventId: 'evt-1',
      wallet: OWNER,
      network: NETWORK,
      kind: 'stream_created',
      amount: '10000000',
      asset: 'XLM',
      txRef: 'tx-abc',
      ledger: 1000,
      timestamp: '2024-01-01T00:00:00.000Z',
    },
    {
      eventId: 'evt-2',
      wallet: OWNER,
      network: NETWORK,
      kind: 'payment',
      amount: '2500000',
      asset: 'USDC:GISSUER',
      txRef: 'tx-def',
      ledger: 1001,
      timestamp: '2024-01-02T12:34:56.789Z',
    },
  ];

  it('round-trips CSV with explicit units, network, tx refs, and UTC timestamps', () => {
    const csv = serializeActivityExportCsv(rows);
    const header = csv.split('\n')[0];
    expect(header).toBe(ACTIVITY_EXPORT_COLUMNS.join(','));

    const parsed = parseActivityExportCsv(csv);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(rows[0]);
    expect(parsed[1]).toEqual(rows[1]);
    // Timestamps remain UTC ISO-8601.
    expect(parsed[1].timestamp.endsWith('Z')).toBe(true);
    // Amounts are integer stroops (explicit units).
    expect(parsed[1].amount).toBe('2500000');
    expect(parsed[1].network).toBe(NETWORK);
    expect(parsed[1].txRef).toBe('tx-def');
  });

  it('round-trips JSON with the same schema', () => {
    const json = serializeActivityExportJson(rows);
    const parsed = parseActivityExportJson(json);
    expect(parsed).toEqual(rows);
  });

  it('builds an export from events with explicit units and network id', () => {
    const events = makeEvents(2);
    const built = buildActivityExport(events, { network: NETWORK });
    expect(built).toHaveLength(2);
    for (const row of built) {
      expect(row.network).toBe(NETWORK);
      expect(row.amount).toMatch(/^\d+$/);
      expect(row.timestamp.endsWith('Z')).toBe(true);
      expect(row.txRef).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// (g) Large-result limit boundary
// ---------------------------------------------------------------------------

describe('activity export large-result limits', () => {
  it('accepts exactly the max row count', () => {
    const events = makeEvents(1000);
    const built = buildActivityExport(events, { network: NETWORK, maxRows: 1000 });
    expect(built).toHaveLength(1000);
  });

  it('rejects one row over the max', () => {
    const events = makeEvents(1001);
    expect(() =>
      buildActivityExport(events, { network: NETWORK, maxRows: 1000 }),
    ).toThrowError(/limit/i);
  });
});

// ---------------------------------------------------------------------------
// (h) Non-owned data excluded
// ---------------------------------------------------------------------------

describe('activity export ownership filtering', () => {
  it('excludes events belonging to other wallets', () => {
    const owned = makeEvents(3, OWNER);
    const foreign = makeEvents(2, OTHER).map((e, i) => ({
      ...e,
      id: `foreign-${i}`,
    }));
    const built = buildActivityExport([...owned, ...foreign], {
      network: NETWORK,
      owner: OWNER,
    });
    expect(built).toHaveLength(3);
    for (const row of built) {
      expect(row.wallet).toBe(OWNER);
    }
  });
});

// ---------------------------------------------------------------------------
// (i) Cost budget boundary
// ---------------------------------------------------------------------------

describe('cost budget middleware', () => {
  beforeEach(() => {
    resetCostBudgetsForTests();
  });

  function makeApp() {
    const app = express();
    app.use(
      createCostBudgetMiddleware({
        routeCosts: {
          'GET /analytics': 10,
          'GET /exports': 25,
          'GET /cheap': 1,
        },
        windowMs: 60_000,
        maxCost: 50,
      }),
    );
    app.get('/analytics', (_req, res) => res.json({ ok: true }));
    app.get('/exports', (_req, res) => res.json({ ok: true }));
    app.get('/cheap', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('returns 429 with COST_BUDGET_EXCEEDED at the boundary', async () => {
    const app = makeApp();
    // 2 x 25 = 50 (exactly at budget) -> allowed.
    await request(app).get('/exports').expect(200);
    await request(app).get('/exports').expect(200);
    // Next request exceeds budget.
    const res = await request(app).get('/exports').expect(429);
    expect(res.body.code).toBe(COST_BUDGET_EXCEEDED);
  });

  it('leaves cheap requests unaffected', async () => {
    const app = makeApp();
    for (let i = 0; i < 20; i += 1) {
      await request(app).get('/cheap').expect(200);
    }
  });

  it('applies per-route cost units independently', async () => {
    const app = makeApp();
    // 5 x 10 = 50 -> allowed.
    for (let i = 0; i < 5; i += 1) {
      await request(app).get('/analytics').expect(200);
    }
    const res = await request(app).get('/analytics').expect(429);
    expect(res.body.code).toBe(COST_BUDGET_EXCEEDED);
  });
});