import { prisma } from '../lib/prisma.js';

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
  offset: number;
  cursor?: string;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface FindStreamsResult {
  streams: unknown[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
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
