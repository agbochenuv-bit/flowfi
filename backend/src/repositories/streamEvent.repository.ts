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

/**
 * Cursor pagination (issue #73).
 *
 * Cursors are opaque, base64url-encoded tokens that encode the sort key of
 * the last row on the previous page. Ordering is deterministic: events are
 * sorted by `timestamp DESC, id DESC`, so rows sharing a timestamp are still
 * totally ordered by their unique `id`. Keyset pagination on that composite
 * key means concurrent inserts/updates cannot cause rows to be skipped or
 * duplicated across page boundaries (unlike offset pagination).
 *
 * Cursors expire after CURSOR_TTL_MS. Expiry is enforced by embedding the
 * issue time in the token; an expired cursor is rejected with
 * CursorError("expired") so callers can restart from the first page.
 */

/** How long a cursor remains valid after it was issued. */
export const CURSOR_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Error thrown for malformed, tampered-with, or expired cursors. */
export class CursorError extends Error {
  readonly code: "invalid_cursor" | "expired_cursor";

  constructor(code: "invalid_cursor" | "expired_cursor", message: string) {
    super(message);
    this.name = "CursorError";
    this.code = code;
  }
}

/** Decoded cursor payload: the sort key of the last row of the previous page. */
export interface EventCursor {
  /** ISO-8601 timestamp of the last row on the previous page. */
  timestamp: string;
  /** Unique id of the last row on the previous page (tie-breaker). */
  id: string;
  /** Epoch milliseconds at which the cursor was issued. */
  issuedAt: number;
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

/**
 * Encode an opaque cursor from the last row of a page.
 * `now` is injectable for deterministic tests.
 */
export function encodeEventCursor(
  row: { timestamp: Date | string; id: string },
  now: number = Date.now(),
): string {
  const timestamp =
    row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp;
  const payload: EventCursor = { timestamp, id: row.id, issuedAt: now };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode and validate an opaque cursor. Throws CursorError for malformed
 * tokens ("invalid_cursor") or tokens older than CURSOR_TTL_MS
 * ("expired_cursor"). `now` is injectable for deterministic tests.
 */
export function decodeEventCursor(
  cursor: string,
  now: number = Date.now(),
): EventCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(cursor));
  } catch {
    throw new CursorError("invalid_cursor", "Malformed cursor");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as EventCursor).timestamp !== "string" ||
    typeof (parsed as EventCursor).id !== "string" ||
    typeof (parsed as EventCursor).issuedAt !== "number" ||
    !Number.isFinite((parsed as EventCursor).issuedAt)
  ) {
    throw new CursorError("invalid_cursor", "Malformed cursor");
  }

  const decoded = parsed as EventCursor;
  if (Number.isNaN(Date.parse(decoded.timestamp))) {
    throw new CursorError("invalid_cursor", "Malformed cursor");
  }

  if (now - decoded.issuedAt > CURSOR_TTL_MS) {
    throw new CursorError("expired_cursor", "Cursor has expired");
  }

  return decoded;
}

export interface ListEventsForWalletParams {
  /** Stellar public key to match as either the stream sender or recipient. */
  address: string;
  /** Already-validated, upper-cased event types to filter by (see parseEventTypeFilter). Empty/omitted = no filter. */
  types?: string[];
  /** Page size (already clamped by the caller, e.g. via resolveEventsPageSize). */
  limit: number;
  /** Row offset (already resolved by the caller, e.g. via resolveEventsOffset). Ignored when `cursor` is set. */
  offset: number;
  /** When true, each event includes its related `stream`. Defaults to false. */
  includeStream?: boolean;
  /**
   * Optional opaque cursor from a previous page's `nextCursor`. When set,
   * keyset pagination is used instead of `offset`. Throws CursorError for
   * malformed/expired cursors.
   */
  cursor?: string;
  /** Injectable clock for cursor expiry checks (tests). */
  now?: number;
}

export interface ListEventsForWalletResult {
  events: unknown[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Opaque cursor for the next page, or null when there are no more rows. */
  nextCursor: string | null;
}

/**
 * List stream events where the given wallet was either the sender or the
 * recipient of the underlying stream, most recent first.
 *
 * Ordering: `timestamp DESC, id DESC` (deterministic across equal timestamps).
 * When `cursor` is provided, keyset pagination is used and `offset` is ignored.
 */
export async function listEventsForWallet(
  params: ListEventsForWalletParams,
): Promise<ListEventsForWalletResult> {
  const {
    address,
    types = [],
    limit,
    offset,
    includeStream = false,
    cursor,
    now = Date.now(),
  } = params;

  const baseWhere: Prisma.StreamEventWhereInput = {
    stream: {
      OR: [{ sender: address }, { recipient: address }],
    },
  };
  if (types.length > 0) {
    baseWhere.eventType = { in: types };
  }

  const where: Prisma.StreamEventWhereInput = cursor
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { timestamp: { lt: new Date(decodeEventCursor(cursor, now).timestamp) } },
              {
                timestamp: new Date(decodeEventCursor(cursor, now).timestamp),
                id: { lt: decodeEventCursor(cursor, now).id },
              },
            ],
          },
        ],
      }
    : baseWhere;

  const decoded = cursor ? decodeEventCursor(cursor, now) : null;
  const keysetWhere: Prisma.StreamEventWhereInput = decoded
    ? {
        AND: [
          baseWhere,
          {
            OR: [
              { timestamp: { lt: new Date(decoded.timestamp) } },
              { timestamp: new Date(decoded.timestamp), id: { lt: decoded.id } },
            ],
          },
        ],
      }
    : baseWhere;

  // Fetch one extra row to determine `hasMore` without a second count query
  // when paginating by cursor.
  const take = decoded ? limit + 1 : limit;

  const [rows, total] = await Promise.all([
    prisma.streamEvent.findMany({
      where: keysetWhere,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      ...(decoded ? {} : { skip: offset }),
      take,
      ...(includeStream ? { include: { stream: true } } : {}),
    }),
    prisma.streamEvent.count({ where: baseWhere }),
  ]);

  const hasMore = decoded ? rows.length > limit : offset + rows.length < total;
  const events = decoded && rows.length > limit ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && events.length > 0) {
    const last = events[events.length - 1] as { timestamp: Date; id: string };
    nextCursor = encodeEventCursor(last, now);
  }

  return {
    events,
    total,
    limit,
    offset,
    hasMore,
    nextCursor,
  };
}
