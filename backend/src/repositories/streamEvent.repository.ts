import { prisma } from "../lib/prisma.js";
import type { Prisma } from "../generated/prisma/index.js";

/**
 * Shared query logic for "paginated stream events by sender/recipient
 * wallet", previously duplicated between:
 *   - GET /v1/users/:publicKey/events (backend/src/controllers/user.controller.ts)
 *   - GET /v1/events                  (backend/src/routes/v1/events.routes.ts)
 *
 * See issue #1271.
 */

/** Event types recognized by the `type`/`eventType` filter. */
export const EVENT_TYPES = new Set([
  "CREATED",
  "TOPPED_UP",
  "WITHDRAWN",
  "CANCELLED",
  "COMPLETED",
  "PAUSED",
  "RESUMED",
  "FEE_COLLECTED",
  "FEE_CONFIG_UPDATED",
  "ADMIN_TRANSFERRED",
]);

export const MAX_EVENTS_PAGE_SIZE = 200;
export const DEFAULT_EVENTS_PAGE_SIZE = 50;

/**
 * Parse a raw, comma-separated `type` query parameter (e.g. "paused,resumed")
 * into the set of recognized, upper-cased event types.
 *
 * `requested` is every token the caller asked for (trimmed/upper-cased),
 * `types` is the subset of those that are recognized. Comparing the two
 * lets a caller distinguish "no filter requested" from "a filter was
 * requested but none of the values were valid" (the latter is a 400 in
 * both existing endpoints).
 */
export function parseEventTypeFilter(rawType: unknown): {
  requested: string[];
  types: string[];
} {
  const raw = typeof rawType === "string" ? rawType : "";
  const requested = raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const types = requested.filter((t) => EVENT_TYPES.has(t));
  return { requested, types };
}

/**
 * Resolve a validated page size from a raw `limit` query value, clamped to
 * [1, MAX_EVENTS_PAGE_SIZE] and falling back to DEFAULT_EVENTS_PAGE_SIZE
 * when missing or invalid.
 */
export function resolveEventsPageSize(rawLimit: unknown): number {
  const parsed = Number.parseInt(
    typeof rawLimit === "string" ? rawLimit : String(rawLimit ?? ""),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, MAX_EVENTS_PAGE_SIZE)
    : DEFAULT_EVENTS_PAGE_SIZE;
}

/**
 * Resolve a validated `offset` from raw `offset`/`page` query values.
 * An explicit, valid, non-negative `offset` always wins; otherwise a
 * 1-based `page` is converted to an offset using `limit`; otherwise 0.
 */
export function resolveEventsOffset(params: {
  rawOffset: unknown;
  rawPage?: unknown;
  limit: number;
}): number {
  const { rawOffset, rawPage, limit } = params;

  const hasOffset =
    rawOffset !== undefined && rawOffset !== null && rawOffset !== "";
  if (hasOffset) {
    const parsedOffset = Number.parseInt(
      typeof rawOffset === "string" ? rawOffset : String(rawOffset),
      10,
    );
    if (Number.isFinite(parsedOffset) && parsedOffset >= 0) {
      return parsedOffset;
    }
  }

  const parsedPage = Number.parseInt(
    typeof rawPage === "string" ? rawPage : String(rawPage ?? ""),
    10,
  );
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  return Math.max(0, (page - 1) * limit);
}

export interface ListEventsForWalletParams {
  /** Stellar public key to match as either the stream sender or recipient. */
  address: string;
  /** Already-validated, upper-cased event types to filter by (see parseEventTypeFilter). Empty/omitted = no filter. */
  types?: string[];
  /** Page size (already clamped by the caller, e.g. via resolveEventsPageSize). */
  limit: number;
  /** Row offset (already resolved by the caller, e.g. via resolveEventsOffset). */
  offset: number;
  /** Last event ID from the previous cursor page. */
  cursor?: string;
  /** Stable event ordering direction. */
  order?: 'asc' | 'desc';
  /** When true, each event includes its related `stream`. Defaults to false. */
  includeStream?: boolean;
}

export interface ListEventsForWalletResult {
  events: unknown[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * List stream events where the given wallet was either the sender or the
 * recipient of the underlying stream, most recent first.
 */
export async function listEventsForWallet(
  params: ListEventsForWalletParams,
): Promise<ListEventsForWalletResult> {
  const {
    address,
    types = [],
    limit,
    offset,
    cursor,
    order = 'desc',
    includeStream = false,
  } = params;

  const where: Prisma.StreamEventWhereInput = {
    stream: {
      OR: [{ sender: address }, { recipient: address }],
    },
  };
  if (types.length > 0) {
    where.eventType = { in: types };
  }

  // Deterministic ordering: ledgerSequence is the canonical blockchain total
  // order (no two events in different ledgers share a sequence number). Within
  // the same ledger, id (UUID v4) provides a stable tiebreaker. This replaces
  // the old (timestamp, id) ordering — timestamp is wall-clock time set at
  // indexing time and can collide or be slightly skewed for events in the same
  // ledger, making the sort non-deterministic under concurrent indexer replicas.
  const [queriedEvents, total] = await Promise.all([
    prisma.streamEvent.findMany({
      where,
      orderBy: [{ ledgerSequence: order }, { id: order }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : { skip: offset }),
      take: cursor ? limit + 1 : limit,
      ...(includeStream ? { include: { stream: true } } : {}),
    }),
    prisma.streamEvent.count({ where }),
  ]);

  const hasMore = cursor
    ? queriedEvents.length > limit
    : offset + queriedEvents.length < total;
  const events = queriedEvents.slice(0, limit);
  const lastEvent = events.at(-1) as { id?: string } | undefined;

  return {
    events,
    total,
    limit,
    offset,
    hasMore,
    nextCursor: hasMore && typeof lastEvent?.id === 'string' ? lastEvent.id : null,
  };
}
