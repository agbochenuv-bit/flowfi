/**
 * Analytics Service — TimescaleDB-backed protocol TVL & velocity (Issue #1480)
 *
 * Reads the `stream_flow_snapshots` hypertable and its continuous aggregates
 * (`hourly_protocol_metrics`, `daily_protocol_metrics`) created by the
 * `20261001000000_add_timescaledb_analytics` migration. When TimescaleDB is
 * not installed (or the hypertable has not been created yet) every reader
 * degrades to live aggregation over the Prisma `Stream` table, so the
 * endpoints stay available on stock PostgreSQL deployments.
 */

import { pool, prisma } from "../lib/prisma.js";
import { MemoryCache } from "../lib/redis.js";
import logger from "../logger.js";

/** Period accepted by the historical endpoint. */
export type AnalyticsPeriod = "7d" | "30d" | "90d" | "1y";

/** Interval accepted by the historical endpoint. */
export type AnalyticsInterval = "1h" | "1d";

const PERIOD_DAYS: Record<AnalyticsPeriod, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

/**
 * Documented staleness window for aggregate endpoints (#62).
 *
 * Cached aggregates may be up to this many milliseconds old. Newly indexed
 * events are picked up either immediately via `invalidateAnalyticsCache()`
 * (called by the indexer) or, at the latest, once this window elapses.
 */
export const ANALYTICS_CACHE_TTL_MS = 30_000;

/** Optional filters threaded through the analytics readers (#61). */
export interface AnalyticsFilters {
  /**
   * Restrict aggregates to a single network (e.g. `"testnet"`). When omitted
   * the aggregate spans every network. Cache keys always include this value so
   * results never cross networks.
   */
  network?: string;
}

/**
 * Bounded in-process cache for aggregate responses (#62). Keyed by
 * network + period + interval + filters; never keyed by user, so a single
 * entry is safe to share across callers for the same scope.
 */
const analyticsCache = new MemoryCache<unknown>({
  maxSize: 256,
  defaultTtlMs: ANALYTICS_CACHE_TTL_MS,
});

/**
 * Invalidates cached analytics aggregates (#62).
 *
 * Call this when new events are indexed so subsequent reads reflect them
 * immediately instead of waiting out the staleness window. Passing a network
 * only clears entries scoped to that network (plus unscoped entries, which
 * may include it); passing nothing clears everything.
 */
export function invalidateAnalyticsCache(network?: string): void {
  if (network === undefined) {
    analyticsCache.clear();
    return;
  }
  analyticsCache.deleteByPrefix(`network=${network}|`);
  analyticsCache.deleteByPrefix("network=*|");
}

/** Clears the analytics cache. Exported for tests. */
export function resetAnalyticsCacheForTests(): void {
  analyticsCache.clear();
}

function cacheKey(
  kind: string,
  filters: AnalyticsFilters,
  extra: Record<string, string> = {}
): string {
  const network = filters.network ?? "*";
  const parts = [`network=${network}`, `kind=${kind}`];
  for (const [key, value] of Object.entries(extra).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    parts.push(`${key}=${value}`);
  }
  return parts.join("|");
}

async function cached<T>(
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const hit = analyticsCache.get(key) as T | undefined;
  if (hit !== undefined) return hit;
  const value = await loader();
  analyticsCache.set(key, value, ANALYTICS_CACHE_TTL_MS);
  return value;
}

/**
 * Normalizes a window boundary to a UTC instant (#61).
 *
 * All analytics windows are expressed as half-open UTC ranges `[start, end)`.
 * Accepting a `Date` and re-emitting its ISO representation guarantees the
 * same instant regardless of the caller's local timezone.
 */
export function toUtcBoundary(date: Date): string {
  return new Date(date.getTime()).toISOString();
}

/**
 * Computes the half-open UTC window `[start, end)` for a period (#61).
 *
 * `end` is the current instant truncated to the interval boundary; `start` is
 * `end` minus the period length. Buckets are inclusive of `start` and
 * exclusive of `end`, so an event exactly at `end` belongs to the next window
 * and an event exactly at `start` belongs to this one.
 */
export function computeUtcWindow(
  period: AnalyticsPeriod,
  interval: AnalyticsInterval,
  now: Date = new Date()
): { start: string; end: string } {
  const stepMs = interval === "1d" ? 86_400_000 : 3_600_000;
  const endMs = Math.floor(now.getTime() / stepMs) * stepMs;
  const startMs = endMs - PERIOD_DAYS[period] * 86_400_000;
  return {
    start: toUtcBoundary(new Date(startMs)),
    end: toUtcBoundary(new Date(endMs)),
  };
}

