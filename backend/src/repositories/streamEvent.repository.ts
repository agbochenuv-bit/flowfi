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

/** A single event row to persist via the batched helper. */
export interface StreamEventCreateInput {
  txHash: string;
  logIndex: number;
  eventType: string;
  streamId?: string | null;
  actor?: string | null;
  amount?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  ledger?: number | null;
  timestamp?: Date | string | null;
}

/** Minimal transaction client surface required by the batched helper. */
export type StreamEventTxClient = Pick<Prisma.TransactionClient, "streamEvent">;

/**
 * Persist a bounded batch of stream events in a single round trip.
 *
 * Uses `createMany({ skipDuplicates: true })` so that re-processing a ledger
 * range (e.g. after a worker crash/retry) never raises unique-constraint
 * errors and never inserts duplicate rows: event-level idempotency is
 * preserved by the existing `(txHash, logIndex)` unique constraint.
 *
 * The caller is expected to pass a transaction client (`tx`) so the batch
 * insert and the cursor advance commit atomically. When omitted, the batch
 * runs against the shared `prisma` client (single statement, still atomic).
 *
 * Returns the number of rows actually inserted (duplicates are skipped).
 */
export async function createManySkipDuplicates(
  events: StreamEventCreateInput[],
  tx: StreamEventTxClient = prisma,
): Promise<number> {
  if (events.length === 0) return 0;

  const result = await tx.streamEvent.createMany({
    data: events.map((event) => ({
      txHash: event.txHash,
      logIndex: event.logIndex,
      eventType: event.eventType,
      streamId: event.streamId ?? null,
      actor: event.actor ?? null,
      amount: event.amount ?? null,
      metadata: event.metadata ?? undefined,
      ledger: event.ledger ?? null,
      timestamp: event.timestamp ?? undefined,
    })),
    skipDuplicates: true,
  });

  return result.count;
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
  /** When true, each event includes its related `stream`. Defaults to false. */
  includeStream?: boolean;
}

export interface ListEventsForWalletResult {
  events: unknown[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * List stream events where the given wallet was either the sender or the
 * recipient of the underlying stream, most recent first.
 */
export async function listEventsForWallet(
  params: ListEventsForWalletParams,
): Promise<ListEventsForWalletResult> {
  const { address, types = [], limit, offset, includeStream = false } = params;

  const where: Prisma.StreamEventWhereInput = {
    stream: {
      OR: [{ sender: address }, { recipient: address }],
    },
  };
  if (types.length > 0) {
    where.eventType = { in: types };
  }

  const [events, total] = await Promise.all([
    prisma.streamEvent.findMany({
      where,
      orderBy: { timestamp: "desc" },
      skip: offset,
      take: limit,
      ...(includeStream ? { include: { stream: true } } : {}),
    }),
    prisma.streamEvent.count({ where }),
  ]);

  return {
    events,
    total,
    limit,
    offset,
    hasMore: offset + events.length < total,
  };
}
