/**
 * Analytics endpoint tests (#1480).
 *
 * The TimescaleDB path is exercised through a mocked pg pool so no real
 * database is needed; the fallback path is exercised by making
 * `hasTimescale` report unavailable. Contract under test: response shapes,
 * validation errors, and the DefiLlama adapter mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

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
} from "../src/services/analytics.service.js";
import {
  createPrincipalRateLimiter,
  type RateLimitStore,
} from "../src/middleware/rateLimit.js";
import {
  errorEnvelope,
  requestIdMiddleware,
  type ApiErrorCode,
} from "../src/middleware/errorEnvelope.js";

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

/**
 * In-memory stand-in for the Redis-backed counter store. Mirrors the
 * multi-instance semantics: every "instance" shares the same store, so a
 * caller's budget is consumed globally rather than per process.
 */
function createMemoryStore(): RateLimitStore & { hits: Map<string, number> } {
  const hits = new Map<string, number>();
  return {
    hits,
    async increment(key: string, windowSeconds: number) {
      const current = hits.get(key) ?? 0;
      const next = current + 1;
      hits.set(key, next);
      return { count: next, resetAt: Date.now() + windowSeconds * 1000 };
    },
  };
}

function buildAnalyticsApp(store: RateLimitStore) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(requestIdMiddleware());
  app.use(
    "/api/analytics",
    createPrincipalRateLimiter({
      store,
      windowSeconds: 60,
      anonymousLimit: 2,
      authenticatedLimit: 5,
      route: "analytics",
    }),
  );
  app.get("/api/analytics/tvl", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/analytics/history", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const code: ApiErrorCode = "INTERNAL_ERROR";
      res.status(500).json(errorEnvelope(code, res.locals.requestId));
    },
  );
  return app;
}

describe("analytics route family: principal-aware rate limits (#72)", () => {
  it("applies the anonymous budget keyed by client IP", async () => {
    const store = createMemoryStore();
    const app = buildAnalyticsApp(store);

    await request(app).get("/api/analytics/tvl").expect(200);
    await request(app).get("/api/analytics/tvl").expect(200);
    const limited = await request(app).get("/api/analytics/tvl").expect(429);

    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.body.error.requestId).toBeTruthy();
    expect(limited.headers["retry-after"]).toBeDefined();
    // Anonymous callers are bucketed by IP, not by a shared global key.
    expect([...store.hits.keys()].some((k) => k.includes("ip:"))).toBe(true);
  });

  it("gives authenticated principals a larger budget than anonymous callers", async () => {
    const store = createMemoryStore();
    const app = buildAnalyticsApp(store);

    const auth = { Authorization: "Bearer principal-abc" };
    for (let i = 0; i < 5; i += 1) {
      await request(app).get("/api/analytics/tvl").set(auth).expect(200);
    }
    await request(app).get("/api/analytics/tvl").set(auth).expect(429);
    // The anonymous bucket for the same IP is untouched by the principal.
    await request(app).get("/api/analytics/tvl").expect(200);
  });

  it("ignores spoofed X-Forwarded-For beyond the trusted proxy hop", async () => {
    const store = createMemoryStore();
    const app = buildAnalyticsApp(store);

    // With trust proxy = 1, the leftmost entry is attacker-controlled; the
    // limiter must key on the rightmost (proxy-appended) address.
    await request(app)
      .get("/api/analytics/tvl")
      .set("X-Forwarded-For", "1.1.1.1, 203.0.113.9")
      .expect(200);
    await request(app)
      .get("/api/analytics/tvl")
      .set("X-Forwarded-For", "2.2.2.2, 203.0.113.9")
      .expect(200);
    await request(app)
      .get("/api/analytics/tvl")
      .set("X-Forwarded-For", "3.3.3.3, 203.0.113.9")
      .expect(429);
  });

  it("shares counters across instances via the backing store", async () => {
    const store = createMemoryStore();
    const instanceA = buildAnalyticsApp(store);
    const instanceB = buildAnalyticsApp(store);

    await request(instanceA).get("/api/analytics/tvl").expect(200);
    await request(instanceB).get("/api/analytics/tvl").expect(200);
    // Third hit lands on a different instance but the shared counter trips.
    await request(instanceA).get("/api/analytics/tvl").expect(429);
  });

  it("fails open with a documented fallback when the store is unavailable", async () => {
    const store: RateLimitStore = {
      async increment() {
        throw new Error("redis down: 10.0.0.5:6379 ECONNREFUSED");
      },
    };
    const app = buildAnalyticsApp(store);

    for (let i = 0; i < 4; i += 1) {
      await request(app).get("/api/analytics/tvl").expect(200);
    }
  });
});

describe("analytics route family: stable error envelope (#70)", () => {
  it("returns a versioned envelope with a stable code and request id", async () => {
    const app = express();
    app.use(requestIdMiddleware());
    app.get("/api/analytics/history", (_req, res) => {
      res.status(400).json(errorEnvelope("VALIDATION_FAILED", res.locals.requestId, [
        { field: "period", message: "must be one of 7d, 30d, 90d" },
      ]));
    });

    const res = await request(app)
      .get("/api/analytics/history")
      .set("X-Request-Id", "req-analytics-1")
      .expect(400);

    expect(res.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      requestId: "req-analytics-1",
      version: expect.any(String),
    });
    expect(res.body.error.details).toEqual([
      { field: "period", message: "must be one of 7d, 30d, 90d" },
    ]);
  });

  it("never leaks internal exception text to clients", async () => {
    const app = express();
    app.use(requestIdMiddleware());
    app.get("/api/analytics/tvl", () => {
      throw new Error("pg: password authentication failed for user flowfi");
    });
    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json(errorEnvelope("INTERNAL_ERROR", res.locals.requestId));
      },
    );

    const res = await request(app).get("/api/analytics/tvl").expect(500);
    const serialized = JSON.stringify(res.body);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("flowfi");
  });
});