export interface TokenTvl {
  tokenAddress: string;
  /** Sum of unwithdrawn stream balances, in stroops. */
  totalLockedStroops: string;
  /** Sum of per-second drip across active streams, in stroops/second. */
  velocityPerSecondStroops: string;
  activeStreamCount: number;
}

export interface TvlSnapshot {
  /** Where the numbers came from: the hypertable or live aggregation. */
  source: "timescaledb" | "live";
  tokens: TokenTvl[];
  /** Protocol-wide total locked, in stroops. */
  totalTvlStroops: string;
  generatedAt: string;
}

export interface HistoricalPoint {
  bucket: string;
  tokenAddress: string;
  avgTvlStroops: string;
  velocityStroopsPerSecond: string;
  peakStreams: number;
}

export interface HistoricalSeries {
  source: "timescaledb" | "live";
  period: AnalyticsPeriod;
  interval: AnalyticsInterval;
  points: HistoricalPoint[];
}

export interface DefiLlamaResponse {
  /** DefiLlama adapter protocol identifier. */
  id: string;
  name: string;
  /** TVL keyed by token address, plus a `total` entry — stroops. */
  tvl: Record<string, number>;
  timestamp: string;
}

/** Detects whether the TimescaleDB hypertable exists and is queryable. */
let timescaleAvailable: boolean | undefined;

/**
 * Clears the availability cache. Exported for tests: the service process
 * should cache once, but each test needs a fresh probe.
 */
export function resetTimescaleCacheForTests(): void {
  timescaleAvailable = undefined;
}

async function hasTimescale(): Promise<boolean> {
  if (timescaleAvailable !== undefined) return timescaleAvailable;
  try {
    const result = await pool.query(
      `SELECT to_regclass('public.stream_flow_snapshots') AS hypertable`
    );
    timescaleAvailable = result.rows[0]?.hypertable !== null;
  } catch (error) {
    logger.warn(
      "TimescaleDB analytics tables unavailable; using live aggregation:",
      error
    );
    timescaleAvailable = false;
  }
  return timescaleAvailable;
}

/**
 * Live fallback: aggregate active streams straight from Prisma.
 *
 * Amount columns are i128-preserved strings in the schema, so Prisma's
 * `_sum` aggregation does not apply to them; rows are summed in JS with
 * `BigInt` instead to keep the full precision end to end.
 */
async function liveTvl(filters: AnalyticsFilters = {}): Promise<TvlSnapshot> {
  const streams = await prisma.stream.findMany({
    where: {
      isActive: true,
      ...(filters.network ? { network: filters.network } : {}),
    },
    select: {
      tokenAddress: true,
      depositedAmount: true,
      withdrawnAmount: true,
      ratePerSecond: true,
    },
  });

  const byToken = new Map<
    string,
    { locked: bigint; velocity: bigint; count: number }
  >();
  for (const stream of streams) {
    const deposited = BigInt(stream.depositedAmount);
    const withdrawn = BigInt(stream.withdrawnAmount);
    const entry = byToken.get(stream.tokenAddress) ?? {
      locked: 0n,
      velocity: 0n,
      count: 0,
    };
    entry.locked += deposited > withdrawn ? deposited - withdrawn : 0n;
    entry.velocity += BigInt(stream.ratePerSecond);
    entry.count += 1;
    byToken.set(stream.tokenAddress, entry);
  }

  const tokens: TokenTvl[] = [...byToken.entries()].map(
    ([tokenAddress, agg]) => ({
      tokenAddress,
      totalLockedStroops: agg.locked.toString(),
      velocityPerSecondStroops: agg.velocity.toString(),
      activeStreamCount: agg.count,
    })
  );

  const totalTvlStroops = tokens
    .reduce((acc, t) => acc + BigInt(t.totalLockedStroops), 0n)
    .toString();

  return {
    source: "live",
    tokens,
    totalTvlStroops,
    generatedAt: new Date().toISOString(),
  };
}

