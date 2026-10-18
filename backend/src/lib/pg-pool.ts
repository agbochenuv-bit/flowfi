import pg from 'pg';
import logger from '../logger.js';
import {
  dbPoolConnections,
  dbPoolMaxConnections,
  dbQueryDuration,
  dbPoolAcquireDuration,
  registerDbPoolStatsProvider,
} from './metrics.js';

const parsePositiveIntegerEnv = (name: string, defaultValue: number): number => {
  const rawValue = process.env[name];

  if (!rawValue) return defaultValue;

  const parsedValue = Number.parseInt(rawValue, 10);

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
};

export interface ConnectionBudgetInputs {
  maxServerConnections: number;
  reservedConnections?: number;
  apiReplicas: number;
  workerReplicas: number;
  apiWorkerSplitRatio?: number;
}

export interface ConnectionBudgetResult {
  totalAvailable: number;
  apiPoolMax: number;
  workerPoolMax: number;
  totalAllocated: number;
}

/**
 * Calculates safe per-replica PostgreSQL connection pool budgets across API and worker instances.
 * Ensures the aggregate connections across all replicas remain strictly within Postgres server limits.
 */
export function calculateConnectionBudget(inputs: ConnectionBudgetInputs): ConnectionBudgetResult {
  const reserved = inputs.reservedConnections ?? 5;
  const available = Math.max(1, inputs.maxServerConnections - reserved);
  const apiRatio = inputs.apiWorkerSplitRatio ?? 0.7;

  const apiTotal = Math.floor(available * apiRatio);
  const workerTotal = available - apiTotal;

  const apiPoolMax = Math.max(1, Math.floor(apiTotal / Math.max(1, inputs.apiReplicas)));
  const workerPoolMax = Math.max(1, Math.floor(workerTotal / Math.max(1, inputs.workerReplicas)));

  return {
    totalAvailable: available,
    apiPoolMax,
    workerPoolMax,
    totalAllocated: apiPoolMax * Math.max(1, inputs.apiReplicas) + workerPoolMax * Math.max(1, inputs.workerReplicas),
  };
}

export const createPgPoolConfig = (overrides?: Partial<pg.PoolConfig>): pg.PoolConfig => {
  let defaultMax = parsePositiveIntegerEnv('PG_POOL_MAX', 10);

  // If server-wide budget calculation is configured via environment variables, compute replica-specific max
  if (process.env.PG_MAX_SERVER_CONNECTIONS) {
    const budget = calculateConnectionBudget({
      maxServerConnections: parsePositiveIntegerEnv('PG_MAX_SERVER_CONNECTIONS', 100),
      reservedConnections: parsePositiveIntegerEnv('PG_RESERVED_CONNECTIONS', 5),
      apiReplicas: parsePositiveIntegerEnv('API_REPLICAS', 2),
      workerReplicas: parsePositiveIntegerEnv('WORKER_REPLICAS', 2),
    });

    const role = process.env.SERVICE_ROLE || 'api';
    defaultMax = role === 'worker' ? budget.workerPoolMax : budget.apiPoolMax;
  }

  return {
    connectionString: process.env.DATABASE_URL,
    max: defaultMax,
    idleTimeoutMillis: parsePositiveIntegerEnv('PG_IDLE_TIMEOUT_MS', 30_000),
    connectionTimeoutMillis: parsePositiveIntegerEnv('PG_CONNECTION_TIMEOUT_MS', 5_000),
    statement_timeout: parsePositiveIntegerEnv('PG_STATEMENT_TIMEOUT_MS', 30_000),
    ...overrides,
  };
};


/**
 * Snapshot of the pool counts, in the shape the admin API and the Prometheus
 * gauges consume.
 *
 * `waitingCount` is the number to alert on: a non-zero value means callers are
 * queued for a connection, which surfaces as request latency long before the
 * pool would be considered "full".
 */
export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export function getPoolMetrics(pool: pg.Pool): PoolMetrics {
  return {
    totalCount: pool.totalCount ?? 0,
    idleCount: pool.idleCount ?? 0,
    waitingCount: pool.waitingCount ?? 0,
  };
}

/**
 * Publish the legacy labelled `flowfi_db_pool_connections{state=…}` gauge.
 *
 * The three per-state gauges (`flowfi_db_pool_*_connections`) are sampled at
 * scrape time instead; this helper keeps the older aggregate series populated
 * for dashboards/alerts that were built against it before the split.
 */
export function publishPoolMetrics(pool: pg.Pool): void {
  const { totalCount, idleCount, waitingCount } = getPoolMetrics(pool);
  dbPoolConnections.set({ state: 'total' }, totalCount);
  dbPoolConnections.set({ state: 'idle' }, idleCount);
  dbPoolConnections.set({ state: 'waiting' }, waitingCount);
  dbPoolMaxConnections.set(pool.options?.max ?? 0);
}

/**
 * Reduce a SQL statement to a low-cardinality operation label.
 *
 * Raw SQL would be a terrible Prometheus label (one series per query, ever), so
 * statements are bucketed by verb and target table.
 */
