/**
 * Analytics endpoint tests (#1480).
 *
 * The TimescaleDB path is exercised through a mocked pg pool so no real
 * database is needed; the fallback path is exercised by making
 * `hasTimescale` report unavailable. Contract under test: response shapes,
 * validation errors, and the DefiLlama adapter mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const queryMock = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    stream: {
      findMany: vi.fn(),
    },
  },
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
  },
}));

vi.mock("../src/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "../src/lib/prisma.js";
import {
  getDefiLlamaAdapter,
  getHistoricalAnalytics,
  getProtocolTvl,
  resetTimescaleCacheForTests,
  resetAnalyticsCacheForTests,
  invalidateAnalyticsCache,
  getAnalyticsCacheStatsForTests,
  ANALYTICS_CACHE_STALENESS_MS,
  resolveUtcWindow,
  bucketStartUtc,
} from "../src/services/analytics.service.js";

describe("analytics service (#1480)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReset();
    resetTimescaleCacheForTests();
  });

  it("falls back to live Prisma aggregation when TimescaleDB is absent", async () => {
    // to_regclass returns null → no hypertable.
    queryMock.mockResolvedValue({ rows: [{ hypertable: null }] });

    // Amount columns are i128 strings in the schema; three active streams on
    // one token, aggregated in JS (deposits 1,000,000 − withdrawals 400,000).
    (prisma.stream.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        depositedAmount: "400000",
        withdrawnAmount: "100000",
        ratePerSecond: "20",
      },
      {
        tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        depositedAmount: "350000",
        withdrawnAmount: "150000",
        ratePerSecond: "20",
      },
      {
        tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        depositedAmount: "250000",
        withdrawnAmount: "150000",
        ratePerSecond: "10",
      },
    ]);

    const snapshot = await getProtocolTvl();

    expect(snapshot.source).toBe("live");
    expect(snapshot.totalTvlStroops).toBe("600000");
    expect(snapshot.tokens[0]?.activeStreamCount).toBe(3);
    expect(snapshot.tokens[0]?.velocityPerSecondStroops).toBe("50");
  });

  it("reads the latest hypertable snapshot per token when TimescaleDB is present", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ hypertable: "stream_flow_snapshots" }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          token_address: "CB63BC53EZDCKG6EFA3KJD3QWVV4QG4N35D7N4YQ6EY5XLYWJ7VL2MUA",
          total_locked_amount: "900000",
          flow_velocity_per_second: "25",
          active_stream_count: 2,
        },
      ],
    });

    const snapshot = await getProtocolTvl();

    expect(snapshot.source).toBe("timescaledb");
    expect(snapshot.totalTvlStroops).toBe("900000");
    // DISTINCT ON (token_address) ... ORDER BY token_address, time DESC
    expect(queryMock.mock.calls[1]?.[0]).toContain("DISTINCT ON");
  });

  it("maps the snapshot into the DefiLlama adapter shape", async () => {
    queryMock.mockResolvedValue({ rows: [{ hypertable: null }] });
    (prisma.stream.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        tokenAddress: "TOKEN_A",
        depositedAmount: "500",
        withdrawnAmount: "200",
        ratePerSecond: "1",
      },
    ]);

    const adapter = await getDefiLlamaAdapter();

    expect(adapter.id).toBe("flowfi");
    expect(adapter.tvl.total).toBe(300);
    expect(adapter.tvl.TOKEN_A).toBe(300);
  });

  it("returns empty historical points on live fallback and buckets via the daily view", async () => {
    queryMock.mockResolvedValue({ rows: [{ hypertable: null }] });
    const live = await getHistoricalAnalytics("30d", "1d");
    expect(live).toEqual({
      source: "live",
      period: "30d",
      interval: "1d",
      points: [],
    });

    // The first call latched the probe result in the service cache; clear it
    // so the timescaledb path below actually re-probes the pool.
    resetTimescaleCacheForTests();

    // First call is the availability probe, second the data query.
    queryMock.mockResolvedValueOnce({ rows: [{ hypertable: "stream_flow_snapshots" }] });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          bucket: new Date("2026-09-28T00:00:00Z"),
          token_address: "TOKEN_A",
          avg_tvl: "123",
          aggregate_velocity: "4",
          peak_streams: 9,
        },
      ],
    });
    const series = await getHistoricalAnalytics("90d", "1d");
    expect(series.source).toBe("timescaledb");
    expect(series.points[0]?.avgTvlStroops).toBe("123");
    expect(series.points[0]?.peakStreams).toBe(9);
    expect(queryMock.mock.calls.at(-1)![0]).toContain("daily_protocol_metrics");
  });
});

describe("analytics time-window semantics (#61)", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReset();
    resetTimescaleCacheForTests();
    resetAnalyticsCacheForTests();
  });

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("resolves windows to UTC boundaries regardless of the process timezone", () => {
    const anchor = new Date("2026-09-28T13:37:45.123Z");
    const windows = ["24h", "7d", "30d", "90d"] as const;
    const results: Record<string, unknown> = {};

    for (const tz of ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      results[tz] = windows.map((w) => resolveUtcWindow(w, anchor));
    }

    // Every timezone must produce byte-identical UTC windows.
    expect(results["America/New_York"]).toEqual(results["UTC"]);
    expect(results["Asia/Kolkata"]).toEqual(results["UTC"]);
    expect(results["Pacific/Kiritimati"]).toEqual(results["UTC"]);

    const day = resolveUtcWindow("24h", anchor);
    expect(day.start.toISOString()).toBe("2026-09-27T13:37:45.123Z");
    expect(day.end.toISOString()).toBe("2026-09-28T13:37:45.123Z");
    // Half-open interval: start inclusive, end exclusive.
    expect(day.startInclusive).toBe(true);
    expect(day.endInclusive).toBe(false);
  });

  it("buckets timestamps into half-open UTC buckets", () => {
    const bucketMs = 24 * 60 * 60 * 1000;
    const exactBoundary = new Date("2026-09-28T00:00:00.000Z");
    const justBefore = new Date("2026-09-27T23:59:59.999Z");
    const justAfter = new Date("2026-09-28T00:00:00.001Z");

    expect(bucketStartUtc(exactBoundary, bucketMs).toISOString()).toBe(
      "2026-09-28T00:00:00.000Z",
    );
    expect(bucketStartUtc(justBefore, bucketMs).toISOString()).toBe(
      "2026-09-27T00:00:00.000Z",
    );
    expect(bucketStartUtc(justAfter, bucketMs).toISOString()).toBe(
      "2026-09-28T00:00:00.000Z",
    );
  });

  it("produces repeatable aggregates across timezone changes", async () => {
    const rows = [
      {
        bucket: new Date("2026-09-28T00:00:00Z"),
        token_address: "TOKEN_A",
        avg_tvl: "123",
        aggregate_velocity: "4",
        peak_streams: 9,
      },
    ];

    const run = async (tz: string) => {
      process.env.TZ = tz;
      resetTimescaleCacheForTests();
      resetAnalyticsCacheForTests();
      queryMock.mockReset();
      queryMock.mockResolvedValueOnce({ rows: [{ hypertable: "stream_flow_snapshots" }] });
      queryMock.mockResolvedValueOnce({ rows });
      return getHistoricalAnalytics("90d", "1d");
    };

    const utc = await run("UTC");
    const ny = await run("America/New_York");
    const kolkata = await run("Asia/Kolkata");

    expect(ny).toEqual(utc);
    expect(kolkata).toEqual(utc);
    expect(utc.points[0]?.bucket).toBe("2026-09-28T00:00:00.000Z");
  });

  it("incorporates events indexed after an initial query once the cache is invalidated", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ hypertable: "stream_flow_snapshots" }] });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          bucket: new Date("2026-09-28T00:00:00Z"),
          token_address: "TOKEN_A",
          avg_tvl: "100",
          aggregate_velocity: "1",
          peak_streams: 1,
        },
      ],
    });

    const first = await getHistoricalAnalytics("7d", "1d");
    expect(first.points).toHaveLength(1);

    // A late-arriving indexed event lands in the same UTC bucket.
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          bucket: new Date("2026-09-28T00:00:00Z"),
          token_address: "TOKEN_A",
          avg_tvl: "250",
          aggregate_velocity: "3",
          peak_streams: 2,
        },
      ],
    });

    // Without invalidation the cached series is served (documented staleness).
    const cached = await getHistoricalAnalytics("7d", "1d");
    expect(cached.points[0]?.avgTvlStroops).toBe("100");

    invalidateAnalyticsCache();
    const refreshed = await getHistoricalAnalytics("7d", "1d");
    expect(refreshed.points[0]?.avgTvlStroops).toBe("250");
    expect(refreshed.points[0]?.peakStreams).toBe(2);
  });

  it("scopes aggregates to the requested network", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ hypertable: "stream_flow_snapshots" }] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    await getHistoricalAnalytics("7d", "1d", { network: "testnet" });

    const dataCall = queryMock.mock.calls.at(-1)!;
    expect(String(dataCall[0])).toContain("network");
    expect(dataCall[1]).toContain("testnet");
  });
});

describe("analytics caching and invalidation (#62)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReset();
    resetTimescaleCacheForTests();
    resetAnalyticsCacheForTests();
  });

  const primeTimescale = () => {
    queryMock.mockResolvedValueOnce({ rows: [{ hypertable: "stream_flow_snapshots" }] });
  };

  it("serves repeated identical queries from cache without re-querying", async () => {
    primeTimescale();
    queryMock.mockResolvedValueOnce({ rows: [] });

    await getHistoricalAnalytics("30d", "1d", { network: "mainnet" });
    const callsAfterFirst = queryMock.mock.calls.length;
    await getHistoricalAnalytics("30d", "1d", { network: "mainnet" });

    expect(queryMock.mock.calls.length).toBe(callsAfterFirst);
    expect(getAnalyticsCacheStatsForTests().hits).toBeGreaterThanOrEqual(1);
  });

  it("does not cross networks in the cache key", async () => {
    primeTimescale();
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getHistoricalAnalytics("30d", "1d", { network: "mainnet" });

    queryMock.mockResolvedValueOnce({ rows: [] });
    await getHistoricalAnalytics("30d", "1d", { network: "testnet" });

    // Two distinct data queries were issued: one per network.
    const dataCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes("daily_protocol_metrics"),
    );
    expect(dataCalls).toHaveLength(2);
    expect(getAnalyticsCacheStatsForTests().misses).toBeGreaterThanOrEqual(2);
  });

  it("does not cross users in the cache key", async () => {
    primeTimescale();
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getHistoricalAnalytics("30d", "1d", { network: "mainnet", userId: "user-a" });

    queryMock.mockResolvedValueOnce({ rows: [] });
    await getHistoricalAnalytics("30d", "1d", { network: "mainnet", userId: "user-b" });

    const dataCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes("daily_protocol_metrics"),
    );
    expect(dataCalls).toHaveLength(2);
  });

  it("expires entries after the documented staleness window", async () => {
    vi.useFakeTimers();
    try {
      primeTimescale();
      queryMock.mockResolvedValueOnce({ rows: [] });
      await getHistoricalAnalytics("30d", "1d", { network: "mainnet" });

      vi.advanceTimersByTime(ANALYTICS_CACHE_STALENESS_MS - 1);
      const beforeExpiry = queryMock.mock.calls.length;
      await getHistoricalAnalytics("30d", "1d", { network: "mainnet" });
      expect(queryMock.mock.calls.length).toBe(beforeExpiry);

      vi.advanceTimersByTime(2);
      queryMock.mockResolvedValueOnce({ rows: [] });
      await getHistoricalAnalytics("30d", "1d", { network: "mainnet" });
      expect(queryMock.mock.calls.length).toBeGreaterThan(beforeExpiry);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the cache size", async () => {
    primeTimescale();
    for (let i = 0; i < 300; i += 1) {
      queryMock.mockResolvedValueOnce({ rows: [] });
      await getHistoricalAnalytics("30d", "1d", { network: `net-${i}` });
    }
    expect(getAnalyticsCacheStatsForTests().size).toBeLessThanOrEqual(256);
  });
});