/** Latest snapshot row per token, straight from the hypertable. */
async function timescaleTvl(filters: AnalyticsFilters = {}): Promise<TvlSnapshot> {
  const result = await pool.query(
    `SELECT DISTINCT ON (token_address)
            token_address,
            total_locked_amount,
            flow_velocity_per_second,
            active_stream_count
       FROM stream_flow_snapshots
      WHERE ($1::text IS NULL OR network = $1)
      ORDER BY token_address, time DESC`,
    [filters.network ?? null]
  );

  const snapshotRows = result.rows as {
    token_address: string;
    total_locked_amount: string;
    flow_velocity_per_second: string;
    active_stream_count: number;
  }[];

  const tokens: TokenTvl[] = snapshotRows.map((row) => ({
    tokenAddress: row.token_address,
    totalLockedStroops: BigInt(row.total_locked_amount).toString(),
    velocityPerSecondStroops: BigInt(row.flow_velocity_per_second).toString(),
    activeStreamCount: row.active_stream_count,
  }));

  const totalTvlStroops = tokens
    .reduce((acc, t) => acc + BigInt(t.totalLockedStroops), 0n)
    .toString();

  return {
    source: "timescaledb",
    tokens,
    totalTvlStroops,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Current protocol TVL partitioned by token (#1480).
 *
 * Results are cached for `ANALYTICS_CACHE_TTL_MS` and keyed by network, so
 * aggregates never cross networks (#62). Pass `filters.network` to scope the
 * snapshot to a single network (#61).
 */
export async function getProtocolTvl(
  filters: AnalyticsFilters = {}
): Promise<TvlSnapshot> {
  return cached(cacheKey("tvl", filters), async () => {
    if (await hasTimescale()) {
      try {
        return await timescaleTvl(filters);
      } catch (error) {
        logger.warn(
          "Timescale TVL query failed; falling back to live aggregation:",
          error
        );
      }
    }
    return liveTvl(filters);
  });
}

/**
 * Historical pre-aggregated TVL/velocity series for charts (#1480).
 *
 * Windows are half-open UTC ranges `[start, end)` (#61): `bucket >= start`
 * and `bucket < end`, so aggregates are repeatable across timezone changes.
 * Late-arriving events are bucketed by their event timestamp (the `bucket`
 * column), not ingestion time, so a backfilled event lands in the correct
 * historical bucket. Results are cached per network+period+interval (#62).
 */
export async function getHistoricalAnalytics(
  period: AnalyticsPeriod,
  interval: AnalyticsInterval,
  filters: AnalyticsFilters = {}
): Promise<HistoricalSeries> {
  return cached(
    cacheKey("historical", filters, { period, interval }),
    async () => {
      if (!(await hasTimescale())) {
        return { source: "live", period, interval, points: [] };
      }

      const view =
        interval === "1d"
          ? "daily_protocol_metrics"
          : "hourly_protocol_metrics";
      const { start, end } = computeUtcWindow(period, interval);

      const result = await pool.query(
        `SELECT bucket, token_address, avg_tvl, aggregate_velocity, peak_streams
           FROM ${view}
          WHERE bucket >= $1::timestamptz
            AND bucket < $2::timestamptz
            AND ($3::text IS NULL OR network = $3)
          ORDER BY bucket, token_address`,
        [start, end, filters.network ?? null]
      );

      const seriesRows = result.rows as {
        bucket: Date;
        token_address: string;
        avg_tvl: string;
        aggregate_velocity: string;
        peak_streams: number;
      }[];

      return {
        source: "timescaledb" as const,
        period,
        interval,
        points: seriesRows.map((row) => ({
          bucket: new Date(row.bucket).toISOString(),
          tokenAddress: row.token_address,
          avgTvlStroops: BigInt(row.avg_tvl).toString(),
          velocityStroopsPerSecond: BigInt(row.aggregate_velocity).toString(),
          peakStreams: row.peak_streams,
        })),
      };
    }
  );
}

/**
 * DefiLlama-compatible adapter payload (#1480).
 *
 * DefiLlama reads a flat `{ [chainOrToken]: tvlNumber }` shape; numbers are
 * whole units of each token's smallest display unit (stroops for Stellar).
 */
export async function getDefiLlamaAdapter(
  filters: AnalyticsFilters = {}
): Promise<DefiLlamaResponse> {
  const snapshot = await getProtocolTvl(filters);
  const tvl: Record<string, number> = { total: Number(snapshot.totalTvlStroops) };
  for (const token of snapshot.tokens) {
    tvl[token.tokenAddress] = Number(token.totalLockedStroops);
  }
  return {
    id: "flowfi",
    name: "FlowFi",
    tvl,
    timestamp: snapshot.generatedAt,
  };
}
