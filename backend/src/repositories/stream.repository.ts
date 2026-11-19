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
