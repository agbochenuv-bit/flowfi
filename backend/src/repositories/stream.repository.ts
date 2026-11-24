import { prisma } from '../lib/prisma.js';
import { runPostCommit, emitDomainEvent } from '../lib/postCommit.js';

/**
 * Emit `user.summary.invalidated` domain events for the given public keys.
 * Only unique, non-empty keys are emitted so duplicate events are avoided.
 */
const emitSummaryInvalidations = (publicKeys: Array<string | null | undefined>): void => {
  const unique = Array.from(new Set(publicKeys.filter((key): key is string => typeof key === 'string' && key.length > 0)));
  for (const publicKey of unique) {
    emitDomainEvent('user.summary.invalidated', { publicKey });
  }
};

/**
 * Update the status and active flag of a stream in the database.
 *
 * The mutation runs inside the post-commit helper: the summary cache is only
 * invalidated for the affected sender/recipient once the transaction commits.
 * A rolled-back mutation therefore never evicts cached summaries.
 */
export const updateStatus = async (streamId: bigint, status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'PAUSED') => {
  return runPostCommit(async (tx) => {
    const stream = await tx.stream.update({
      where: { streamId },
      data: {
        isActive: status === 'ACTIVE' || status === 'PAUSED',
        // Note: we don't have a 'status' field in the Stream model yet,
        // it seems status is derived from isActive and events.
        // However, we can update isActive to false for CANCELLED/COMPLETED.
      }
    });

    const affected = stream as { sender?: string | null; recipient?: string | null } | null;
    emitSummaryInvalidations([affected?.sender, affected?.recipient]);

    return stream;
  });
};

/**
 * Compare-and-set status update.
 *
 * Applies the status change only when the stream's current `version` matches
 * `expectedVersion`, incrementing the version atomically. Returns whether the
 * update was applied so callers can emit a 409 conflict when it was not.
 */
export const updateStatusIfVersion = async (
  streamId: bigint,
  expectedVersion: number,
  status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'PAUSED',
): Promise<boolean> => {
  const result = await prisma.stream.updateMany({
    where: { streamId, version: expectedVersion },
    data: {
      isActive: status === 'ACTIVE' || status === 'PAUSED',
      version: { increment: 1 },
    },
  });

  return result.count > 0;
};

/**
 * Fetch the current version of a stream, or null if the stream does not exist.
 * Used to build conflict payloads.
 */
export const getStreamVersion = async (streamId: bigint): Promise<number | null> => {
  const stream = await prisma.stream.findUnique({
    where: { streamId },
    select: { version: true },
  });

  return stream?.version ?? null;
};

type StreamStatusFilter = 'active' | 'paused' | 'cancelled' | 'completed';

type StreamStatusCondition = {
  isActive?: boolean;
  isPaused?: boolean;
  events?: { some: { eventType: string } };
};

type StreamWhere = {
  sender?: string | { contains: string; mode: 'insensitive' };
  recipient?: string | { contains: string; mode: 'insensitive' };
  tokenAddress?: string | { contains: string; mode: 'insensitive' };
  streamId?: bigint;
  isActive?: boolean;
  isPaused?: boolean;
  events?: { some: { eventType: string } };
  startTime?: { gte?: bigint; lte?: bigint };
  endTime?: { gte?: bigint; lte?: bigint };
  createdAt?: { gte?: Date; lte?: Date };
  AND?: StreamWhere[];
  OR?: StreamWhere[];
};

export interface FindStreamsParams {
  status?: StreamStatusFilter | undefined;
  statuses?: StreamStatusFilter[] | undefined;
  sender?: string | undefined;
  recipient?: string | undefined;
  participant?: string | undefined;
  tokenAddress?: string | undefined;
  search?: string | undefined;
  searchStreamId?: bigint | undefined;
  startTimeFrom?: bigint | undefined;
  startTimeTo?: bigint | undefined;
  endTimeFrom?: bigint | undefined;
  endTimeTo?: bigint | undefined;
  createdAfter?: Date | undefined;
  createdBefore?: Date | undefined;
  limit: number;
  offset: number;
  cursor?: string | undefined;
  sortField?: string | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
}

