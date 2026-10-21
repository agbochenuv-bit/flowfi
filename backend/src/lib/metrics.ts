import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus instrumentation for the FlowFi backend.
 *
 * Everything in this module is a no-op-safe singleton: importing it never
 * throws and never opens a socket, so it is safe to pull in from the worker,
 * the SSE service, and the HTTP layer alike. The registry is exposed via
 * `getMetricsRegistry()` and rendered by `GET /metrics`.
 *
 * Metric names are prefixed with `flowfi_` so a shared Prometheus instance can
 * scrape several services without collisions.
 *
 * Indexer observability metrics (all labels are bounded — never transaction
 * hashes, wallet addresses, or other unbounded identifiers):
 *
 * - `flowfi_indexer_current_ledger` (gauge, ledgers) — last ledger fully indexed.
 * - `flowfi_indexer_network_ledger` (gauge, ledgers) — network tip as last seen.
 * - `flowfi_indexer_lag_ledgers` (gauge, ledgers) — network tip minus current.
 * - `flowfi_indexer_events_per_ledger` (histogram, events/ledger) — events
 *   dispatched per processed ledger.
 * - `flowfi_indexer_decode_duration_seconds` (histogram, seconds) — time spent
 *   decoding a ledger's events; labels: `result` (success|error).
 * - `flowfi_indexer_persist_duration_seconds` (histogram, seconds) — time spent
 *   persisting a ledger's events; labels: `result` (success|error).
 * - `flowfi_indexer_retries_total` (counter, retries) — retry attempts issued
 *   by the worker; labels: `operation`, `outcome`.
 * - `flowfi_indexer_last_success_timestamp_seconds` (gauge, unix seconds) —
 *   wall-clock time of the last successful ledger commit.
 *
 * With multiple worker instances, aggregate with `max()` for lag/current-ledger
 * gauges and `sum()`/`rate()` for counters; histograms aggregate across
 * instances via `_sum`/`_count`.
 */

/** Default histogram buckets — tuned for both sub-millisecond DB hits and slow RPC calls. */
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const registry = new Registry();

/** Reserved `topic` label value carrying the aggregate connection count. */
export const TOTAL_SSE_TOPIC = 'total';

collectDefaultMetrics({
  register: registry,
  prefix: 'flowfi_process_',
});

// ─── Indexer lag ─────────────────────────────────────────────────────────────

/** Last ledger successfully written by the indexer. */
export const indexerCurrentLedger = new Gauge({
  name: 'flowfi_indexer_current_ledger',
  help: 'Last ledger sequence fully indexed by the Soroban event worker',
  registers: [registry],
});

/** Most recent ledger sequence observed on the network. */
export const indexerNetworkLedger = new Gauge({
  name: 'flowfi_indexer_network_ledger',
  help: 'Latest ledger sequence reported by the Stellar network',
  registers: [registry],
});

/** network - current. Kept as its own gauge so alerts do not need arithmetic. */
export const indexerLagLedgers = new Gauge({
  name: 'flowfi_indexer_lag_ledgers',
  help: 'Number of ledgers the indexer is behind the network tip',
  registers: [registry],
});

export const indexerPollsTotal = new Counter({
  name: 'flowfi_indexer_polls_total',
  help: 'Indexer poll cycles by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const indexerEventsProcessedTotal = new Counter({
  name: 'flowfi_indexer_events_processed_total',
  help: 'Contract events dispatched by the indexer worker by result',
  labelNames: ['eventType', 'result'] as const,
  registers: [registry],
});

/**
 * Distribution of the number of events carried by each persistence batch.
 * Bounded by the worker's configured batch size, so cardinality stays low.
 * A sustained value at the top bucket means the batch cap is the throughput
 * limiter; a value of 1 means batching is effectively disabled.
 */
