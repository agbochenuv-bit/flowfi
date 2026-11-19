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
import {
  cancelExportJob,
  createExportJob,
  getExportJob,
  getExportArtifact,
  isExportFormat,
  isExportDirection,
  buildWalletActivityExport,
  EXPORT_SCHEMA_VERSION,
  type ExportFormat,
  type ExportDirection,
} from "../services/export.service.js";
import { ApiError, sendApiError } from "../types/api-error.js";
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
    sendApiError(
      res,
      new ApiError("ANALYTICS_UNAVAILABLE", "TVL snapshot unavailable")
    );
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
      new ApiError("INVALID_PERIOD", "Invalid analytics period", {
        details: [{ field: "period", issue: `must be one of: ${VALID_PERIODS.join(", ")}` }],
      })
    );
    return;
  }
  if (!VALID_INTERVALS.includes(interval)) {
    sendApiError(
      res,
      new ApiError("INVALID_INTERVAL", "Invalid analytics interval", {
        details: [{ field: "interval", issue: `must be one of: ${VALID_INTERVALS.join(", ")}` }],
      })
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
      new ApiError("ANALYTICS_UNAVAILABLE", "Historical analytics unavailable")
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
      new ApiError("ANALYTICS_UNAVAILABLE", "DefiLlama adapter unavailable")
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

// ---------------------------------------------------------------------------
// Asynchronous export jobs (#238) + accounting-friendly activity export (#239)
// ---------------------------------------------------------------------------

/**
 * Resolve the authenticated principal. Export endpoints are wallet-scoped, so
 * an unauthenticated request is rejected with 401 rather than falling back to
 * an anonymous scope (which would risk leaking another wallet's records).
 */
function requirePrincipal(req: Request): string | null {
  const principal = (req as Request & { user?: { walletAddress?: string } }).user;
  const address = principal?.walletAddress;
  if (typeof address !== "string" || address.trim().length === 0) return null;
  return address.trim();
}

/** Parse an ISO-8601 date bound; returns null when absent, undefined when invalid. */
function parseDateBound(raw: unknown): Date | null | undefined {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

/**
 * POST /api/v1/analytics/exports
 *
 * Create a bounded, resumable export job owned by the authenticated wallet.
 */
export async function createExportJobHandler(req: Request, res: Response) {
  const owner = requirePrincipal(req);
  if (!owner) {
    sendApiError(res, new ApiError("UNAUTHENTICATED", "Authentication required"));
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const format = body.format;
  const direction = body.direction ?? "all";

  if (!isExportFormat(format)) {
    sendApiError(
      res,
      new ApiError("INVALID_FORMAT", "Invalid export format", {
        details: [{ field: "format", issue: "must be one of: csv, json" }],
      })
    );
    return;
  }
  if (!isExportDirection(direction)) {
    sendApiError(
      res,
      new ApiError("INVALID_DIRECTION", "Invalid export direction", {
        details: [{ field: "direction", issue: "must be one of: all, in, out" }],
      })
    );
    return;
  }

  const from = parseDateBound(body.from);
  const to = parseDateBound(body.to);
  if (from === undefined || to === undefined) {
    sendApiError(
      res,
      new ApiError("INVALID_DATE_RANGE", "Invalid date range", {
        details: [{ field: "from/to", issue: "must be ISO-8601 timestamps" }],
      })
    );
    return;
  }
  if (from && to && from.getTime() > to.getTime()) {
    sendApiError(
      res,
      new ApiError("INVALID_DATE_RANGE", "from must not be after to")
    );
    return;
  }

  const network = parseNetworkParam(req);
  if (network === "") {
    sendApiError(res, 400, "INVALID_NETWORK", "network must be a non-empty string");
    return;
  }

  try {
    const job = await createExportJob({
      owner,
      format: format as ExportFormat,
      direction: direction as ExportDirection,
      from: from ?? undefined,
      to: to ?? undefined,
      network,
    });
    res.status(202).json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        expiresAt: job.expiresAt,
        schemaVersion: EXPORT_SCHEMA_VERSION,
      },
    });
  } catch (error) {
    if (isUnknownNetworkError(error)) {
      sendApiError(res, 400, "INVALID_NETWORK", "unknown network");
      return;
    }
    logger.error("export job creation failed:", error);
    sendApiError(res, new ApiError("EXPORT_UNAVAILABLE", "Export unavailable"));
  }
}

/**
 * GET /api/v1/analytics/exports/:jobId
 *
 * Ownership-checked job status with cursor/progress for resumable clients.
 */
export async function getExportJobHandler(req: Request, res: Response) {
  const owner = requirePrincipal(req);
  if (!owner) {
    sendApiError(res, new ApiError("UNAUTHENTICATED", "Authentication required"));
    return;
  }

  try {
    const job = await getExportJob(req.params.jobId, owner);
    if (!job) {
      sendApiError(res, new ApiError("EXPORT_NOT_FOUND", "Export job not found"));
      return;
    }
    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        cursor: job.cursor,
        progress: job.progress,
        expiresAt: job.expiresAt,
        schemaVersion: EXPORT_SCHEMA_VERSION,
      },
    });
  } catch (error) {
    if (isExportForbidden(error)) {
      sendApiError(res, new ApiError("EXPORT_FORBIDDEN", "Export job belongs to another wallet"));
      return;
    }
    logger.error("export job status failed:", error);
    sendApiError(res, new ApiError("EXPORT_UNAVAILABLE", "Export unavailable"));
  }
}