export interface FindStreamsResult {
  streams: unknown[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

function statusToCondition(status: StreamStatusFilter): StreamStatusCondition {
  switch (status) {
    case 'active':
      return { isActive: true, isPaused: false };
    case 'paused':
      return { isPaused: true };
    case 'cancelled':
      return { isActive: false, events: { some: { eventType: 'CANCELLED' } } };
    case 'completed':
      return { isActive: false, events: { some: { eventType: 'COMPLETED' } } };
  }
}

export function buildStreamWhere(params: FindStreamsParams): StreamWhere {
  const where: StreamWhere = {};
  const andConditions: StreamWhere[] = [];

  if (params.sender) where.sender = params.sender;
  if (params.recipient) where.recipient = params.recipient;
  if (params.tokenAddress) where.tokenAddress = params.tokenAddress;

  if (params.participant) {
    andConditions.push({
      OR: [{ sender: params.participant }, { recipient: params.participant }],
    });
  }

  const effectiveStatuses: StreamStatusFilter[] = [];
  if (params.statuses && params.statuses.length > 0) {
    effectiveStatuses.push(...params.statuses);
  }
  if (params.status && !effectiveStatuses.includes(params.status)) {
    effectiveStatuses.push(params.status);
  }

  if (effectiveStatuses.length === 1) {
    const onlyStatus = effectiveStatuses[0]!;
    Object.assign(where, statusToCondition(onlyStatus));
  } else if (effectiveStatuses.length > 1) {
    andConditions.push({
      OR: effectiveStatuses.map((s) => statusToCondition(s)),
    });
  }

  if (params.search) {
    const searchClauses: StreamWhere[] = [
      { sender: { contains: params.search, mode: 'insensitive' } },
      { recipient: { contains: params.search, mode: 'insensitive' } },
      { tokenAddress: { contains: params.search, mode: 'insensitive' } },
    ];
    if (params.searchStreamId !== undefined) {
      searchClauses.unshift({ streamId: params.searchStreamId });
    }
    andConditions.push({ OR: searchClauses });
  }

  if (params.startTimeFrom !== undefined || params.startTimeTo !== undefined) {
    where.startTime = {
      ...(params.startTimeFrom !== undefined ? { gte: params.startTimeFrom } : {}),
      ...(params.startTimeTo !== undefined ? { lte: params.startTimeTo } : {}),
    };
  }

  if (params.endTimeFrom !== undefined || params.endTimeTo !== undefined) {
    where.endTime = {
      ...(params.endTimeFrom !== undefined ? { gte: params.endTimeFrom } : {}),
      ...(params.endTimeTo !== undefined ? { lte: params.endTimeTo } : {}),
    };
  }

  if (params.createdAfter !== undefined || params.createdBefore !== undefined) {
    where.createdAt = {
      ...(params.createdAfter !== undefined ? { gte: params.createdAfter } : {}),
      ...(params.createdBefore !== undefined ? { lte: params.createdBefore } : {}),
    };
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}

export const findStreams = async (params: FindStreamsParams): Promise<FindStreamsResult> => {
  const where = buildStreamWhere(params);

  const sortField = params.sortField || 'startTime';
  const sortOrder = params.sortOrder || 'desc';

  const [streams, total] = await Promise.all([
    prisma.stream.findMany({
      where,
      orderBy: [{ [sortField]: sortOrder }, { streamId: sortOrder }],
      take: params.cursor ? params.limit + 1 : params.limit,
      ...(params.cursor
        ? { cursor: { streamId: BigInt(params.cursor) }, skip: 1 }
        : { skip: params.offset }),
      include: {
        senderUser: true,
        recipientUser: true,
      },
    }),
    prisma.stream.count({ where }),
  ]);

  const hasMore = params.cursor
    ? streams.length > params.limit
    : params.offset + streams.length < total;
  const page = streams.slice(0, params.limit);
  const lastStream = page.at(-1) as { streamId?: bigint } | undefined;

  return {
    streams: page,
    total,
    hasMore,
    nextCursor: hasMore && typeof lastStream?.streamId === 'bigint'
      ? lastStream.streamId.toString()
      : null,
  };
};