export const indexerEventBatchSize = new Histogram({
  name: 'flowfi_indexer_event_batch_size',
  help: 'Number of events persisted per indexer batch',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

/**
 * Wall-clock duration of a single batched persistence transaction, including
 * any retries. Compare against `flowfi_db_query_duration_seconds` to see how
 * much of the batch cost is transaction overhead versus statement time.
 */
export const indexerEventBatchDuration = new Histogram({
  name: 'flowfi_indexer_event_batch_duration_seconds',
  help: 'Duration of a batched indexer event persistence transaction',
  labelNames: ['outcome'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

/**
 * Batched persistence attempts by outcome. `retry` counts attempts that failed
 * transiently and were re-issued; `duplicate` counts events skipped because an
 * idempotent write found them already present. The invariant to alert on is
 * `retry` growing without `success` growing alongside it.
 */
export const indexerEventBatchAttemptsTotal = new Counter({
  name: 'flowfi_indexer_event_batch_attempts_total',
  help: 'Batched indexer event persistence attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Events skipped by the idempotency guard because they were already persisted.
 * Non-zero is normal after a crash/restart replay; a sustained rate indicates
 * the cursor is not advancing as far as the events it has written.
 */
export const indexerEventBatchDuplicatesTotal = new Counter({
  name: 'flowfi_indexer_event_batch_duplicates_total',
  help: 'Indexer events skipped as already persisted (idempotent replay)',
  registers: [registry],
});

/**
 * Ledger reorg / fork recoveries. Incremented once per recovery so a sustained
 * non-zero rate (or a single spike) can page an operator: on Stellar a reorg
 * means either an RPC node served us a stale fork or the indexer is desynced,
 * both of which need human review even when the rollback itself succeeded.
 */
export const indexerReorgEventsTotal = new Counter({
  name: 'flowfi_indexer_reorg_events_total',
  help: 'Ledger reorg / fork recoveries triggered by the indexer, by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** Ledgers above the last verified checkpoint that the most recent rollback reverted. */
export const indexerRevertedLedgers = new Gauge({
  name: 'flowfi_indexer_reverted_ledgers',
  help: 'Ledger count reverted by the most recent indexer rollback',
  registers: [registry],
});

/** Events dispatched per processed ledger. */
export const indexerEventsPerLedger = new Histogram({
  name: 'flowfi_indexer_events_per_ledger',
  help: 'Contract events dispatched per processed ledger',
  buckets: [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

/** Time spent decoding a ledger's events, by result. */
export const indexerDecodeDuration = new Histogram({
  name: 'flowfi_indexer_decode_duration_seconds',
  help: 'Time spent decoding a ledger\'s events by result',
  labelNames: ['result'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

/** Time spent persisting a ledger's events, by result. */
export const indexerPersistDuration = new Histogram({
  name: 'flowfi_indexer_persist_duration_seconds',
  help: 'Time spent persisting a ledger\'s events by result',
  labelNames: ['result'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

/** Retry attempts issued by the indexer worker, by operation and outcome. */
export const indexerRetriesTotal = new Counter({
  name: 'flowfi_indexer_retries_total',
  help: 'Indexer retry attempts by operation and outcome',
  labelNames: ['operation', 'outcome'] as const,
  registers: [registry],
});

/** Unix timestamp (seconds) of the last successful ledger commit. */
export const indexerLastSuccessTimestamp = new Gauge({
  name: 'flowfi_indexer_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful indexer ledger commit',
  registers: [registry],
});

// ─── SSE ─────────────────────────────────────────────────────────────────────

/**
 * Live SSE clients. Labelled by topic so operators can see saturation of the
 * `admin` fan-out separately from per-stream subscriptions.
 */
export const sseActiveConnections = new Gauge({
  name: 'flowfi_sse_active_connections',
  help: 'Currently connected SSE clients by subscription topic',
  labelNames: ['topic'] as const,
  registers: [registry],
});

export const sseConnectionsTotal = new Counter({
  name: 'flowfi_sse_connections_total',
  help: 'SSE client connections accepted since process start',
  registers: [registry],
});

export const sseClientsDroppedTotal = new Counter({
  name: 'flowfi_sse_clients_dropped_total',
  help: 'SSE clients dropped for backpressure, capacity, or per-IP limits',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** Mirror of the service's hard connection ceiling, for saturation ratios. */
export const sseMaxConnections = new Gauge({
  name: 'flowfi_sse_max_connections',
  help: 'Configured maximum number of concurrent SSE connections',
  registers: [registry],
});

/**
 * Issue 3: Total messages currently enqueued across all slow SSE consumers.
 * A non-zero value means at least one client is behind on draining its TCP
 * buffer. Alert when this exceeds a threshold relative to active connections.
 */
export const sseSlowConsumerQueueDepth = new Gauge({
  name: 'flowfi_sse_slow_consumer_queue_depth',
  help: 'Total messages pending in per-client backpressure queues across all SSE connections',
  registers: [registry],
});

/**
 * Issue 1: Current number of entries in the in-process SSE replay ring buffer.
 * Allows operators to tune SSE_REPLAY_WINDOW_SIZE.
 */
export const sseReplayBufferSize = new Gauge({
  name: 'flowfi_sse_replay_buffer_size',
  help: 'Number of events currently held in the SSE in-process replay ring buffer',
  registers: [registry],
});

/**
 * Issue 4: Redis pub/sub reconnect attempts, labelled by outcome.
 * A sustained failure rate means the SSE service is in single-instance
 * degraded mode: events are still delivered locally but not cross-instance.
 */
export const sseRedisReconnectsTotal = new Counter({
  name: 'flowfi_sse_redis_reconnects_total',
  help: 'SSE Redis pub/sub reconnect attempts by outcome (success|failure)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Issue 4: Events dropped by the SSE deduplication window.
 * Non-zero on a reconnect-heavy broker is normal; a sustained rate without
 * corresponding reconnects suggests duplicate publishing by the indexer.
 */
export const sseEventDeduplicatesTotal = new Counter({
  name: 'flowfi_sse_event_deduplicates_total',
  help: 'SSE events dropped as duplicate by the per-process deduplication window',
  registers: [registry],
});

// ─── Soroban RPC ─────────────────────────────────────────────────────────────

/** Wall-clock latency of every outbound Soroban RPC call, by method. */
export const rpcRequestDuration = new Histogram({
  name: 'flowfi_rpc_request_duration_seconds',
  help: 'Duration of outbound Stellar RPC requests by method',
  labelNames: ['method'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

export const rpcRequestsTotal = new Counter({
  name: 'flowfi_rpc_requests_total',
  help: 'Outbound Stellar RPC requests by method and outcome',
  labelNames: ['method', 'outcome'] as const,
  registers: [registry],
});

/**
 * Failover events. Today the pool points at a single endpoint
 * (`SOROBAN_RPC_URL`), so a failover is recorded for each retry attempt issued
 * by `withRpcRetry`. When multi-RPC rotation lands, add a `to` label to name the
 * endpoint actually promoted.
 */
export const rpcFailoversTotal = new Counter({
  name: 'flowfi_rpc_failovers_total',
  help: 'RPC failover events (retries issued after a failed attempt)',
  labelNames: ['method'] as const,
  registers: [registry],
});

/**
 * Circuit-breaker trips. A call that exhausts its retry budget — or hits the
 * hard RPC deadline — is treated as a trip, since those are the conditions a
 * breaker would latch on.
 */
export const rpcCircuitBreakerTripsTotal = new Counter({
  name: 'flowfi_rpc_circuit_breaker_trips_total',
  help: 'RPC circuit-breaker trips by endpoint and method',
  labelNames: ['endpoint', 'method'] as const,
  registers: [registry],
});

// ─── Database ────────────────────────────────────────────────────────────────

/** Duration of Prisma operations, by model-level operation name. */
export const dbQueryDuration = new Histogram({
  name: 'flowfi_db_query_duration_seconds',
  help: 'Duration of Prisma database operations',
  labelNames: ['operation'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

export const dbPoolConnections = new Gauge({
  name: 'flowfi_db_pool_connections',
  help: 'PostgreSQL connection pool utilisation',
  labelNames: ['state'] as const,
  registers: [registry],
});

export const dbPoolMaxConnections = new Gauge({
  name: 'flowfi_db_pool_max_connections',
  help: 'Configured maximum size of the PostgreSQL connection pool',
  registers: [registry],
});

/**
 * Point-in-time sample of the pg pool. Supplied by `pg-pool.ts` via
 * `registerDbPoolStatsProvider` so this module never imports `pg` (importing
 * metrics from the worker must not open a database connection).
 */
export interface DbPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

let dbPoolStatsProvider: (() => DbPoolStats) | null = null;

/**
 * Attach the pool whose `totalCount`/`idleCount`/`waitingCount` the gauges
 * below should read. Called once from `createPgPool`.
 */
export function registerDbPoolStatsProvider(provider: () => DbPoolStats): void {
  dbPoolStatsProvider = provider;
}

/**
 * Read the current pool counts, tolerating a missing or throwing provider so a
 * broken pool can never make the whole `/metrics` scrape fail.
 */
function sampleDbPool(): DbPoolStats {
  try {
    return dbPoolStatsProvider?.() ?? { total: 0, idle: 0, waiting: 0 };
  } catch {
    return { total: 0, idle: 0, waiting: 0 };
  }
}

/**
 * Connection pool gauges. `waiting` is the one to alert on: a non-zero value
 * means callers are queued for a connection, which shows up as request latency
 * long before the pool is technically exhausted.
 *
 * Each gauge samples the pool via `collect()` on every scrape rather than being
 * pushed on a timer, so a scrape always reflects the pool at that instant.
 */
export const dbPoolTotalConnections = new Gauge({
  name: 'flowfi_db_pool_total_connections',
  help: 'Total PostgreSQL connections currently held by the pool',
  registers: [registry],
  collect() {
    this.set(sampleDbPool().total);
  },
});

export const dbPoolIdleConnections = new Gauge({
  name: 'flowfi_db_pool_idle_connections',
  help: 'Idle PostgreSQL connections available in the pool',
  registers: [registry],
  collect() {
    this.set(sampleDbPool().idle);
  },
});

export const dbPoolWaitingRequests = new Gauge({
  name: 'flowfi_db_pool_waiting_requests',
  help: 'Requests queued waiting for a PostgreSQL connection',
  registers: [registry],
  collect() {
    this.set(sampleDbPool().waiting);
  },
});

export const dbPoolSaturationRatio = new Gauge({
  name: 'flowfi_db_pool_saturation_ratio',
  help: 'Ratio of actively leased database connections to maximum pool capacity (0.0 to 1.0)',
  registers: [registry],
  collect() {
    const stats = sampleDbPool();
    const max = dbPoolMaxConnections.get()?.values?.[0]?.value ?? 10;
    const active = Math.max(0, stats.total - stats.idle);
    this.set(max > 0 ? Math.min(1.0, active / max) : 0);
  },
});

export const dbPoolAcquireDuration = new Histogram({
  name: 'flowfi_db_pool_acquire_duration_seconds',
  help: 'Time spent waiting to acquire a PostgreSQL connection from the pool',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});


// ─── HTTP ────────────────────────────────────────────────────────────────────

/** Every API request, labelled by low-cardinality route template and status. */
export const httpRequestsTotal = new Counter({
  name: 'flowfi_http_requests_total',
  help: 'HTTP API requests by status code and route',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'flowfi_http_request_duration_seconds',
  help: 'HTTP API request duration by route',
  labelNames: ['method', 'route'] as const,
  buckets: DEFAULT_BUCKETS,
  registers: [registry],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recompute the lag gauge. `networkLedger` may be 0 when the RPC tip could not
 * be resolved; in that case the previous lag value is cleared rather than
 * reported as a bogus full-network lag.
 */
/** Record a completed rollback for alerting; 0 clears the gauge after a clean run. */
export function setIndexerRevertedLedgers(count: number): void {
  indexerRevertedLedgers.set(count);
}

export function setIndexerLedgers(currentLedger: number, networkLedger: number): void {
  indexerCurrentLedger.set(currentLedger);
  indexerNetworkLedger.set(networkLedger);

  if (networkLedger > 0) {
    indexerLagLedgers.set(Math.max(0, networkLedger - currentLedger));
  } else {
    indexerLagLedgers.set(0);
  }
}

/** Record the number of events dispatched for a single processed ledger. */
export function recordIndexerEventsPerLedger(count: number): void {
  indexerEventsPerLedger.observe(count);
}

/** Record decode latency for a ledger. `result` is success | error. */
export function recordIndexerDecode(seconds: number, result: string): void {
  indexerDecodeDuration.observe({ result }, seconds);
}

/** Record persistence latency for a ledger. `result` is success | error. */
export function recordIndexerPersist(seconds: number, result: string): void {
  indexerPersistDuration.observe({ result }, seconds);
}

/** Record a retry attempt. `operation` and `outcome` must be bounded values. */
export function recordIndexerRetry(operation: string, outcome: string): void {
  indexerRetriesTotal.inc({ operation, outcome });
}

/**
 * Stamp the last-success gauge. Defaults to "now" so callers can simply call
 * this after a successful commit; pass an explicit epoch-seconds value in tests.
 */
export function markIndexerSuccess(timestampSeconds: number = Date.now() / 1000): void {
  indexerLastSuccessTimestamp.set(timestampSeconds);
}

/**
 * Reset every per-topic SSE gauge, then re-publish the supplied counts.
 *
 * The aggregate is published under the reserved `topic="total"` label so
 * `sum(flowfi_sse_active_connections)` stays meaningful on an idle instance
 * instead of returning "no data". Dashboards must exclude that label when they
 * want the per-topic breakdown.
 */
export function setSseConnectionCounts(countsByTopic: Map<string, number>, total: number): void {
  sseActiveConnections.reset();
  for (const [topic, count] of countsByTopic) {
    sseActiveConnections.set({ topic }, count);
  }
  sseActiveConnections.set({ topic: TOTAL_SSE_TOPIC }, total);
}

/** Record a single outbound RPC call. `outcome` is success | error | timeout. */
export function recordRpcRequest(method: string, seconds: number, outcome: string): void {
  rpcRequestDuration.observe({ method }, seconds);
  rpcRequestsTotal.inc({ method, outcome });
}

/**
 * Record one batched persistence attempt. `outcome` is success | retry | error.
 * `eventCount` is the number of events the batch carried (0 for an attempt that
 * failed before any event was read) and `seconds` its wall-clock duration.
 */
export function recordIndexerEventBatch(
  eventCount: number,
  seconds: number,
  outcome: string,
): void {
  indexerEventBatchAttemptsTotal.inc({ outcome });
  indexerEventBatchDuration.observe({ outcome }, seconds);
  if (eventCount > 0) {
    indexerEventBatchSize.observe(eventCount);
  }
}

/** Record events skipped by the idempotency guard during a batch write. */
export function recordIndexerEventBatchDuplicates(count: number): void {
  if (count > 0) {
    indexerEventBatchDuplicatesTotal.inc(count);
  }
}

export function getMetricsRegistry(): Registry {
  return registry;
}

export const metricsContentType = registry.contentType;
