import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";
import { STELLAR_PUBLIC_KEY_REGEX } from "../validators/user.validator.js";
import type { AuthenticatedRequest } from "../types/auth.types.js";
import {
  listEventsForWallet,
  parseEventTypeFilter,
  resolveEventsOffset,
  resolveEventsPageSize,
} from "../repositories/streamEvent.repository.js";
import * as exportService from "../services/export.service.js";
import { ApiError } from "../types/api-error.js";

/**
 * Reads a validated value from `res.locals.validated`, populated by the
 * centralized validation middleware. Falls back to the raw request value
 * when the middleware has not run (e.g. legacy direct controller tests).
 */
const validated = <T>(
  res: Response,
  key: "body" | "params" | "query",
  fallback: T,
): T => {
  const store = res.locals?.validated as
    | Partial<Record<"body" | "params" | "query", unknown>>
    | undefined;
  const value = store?.[key];
  return (value ?? fallback) as T;
};

/**
 * Ensures the authenticated wallet matches the wallet addressed by the
 * request. Throws a 403 ApiError otherwise. Requests without an
 * authenticated user (public endpoints) are not restricted here.
 */
const assertWalletOwnership = (req: Request, publicKey: string): void => {
  const authReq = req as AuthenticatedRequest;
  const authenticatedKey = authReq.user?.publicKey;
  if (!authenticatedKey) return;
  if (authenticatedKey !== publicKey) {
    throw new ApiError(403, "FORBIDDEN", "Not authorized for this wallet");
  }
};

/**
 * Public shape of a Stream, used when embedding streams inside a public
 * user response. Excludes nothing sensitive today, but is kept explicit
 * so newly added internal-only fields on the Stream model are not
 * leaked automatically.
 */
const publicStreamSelect = {
  id: true,
  streamId: true,
  sender: true,
  recipient: true,
  tokenAddress: true,
  ratePerSecond: true,
  depositedAmount: true,
  withdrawnAmount: true,
  startTime: true,
  lastUpdateTime: true,
  endTime: true,
  isActive: true,
  isPaused: true,
  pausedAt: true,
  totalPausedDuration: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Public shape of a User. Limits the response to fields that are safe to
 * expose to any caller, so internal-only fields added to the User model
 * later are excluded by default rather than leaked automatically.
 */
const publicUserSelect = {
  id: true,
  publicKey: true,
  createdAt: true,
  updatedAt: true,
  sentStreams: {
    take: 10,
    orderBy: { createdAt: "desc" as const },
    select: publicStreamSelect,
  },
  receivedStreams: {
    take: 10,
    orderBy: { createdAt: "desc" as const },
    select: publicStreamSelect,
  },
};

/**
 * Register a new wallet public key
 */
export const registerUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { publicKey } = validated<{ publicKey: string }>(res, "body", req.body);

    // Check if user already exists
    let user = await prisma.user.findUnique({
      where: { publicKey },
    });

    if (user) {
      return res.status(200).json(user);
    }

    // Create new user
    user = await prisma.user.create({
      data: { publicKey },
    });

    logger.info(`User registered: ${publicKey}`);
    return res.status(201).json(user);
  } catch (error) {
    return next(error);
  }
};

/**
 * Get user by public key
 */
export const getUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { publicKey } = validated<{ publicKey: string }>(
      res,
      "params",
      req.params as { publicKey: string },
    );
    if (typeof publicKey !== "string") {
      throw new ApiError(400, "INVALID_PUBLIC_KEY", "Invalid publicKey parameter");
    }
    if (!STELLAR_PUBLIC_KEY_REGEX.test(publicKey)) {
      throw new ApiError(400, "INVALID_PUBLIC_KEY", "Invalid Stellar public key format");
    }

    assertWalletOwnership(req, publicKey);

    const user = await prisma.user.findUnique({
      where: { publicKey },
      select: publicUserSelect,
    });

    if (!user) {
      throw new ApiError(404, "NOT_FOUND", "User not found");
    }

    return res.status(200).json(user);
  } catch (error) {
    return next(error);
  }
};

