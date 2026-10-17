import { prisma } from '../lib/prisma.js';

/**
 * Stable error codes surfaced to API consumers for cursor pagination.
 * These codes are part of the public contract and must remain stable.
 */
export const CURSOR_ERROR_CODES = {
  MALFORMED: 'INVALID_CURSOR',
  EXPIRED: 'CURSOR_EXPIRED',
} as const;

export type CursorErrorCode = (typeof CURSOR_ERROR_CODES)[keyof typeof CURSOR_ERROR_CODES];

export class CursorError extends Error {
  public readonly code: CursorErrorCode;

  constructor(code: CursorErrorCode, message: string) {
    super(message);
    this.name = 'CursorError';
    this.code = code;
  }
}

/**
 * Default lifetime of an issued cursor. After this window a cursor is
 * rejected with `CURSOR_EXPIRED` so that consumers re-fetch from the head.
 */
export const DEFAULT_CURSOR_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Fields that may be used as the primary sort key for stream listing.
 * The cursor is always a `(sortKey, streamId)` tuple so ordering is
 * deterministic even when many rows share the same sortKey value.
 */
const SORTABLE_FIELDS = ['startTime', 'createdAt', 'streamId'] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

interface CursorPayload {
  /** Issued-at timestamp (ms since epoch) used for expiry checks. */
  iat: number;
  /** Sort field the cursor was issued for. */
  f: SortableField;
  /** Sort direction the cursor was issued for. */
  o: 'asc' | 'desc';
  /** Value of the sort key for the last row on the previous page. */
  v: string | number | null;
  /** Tie-breaker: streamId of the last row on the previous page. */
  id: string;
}

const encodeCursor = (payload: CursorPayload): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const decodeCursor = (cursor: string, now: number, ttlMs: number): CursorPayload => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError(CURSOR_ERROR_CODES.MALFORMED, 'Cursor is not valid base64url JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new CursorError(CURSOR_ERROR_CODES.MALFORMED, 'Cursor payload must be an object');
  }

  const p = parsed as Record<string, unknown>;
  if (
    typeof p.iat !== 'number' ||
    typeof p.f !== 'string' ||
    !SORTABLE_FIELDS.includes(p.f as SortableField) ||
    (p.o !== 'asc' && p.o !== 'desc') ||
    !('v' in p) ||
    typeof p.id !== 'string'
  ) {
    throw new CursorError(CURSOR_ERROR_CODES.MALFORMED, 'Cursor payload is missing required fields');
  }

  if (now - p.iat > ttlMs) {
    throw new CursorError(CURSOR_ERROR_CODES.EXPIRED, 'Cursor has expired');
  }

  return {
    iat: p.iat,
    f: p.f as SortableField,
    o: p.o as 'asc' | 'desc',
    v: (p.v as string | number | null) ?? null,
    id: p.id,
  };
};

/**
 * Update the status and active flag of a stream in the database.
 */
export const updateStatus = async (streamId: bigint, status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'PAUSED') => {
  return prisma.stream.update({
    where: { streamId },
    data: {
      isActive: status === 'ACTIVE' || status === 'PAUSED',
      // Note: we don't have a 'status' field in the Stream model yet,
      // it seems status is derived from isActive and events.
      // However, we can update isActive to false for CANCELLED/COMPLETED.
    }
  });
};

type StreamWhere = {
  sender?: string;
  recipient?: string;
  tokenAddress?: string;
  isActive?: boolean;
  isPaused?: boolean;
  events?: { some: { eventType: string } };
};

export interface FindStreamsParams {
  status?: 'active' | 'paused' | 'cancelled' | 'completed';
  sender?: string;
  recipient?: string;
  tokenAddress?: string;
  limit: number;
  /** Offset-based pagination (legacy). Ignored when `cursor` is provided. */
  offset?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  /** Opaque cursor returned by a previous call. When set, `offset` is ignored. */
  cursor?: string;
  /** Override the cursor TTL (ms). Primarily for tests. */
  cursorTtlMs?: number;
}