/**
 * POST /api/v1/analytics/exports/:jobId/cancel
 */
export async function cancelExportJobHandler(req: Request, res: Response) {
  const owner = requirePrincipal(req);
  if (!owner) {
    sendApiError(res, new ApiError("UNAUTHENTICATED", "Authentication required"));
    return;
  }

  try {
    const result = await cancelExportJob(req.params.jobId, owner);
    if (result === "not_found") {
      sendApiError(res, new ApiError("EXPORT_NOT_FOUND", "Export job not found"));
      return;
    }
    if (result === "forbidden") {
      sendApiError(res, new ApiError("EXPORT_FORBIDDEN", "Export job belongs to another wallet"));
      return;
    }
    if (result === "not_cancellable") {
      sendApiError(
        res,
        new ApiError("EXPORT_NOT_CANCELLABLE", "Export job can no longer be cancelled")
      );
      return;
    }
    res.json({ success: true, data: { jobId: req.params.jobId, status: "cancelled" } });
  } catch (error) {
    logger.error("export job cancellation failed:", error);
    sendApiError(res, new ApiError("EXPORT_UNAVAILABLE", "Export unavailable"));
  }
}

/**
 * GET /api/v1/analytics/exports/:jobId/download
 *
 * Authorization: owner + not expired + completed. Streams the artifact with a
 * Content-Disposition attachment and the documented schema version header.
 */
export async function downloadExportHandler(req: Request, res: Response) {
  const owner = requirePrincipal(req);
  if (!owner) {
    sendApiError(res, new ApiError("UNAUTHENTICATED", "Authentication required"));
    return;
  }

  try {
    const result = await getExportArtifact(req.params.jobId, owner);
    if (result === "not_found") {
      sendApiError(res, new ApiError("EXPORT_NOT_FOUND", "Export job not found"));
      return;
    }
    if (result === "forbidden") {
      sendApiError(res, new ApiError("EXPORT_FORBIDDEN", "Export job belongs to another wallet"));
      return;
    }
    if (result === "expired") {
      sendApiError(res, new ApiError("EXPORT_EXPIRED", "Export artifact has expired"));
      return;
    }
    if (result === "not_ready") {
      sendApiError(res, new ApiError("EXPORT_NOT_READY", "Export job is not complete"));
      return;
    }

    const { artifact } = result;
    res.setHeader("Content-Type", artifact.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${artifact.filename}"`
    );
    res.setHeader("X-Export-Schema-Version", EXPORT_SCHEMA_VERSION);
    res.send(artifact.body);
  } catch (error) {
    logger.error("export download failed:", error);
    sendApiError(res, new ApiError("EXPORT_UNAVAILABLE", "Export unavailable"));
  }
}

/**
 * GET /api/v1/analytics/exports/activity
 *
 * Synchronous, bounded accounting-friendly activity export. Columns carry
 * explicit units, network identifiers, transaction references and UTC
 * timestamps; only records owned by the caller are included.
 */
export async function getWalletActivityExportHandler(req: Request, res: Response) {
  const owner = requirePrincipal(req);
  if (!owner) {
    sendApiError(res, new ApiError("UNAUTHENTICATED", "Authentication required"));
    return;
  }

  const format = req.query.format ?? "csv";
  if (!isExportFormat(format)) {
    sendApiError(
      res,
      new ApiError("INVALID_FORMAT", "Invalid export format", {
        details: [{ field: "format", issue: "must be one of: csv, json" }],
      })
    );
    return;
  }

  const from = parseDateBound(req.query.from);
  const to = parseDateBound(req.query.to);
  if (from === undefined || to === undefined) {
    sendApiError(
      res,
      new ApiError("INVALID_DATE_RANGE", "Invalid date range", {
        details: [{ field: "from/to", issue: "must be ISO-8601 timestamps" }],
      })
    );
    return;
  }
  if (from && to && from.getTime() > to.getTime()) {
    sendApiError(
      res,
      new ApiError("INVALID_DATE_RANGE", "from must not be after to")
    );
    return;
  }

  const network = parseNetworkParam(req);
  if (network === "") {
    sendApiError(res, 400, "INVALID_NETWORK", "network must be a non-empty string");
    return;
  }

  try {
    const artifact = await buildWalletActivityExport({
      owner,
      format: format as ExportFormat,
      from: from ?? undefined,
      to: to ?? undefined,
      network,
    });
    res.setHeader("Content-Type", artifact.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${artifact.filename}"`
    );
    res.setHeader("X-Export-Schema-Version", EXPORT_SCHEMA_VERSION);
    res.send(artifact.body);
  } catch (error) {
    if (isUnknownNetworkError(error)) {
      sendApiError(res, 400, "INVALID_NETWORK", "unknown network");
      return;
    }
    if (isExportLimitError(error)) {
      sendApiError(
        res,
        new ApiError("EXPORT_TOO_LARGE", "Export exceeds the maximum result size")
      );
      return;
    }
    logger.error("wallet activity export failed:", error);
    sendApiError(res, new ApiError("EXPORT_UNAVAILABLE", "Export unavailable"));
  }
}

function isExportForbidden(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EXPORT_FORBIDDEN"
  );
}

function isExportLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EXPORT_TOO_LARGE"
  );
}