/**
 * Get user events (history) - paginated list of stream events where the
 * given wallet was either the sender or recipient.
 *
 * Query params:
 *   - type: optional comma-separated list of event types to filter by
 *     (e.g. "PAUSED,RESUMED"); unknown values are ignored, and a filter
 *     consisting entirely of unknown values is rejected with 400.
 *   - limit, offset, page: pagination (see repositories/streamEvent.repository.ts)
 *   - includeStream: set to "false" to omit the related `stream` object
 *     from each event (included by default, matching this endpoint's
 *     historical behavior).
 */
export const getUserEvents = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { publicKey } = validated<{ publicKey: string }>(
      res,
      "params",
      req.params as { publicKey: string },
    );
    if (typeof publicKey !== "string") {
      throw new ApiError(400, "INVALID_PUBLIC_KEY", "Invalid publicKey parameter");
    }
    if (!STELLAR_PUBLIC_KEY_REGEX.test(publicKey)) {
      throw new ApiError(400, "INVALID_PUBLIC_KEY", "Invalid Stellar public key format");
    }

    assertWalletOwnership(req, publicKey);

    const query = validated<Record<string, unknown>>(
      res,
      "query",
      req.query as Record<string, unknown>,
    );

    const { requested, types } = parseEventTypeFilter(query["type"]);
    if (requested.length > 0 && types.length === 0) {
      throw new ApiError(400, "INVALID_EVENT_TYPE", "No valid event types in `type` filter");
    }

    const limit = resolveEventsPageSize(query["limit"]);
    const offset = resolveEventsOffset({
      rawOffset: query["offset"],
      rawPage: query["page"],
      limit,
    });

    // Preserve this endpoint's historical behavior of always embedding the
    // related stream, unless the caller opts out.
    const includeStream = query["includeStream"] !== "false";

    const result = await listEventsForWallet({
      address: publicKey,
      types,
      limit,
      offset,
      includeStream,
    });

    return res.status(200).json({
      data: result.events,
      total: result.total,
      hasMore: result.hasMore,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Get current authenticated user
 * Requires authMiddleware to be applied
 */
export const getCurrentUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { publicKey } = authReq.user;

    // Try to get user from database
    let user = await prisma.user.findUnique({
      where: { publicKey },
      include: {
        sentStreams: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
        receivedStreams: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
      },
    });

    // If user doesn't exist in database, create in-memory user object
    if (!user) {
      logger.info(
        `User ${publicKey} authenticated but not in database, returning in-memory user`,
      );
      return res.status(200).json({
        publicKey,
        sentStreams: [],
        receivedStreams: [],
        inMemory: true,
      });
    }

    return res.status(200).json(user);
  } catch (error) {
    return next(error);
  }
};

/**
 * Export user transactions for accounting and tax purposes (Issue #1191)
 */
export const exportTransactions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const params = validated<{ address?: string | string[] }>(
      res,
      "params",
      req.params as { address?: string | string[] },
    );
    const addressParam = params.address;
    const address = Array.isArray(addressParam)
      ? addressParam[0]
      : addressParam;

    if (!address || !STELLAR_PUBLIC_KEY_REGEX.test(address)) {
      throw new ApiError(400, "INVALID_ADDRESS", "Invalid Stellar address");
    }

    assertWalletOwnership(req, address);

    const query = validated<Record<string, unknown>>(
      res,
      "query",
      req.query as Record<string, unknown>,
    );

    const format = (query.format as string) || "csv";
    const direction =
      (query.direction as "incoming" | "outgoing" | "all") || "all";
    const startDate = query.startDate
      ? new Date(query.startDate as string)
      : null;
    const endDate = query.endDate
      ? new Date(query.endDate as string)
      : null;
    const tokenAddress = (query.tokenAddress as string | null) || null;

    if (!["csv", "json"].includes(format)) {
      throw new ApiError(400, "INVALID_FORMAT", "Invalid format. Must be csv or json");
    }

    if (!["incoming", "outgoing", "all"].includes(direction)) {
      throw new ApiError(400, "INVALID_DIRECTION", "Invalid direction. Must be incoming, outgoing, or all");
    }

    const options: exportService.ExportOptions = {
      format: format as "csv" | "json",
      direction,
      startDate,
      endDate,
      tokenAddress,
    };

    if (format === "csv") {
      await exportService.streamTransactionCSV(address, options, res);
    } else {
      await exportService.streamTransactionJSON(address, options, res);
    }
  } catch (error) {
    logger.error("[Export] Error:", error);
    if (!res.headersSent) {
      return next(error);
    }
  }
};