export function labelForQuery(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const verb = /^([a-z]+)/i.exec(normalized)?.[1]?.toUpperCase() ?? 'OTHER';

  const target =
    /(?:\bfrom\b|\binto\b|\bupdate\b|\btable\b)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(
      normalized,
    )?.[1] ?? '';

  return target ? `${verb}:${target}` : verb;
}

/**
 * Time every query issued through the pool.
 *
 * Prisma's driver-adapter setup does not emit query events, so the pool is the
 * only reliable measurement point — and it captures queue wait time as well as
 * execution, which is what an operator needs to attribute latency to.
 */
export function instrumentPoolQueryTiming(pool: pg.Pool): void {
  const original = pool.query?.bind(pool) as
    | ((...args: unknown[]) => unknown)
    | undefined;
  if (typeof original !== 'function') return;

  pool.query = ((...args: unknown[]) => {
    const startedAt = process.hrtime.bigint();
    const operation = labelForQuery(
      typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? ''),
    );

    const record = () => {
      dbQueryDuration.observe({ operation }, Number(process.hrtime.bigint() - startedAt) / 1e9);
    };

    let result: unknown;
    try {
      result = original(...args);
    } catch (err) {
      record();
      throw err;
    }

    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).then(
        (value) => {
          record();
          return value;
        },
        (err: unknown) => {
          record();
          throw err;
        },
      );
    }

    record();
    return result;
  }) as typeof pool.query;
}

export function instrumentPoolAcquireTiming(pool: pg.Pool): void {
  const originalConnect = pool.connect?.bind(pool);
  if (typeof originalConnect !== 'function') return;

  pool.connect = ((...args: unknown[]) => {
    const startedAt = process.hrtime.bigint();
    const callback = typeof args[0] === 'function' ? (args[0] as (...cbArgs: unknown[]) => void) : undefined;

    if (callback) {
      return (originalConnect as any)((err: unknown, client: unknown, done: unknown) => {
        const duration = Number(process.hrtime.bigint() - startedAt) / 1e9;
        dbPoolAcquireDuration.observe(duration);
        callback(err, client, done);
      });
    }

    const connectPromise = (originalConnect as () => Promise<pg.PoolClient>)();
    if (connectPromise && typeof connectPromise.then === 'function') {
      return connectPromise.then(
        (client) => {
          const duration = Number(process.hrtime.bigint() - startedAt) / 1e9;
          dbPoolAcquireDuration.observe(duration);
          return client;
        },
        (err) => {
          const duration = Number(process.hrtime.bigint() - startedAt) / 1e9;
          dbPoolAcquireDuration.observe(duration);
          throw err;
        },
      );
    }

    return connectPromise;
  }) as typeof pool.connect;
}

const POOL_METRICS_INTERVAL_MS = Number(
  process.env.PG_POOL_METRICS_INTERVAL_MS ?? 5_000,
);

export const createPgPool = (overrides?: Partial<pg.PoolConfig>): pg.Pool => {
  const pool = new pg.Pool(createPgPoolConfig(overrides));

  instrumentPoolQueryTiming(pool);
  instrumentPoolAcquireTiming(pool);

  // Scrape-time sampling: the dedicated pool gauges read the live counts via
  // the registered provider on every `/metrics` request, so the scrape always
  // reflects the pool at that instant (no stale interval-sampled values).
  registerDbPoolStatsProvider(() => {
    const { totalCount, idleCount, waitingCount } = getPoolMetrics(pool);
    return { total: totalCount, idle: idleCount, waiting: waitingCount };
  });

  // `totalCount`/`idleCount`/`waitingCount` are mutated only by pg itself, so a
  // low-frequency sampler keeps the legacy labelled gauge fresh without adding
  // per-query overhead. `unref` keeps the timer from holding the process open.
  const sampler = setInterval(() => publishPoolMetrics(pool), POOL_METRICS_INTERVAL_MS);
  sampler.unref?.();

  publishPoolMetrics(pool);

  return pool;
};


export interface DrainPgPoolOptions {
  /**
   * Maximum time to wait for in-flight queries to flush before giving up.
   * Defaults to `PG_POOL_DRAIN_TIMEOUT_MS`, falling back to 30s so a wedged
   * query can never hold container teardown open indefinitely.
   */
  timeoutMs?: number;
}

/**
 * Gracefully drain a pg pool during process shutdown (SIGTERM/SIGINT).
 *
 * `pool.end()` closes every idle client immediately and waits for clients with
 * in-flight queries to finish before closing them, which prevents abruptly
 * killed containers from leaving dangling connections for Postgres to reap via
 * server-side keepalives. The wait is bounded: on timeout the promise rejects
 * and callers should still force-exit so the process cannot hang.
 *
 * Rejects (rather than swallowing) when `pool.end()` itself fails or the
 * timeout elapses, so shutdown exit codes can reflect the failure.
 */
export async function drainPgPool(pool: pg.Pool, options: DrainPgPoolOptions = {}): Promise<void> {
  const timeoutMs =
    options.timeoutMs ?? parsePositiveIntegerEnv('PG_POOL_DRAIN_TIMEOUT_MS', 30_000);

  logger.info('Draining database pool...');

  await Promise.race([
    pool.end(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`pg pool drain timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  logger.info('Database pool drained.');
}