export interface FindStreamsResult {
  streams: unknown[];
  total: number;
  hasMore: boolean;
  /** Opaque cursor to fetch the next page. Present only when `hasMore` is true. */
  nextCursor?: string;
  /** Issued-at timestamp (ms since epoch) of `nextCursor`, for expiry metadata. */
  cursorIssuedAt?: number;
}

export const findStreams = async (params: FindStreamsParams): Promise<FindStreamsResult> => {
  const where: StreamWhere = {};

  if (params.sender) where.sender = params.sender;
  if (params.recipient) where.recipient = params.recipient;
  if (params.tokenAddress) where.tokenAddress = params.tokenAddress;

  if (params.status) {
    switch (params.status) {
      case 'active':
        where.isActive = true;
        where.isPaused = false;
        break;
      case 'paused':
        where.isPaused = true;
        break;
      case 'cancelled':
        where.isActive = false;
        where.events = { some: { eventType: 'CANCELLED' } };
        break;
      case 'completed':
        where.isActive = false;
        where.events = { some: { eventType: 'COMPLETED' } };
        break;
    }
  }

  const requestedSortField = params.sortField || 'startTime';
  const sortField: SortableField = (SORTABLE_FIELDS as readonly string[]).includes(requestedSortField)
    ? (requestedSortField as SortableField)
    : 'startTime';
  const sortOrder = params.sortOrder || 'desc';

  const now = Date.now();
  const ttlMs = params.cursorTtlMs ?? DEFAULT_CURSOR_TTL_MS;

  // Decode the cursor (if any) and build a deterministic `(sortKey, id)` filter.
  let cursorFilter: Record<string, unknown> | undefined;
  let decoded: CursorPayload | undefined;
  if (params.cursor) {
    decoded = decodeCursor(params.cursor, now, ttlMs);
    if (decoded.f !== sortField || decoded.o !== sortOrder) {
      throw new CursorError(
        CURSOR_ERROR_CODES.MALFORMED,
        'Cursor does not match the requested sort field/order',
      );
    }

    const op = sortOrder === 'asc' ? 'gt' : 'lt';
    const tuple: Record<string, unknown>[] = [];
    if (decoded.v !== null) {
      tuple.push({ [sortField]: { [op]: decoded.v } });
      tuple.push({ [sortField]: decoded.v, streamId: { [op]: BigInt(decoded.id) } });
    } else {
      tuple.push({ streamId: { [op]: BigInt(decoded.id) } });
    }
    cursorFilter = { OR: tuple };
  }

  const effectiveWhere = cursorFilter ? { AND: [where, cursorFilter] } : where;

  // Fetch limit + 1 to detect whether another page exists without a count query.
  const rows = await prisma.stream.findMany({
    where: effectiveWhere,
    orderBy: [{ [sortField]: sortOrder }, { streamId: sortOrder }],
    take: params.limit + 1,
    ...(params.cursor ? {} : { skip: params.offset ?? 0 }),
    include: {
      senderUser: true,
      recipientUser: true,
    },
  });

  const hasMore = rows.length > params.limit;
  const streams = hasMore ? rows.slice(0, params.limit) : rows;

  // `total` is only meaningful for offset-based (legacy) pagination. For cursor
  // pagination we avoid an expensive count and report the rows seen so far.
  const total = params.cursor
    ? (params.offset ?? 0) + streams.length + (hasMore ? 1 : 0)
    : await prisma.stream.count({ where });

  let nextCursor: string | undefined;
  let cursorIssuedAt: number | undefined;
  if (hasMore && streams.length > 0) {
    const last = streams[streams.length - 1] as Record<string, unknown>;
    const lastId = last.streamId as bigint;
    const lastSortValue = last[sortField];
    cursorIssuedAt = now;
    nextCursor = encodeCursor({
      iat: now,
      f: sortField,
      o: sortOrder,
      v: lastSortValue === undefined ? null : (lastSortValue as string | number | null),
      id: lastId.toString(),
    });
  }

  return { streams, total, hasMore, nextCursor, cursorIssuedAt };
};
