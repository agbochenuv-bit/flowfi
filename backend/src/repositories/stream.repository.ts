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
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface FindStreamsResult {
  streams: unknown[];
  total: number;
  hasMore: boolean;
}

export interface StreamOwnership {
  streamId: bigint;
  sender: string;
  recipient: string;
}

/**
 * Look up the on-chain sender/recipient for a stream directly from the DB.
 * Used by authorization helpers so ownership is never derived from
 * client-supplied addresses.
 */
export const findStreamOwnership = async (streamId: bigint): Promise<StreamOwnership | null> => {
  const stream = await prisma.stream.findUnique({
    where: { streamId },
    select: { streamId: true, sender: true, recipient: true },
  });

  return stream ?? null;
};

/**
 * Look up ownership for multiple streams in a single query.
 * Returns a map keyed by the stringified streamId; missing streams are omitted.
 */
export const findStreamOwnershipBatch = async (streamIds: bigint[]): Promise<Map<string, StreamOwnership>> => {
  const ownership = new Map<string, StreamOwnership>();
  if (streamIds.length === 0) return ownership;

  const streams = await prisma.stream.findMany({
    where: { streamId: { in: streamIds } },
    select: { streamId: true, sender: true, recipient: true },
  });

  for (const stream of streams) {
    ownership.set(stream.streamId.toString(), stream);
  }

  return ownership;
};

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
      orderBy: { [sortField]: sortOrder },
      take: params.limit,
      skip: params.offset,
      include: {
        senderUser: true,
        recipientUser: true,
      },
    }),
    prisma.stream.count({ where }),
  ]);

  return { streams, total, hasMore: params.offset + streams.length < total };
};
