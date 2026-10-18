/**
 * Analytics controller — HTTP surface for the #1480 analytics stack.
 *
 * Read-only endpoints; no auth beyond the API's global middleware because
 * every payload here is public protocol statistics (the same numbers a
 * block explorer would show).
 */

import type { Request, Response } from "express";
import {
  getDefiLlamaAdapter,
  getHistoricalAnalytics,
  getProtocolTvl,
  type AnalyticsInterval,
  type AnalyticsPeriod,
} from "../services/analytics.service.js";
import { sendApiError } from "../types/api-error.js";
import logger from "../logger.js";

const VALID_PERIODS: AnalyticsPeriod[] = ["7d", "30d", "90d", "1y"];
const VALID_INTERVALS: AnalyticsInterval[] = ["1h", "1d"];

/**
 * Optional `network` query parameter. When omitted the service scopes to the
 * default network; when present it must be a non-empty string. Unknown
 * networks are rejected by the service layer (400) rather than silently
 * returning empty aggregates.
 */
function parseNetworkParam(req: Request): string | undefined {
  const raw = req.query.network;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  return raw.trim();
}

/**
 * Cache metadata surfaced on every analytics response so clients can observe
 * the staleness contract (see analytics.service.ts). Additive only — existing
 * fields keep their shape.
 */
function cacheMeta(meta: {
  source: string;
  cached: boolean;
  generatedAt: string;
}) {
  return {
    source: meta.source,
    cached: meta.cached,
    generatedAt: meta.generatedAt,
  };
}

/**
 * GET /api/v1/analytics/tvl
 *
 * Current protocol TVL partitioned by token asset.
 */
export async function getTvlHandler(req: Request, res: Response) {
  const network = parseNetworkParam(req);
  if (network === "") {
    sendApiError(res, 400, "INVALID_NETWORK", "network must be a non-empty string");
    return;
  }

  try {
    const { snapshot, meta } = await getProtocolTvl({ network });
    res.json({ success: true, data: snapshot, meta: cacheMeta(meta) });
  } catch (error) {
    if (isUnknownNetworkError(error)) {
      sendApiError(res, 400, "INVALID_NETWORK", "unknown network");
      return;
    }
    logger.error("analytics TVL request failed:", error);
    sendApiError(res, 500, "ANALYTICS_UNAVAILABLE", "TVL snapshot unavailable");
  }
}

/**
 * GET /api/v1/analytics/historical?period=30d&interval=1d
 *
 * Pre-aggregated time-series points for frontend charts.
 */
export async function getHistoricalHandler(req: Request, res: Response) {
  const period = (req.query.period ?? "30d") as AnalyticsPeriod;
  const interval = (req.query.interval ?? "1d") as AnalyticsInterval;
  const network = parseNetworkParam(req);

  if (network === "") {
    sendApiError(res, 400, "INVALID_NETWORK", "network must be a non-empty string");
    return;
  }
  if (!VALID_PERIODS.includes(period)) {
    sendApiError(
      res,
      400,
      "INVALID_PERIOD",
      `period must be one of: ${VALID_PERIODS.join(", ")}`
    );
    return;
  }
  if (!VALID_INTERVALS.includes(interval)) {
    sendApiError(
      res,
      400,
      "INVALID_INTERVAL",
      `interval must be one of: ${VALID_INTERVALS.join(", ")}`
    );
    return;
  }

  try {
    const { series, meta } = await getHistoricalAnalytics(period, interval, {
      network,
    });
    res.json({ success: true, data: series, meta: cacheMeta(meta) });
  } catch (error) {
    if (isUnknownNetworkError(error)) {
      sendApiError(res, 400, "INVALID_NETWORK", "unknown network");
      return;
    }
    logger.error("analytics historical request failed:", error);
    sendApiError(
      res,
      500,
      "ANALYTICS_UNAVAILABLE",
      "Historical analytics unavailable"
    );
  }
}

/**
 * GET /api/v1/analytics/defillama
 *
 * Standardized DefiLlama protocol-TVL adapter response.
 */
export async function getDefiLlamaHandler(req: Request, res: Response) {
  const network = parseNetworkParam(req);
  if (network === "") {
    sendApiError(res, 400, "INVALID_NETWORK", "network must be a non-empty string");
    return;
  }

  try {
    const { adapter, meta } = await getDefiLlamaAdapter({ network });
    // DefiLlama consumes the raw object; no success envelope here. Cache
    // metadata is attached additively so existing consumers are unaffected.
    res.json({ ...adapter, meta: cacheMeta(meta) });
  } catch (error) {
    if (isUnknownNetworkError(error)) {
      sendApiError(res, 400, "INVALID_NETWORK", "unknown network");
      return;
    }
    logger.error("DefiLlama adapter request failed:", error);
    sendApiError(
      res,
      500,
      "ANALYTICS_UNAVAILABLE",
      "DefiLlama adapter unavailable"
    );
  }
}

/**
 * The service signals an unrecognized `network` scope with a tagged error so
 * the controller can map it to a 400 without importing service internals.
 */
function isUnknownNetworkError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "UNKNOWN_NETWORK"
  );
}
