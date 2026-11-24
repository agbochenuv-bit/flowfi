import { prisma } from '../lib/prisma.js';
import { parseStreamId } from '../lib/stream-id.js';
import {
  getConfiguredStellarNetwork,
  type StellarNetworkId,
} from '../lib/stellar-network.js';
import {
  claimableAmountService,
  type ClaimableAmountResult,
} from './claimable.service.js';
import { getStreamFromChain, isStale } from './sorobanService.js';
import {
  getChainFreshnessMetadata,
  type ChainFreshnessMetadata,
  type DataSource,
} from './freshness.service.js';
import logger from '../logger.js';

/**
 * Bounded multi-stream read service (issue #229).
 *
 * Allows callers to fetch up to `MAX_BATCH_READ_STREAM_IDS` streams in a
 * single bounded database query, preserving caller order, deduplicating
 * duplicate IDs transparently, isolating per-item errors, and reporting
 * explicit missing/failed IDs and chain freshness metadata.
 */

export const MAX_BATCH_READ_STREAM_IDS = 50;
export const MAX_BATCH_RPC_FALLBACKS = 5;

export interface BatchStreamReadErrorDetails {
  recoveryHint: string;
  retryable?: boolean | undefined;
  [key: string]: unknown;
}

export class BatchStreamReadError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: BatchStreamReadErrorDetails;
  public readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    details: BatchStreamReadErrorDetails,
  ) {
    super(message);
    this.name = 'BatchStreamReadError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = Boolean(details.retryable);
  }
}

export interface ValidatedBatchStreamReadInput {
  uniqueStreamIds: bigint[];
  requestedCount: number;
  duplicateCount: number;
  includeClaimable: boolean;
  allowRpcFallback: boolean;
  at?: number | undefined;
  network: StellarNetworkId;
}

export interface BatchStreamItemError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface BatchStreamItem {
  streamId: string;
  status: 'found' | 'not_found' | 'error';
  source: 'indexer' | 'chain' | null;
  stream: Record<string, unknown> | null;
  claimable?: ClaimableAmountResult | undefined;
  error?: BatchStreamItemError | undefined;
}

export interface BatchStreamReadMeta {
  requestedCount: number;
  uniqueCount: number;
  duplicateCount: number;
  foundCount: number;
  missingCount: number;
  failedCount: number;
  maxBatchSize: number;
  rpcFallbacksUsed: number;
  rpcFallbackCap: number;
  rpcFallbackCapped: boolean;
  partial: boolean;
  recoveryHint: string | null;
}

export interface BatchStreamReadResponse {
  items: BatchStreamItem[];
  streams: Array<Record<string, unknown>>;
  missingStreamIds: string[];
  failedStreamIds: string[];
  meta: BatchStreamReadMeta;
  freshness: ChainFreshnessMetadata;
}

/**
 * Validate and normalize a multi-stream read request at the API boundary.
 */
export function validateBatchStreamReadRequest(
  body: unknown,
  queryNetwork?: unknown,
): ValidatedBatchStreamReadInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BatchStreamReadError(
      400,
      'INVALID_BATCH_READ_REQUEST',
      'Request body must be a JSON object containing streamIds',
      {
        recoveryHint:
          'Send a JSON object with a non-empty `streamIds` array (max 50 entries).',
      },
    );
  }

  const record = body as Record<string, unknown>;
  const configuredNetwork = getConfiguredStellarNetwork();

  const rawNetwork =
    typeof record['network'] === 'string'
      ? record['network']
      : typeof queryNetwork === 'string'
        ? queryNetwork
        : undefined;

  if (rawNetwork !== undefined) {
    const normalizedNetwork = rawNetwork.trim().toLowerCase();
    if (normalizedNetwork !== configuredNetwork) {
      throw new BatchStreamReadError(
        409,
        'NETWORK_MISMATCH',
        `This indexer serves ${configuredNetwork}, not ${rawNetwork}.`,
        {
          configuredNetwork,
          requestedNetwork: rawNetwork,
          recoveryHint: `Send the request to the ${configuredNetwork} endpoint or omit the network parameter.`,
        },
      );
    }
  }

  const rawIds = record['streamIds'];
  if (!Array.isArray(rawIds)) {
    throw new BatchStreamReadError(
      400,
      'INVALID_BATCH_READ_REQUEST',
      'streamIds must be an array of non-negative integer stream IDs',
      {
        field: 'streamIds',
        maxBatchSize: MAX_BATCH_READ_STREAM_IDS,
        recoveryHint: `Provide streamIds as an array containing between 1 and ${MAX_BATCH_READ_STREAM_IDS} stream IDs.`,
      },
    );
  }

  if (rawIds.length === 0) {
    throw new BatchStreamReadError(
      400,
      'EMPTY_BATCH_REQUEST',
      'streamIds must contain at least one stream ID',
      {
        field: 'streamIds',
        maxBatchSize: MAX_BATCH_READ_STREAM_IDS,
        recoveryHint: `Provide between 1 and ${MAX_BATCH_READ_STREAM_IDS} stream IDs.`,
      },
    );
  }

  if (rawIds.length > MAX_BATCH_READ_STREAM_IDS) {
    throw new BatchStreamReadError(
      400,
      'BATCH_LIMIT_EXCEEDED',
      `streamIds exceeds the maximum batch size of ${MAX_BATCH_READ_STREAM_IDS} (received ${rawIds.length})`,
      {
        field: 'streamIds',
        maxBatchSize: MAX_BATCH_READ_STREAM_IDS,
        requestedCount: rawIds.length,
        recoveryHint: `Split streamIds into chunks of at most ${MAX_BATCH_READ_STREAM_IDS} entries and issue separate requests.`,
      },
    );
  }

  const invalidEntries: Array<{ index: number; value: unknown }> = [];
  const uniqueStreamIds: bigint[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rawIds.length; i += 1) {
    const rawValue = rawIds[i];
    const parsed = parseStreamId(rawValue);
    if (parsed === null) {
      invalidEntries.push({ index: i, value: rawValue });
      continue;
    }
    const key = parsed.toString();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueStreamIds.push(parsed);
    }
  }

  if (invalidEntries.length > 0) {
    throw new BatchStreamReadError(
      400,
      'INVALID_STREAM_ID',
      `One or more streamIds are invalid (must be non-negative integers)`,
      {
        field: 'streamIds',
        invalidEntries,
        recoveryHint:
          'Ensure every element in streamIds is a non-negative integer or numeric string.',
      },
    );
  }

  const rawIncludeClaimable = record['includeClaimable'];
  if (
    rawIncludeClaimable !== undefined &&
    typeof rawIncludeClaimable !== 'boolean'
  ) {
    throw new BatchStreamReadError(
      400,
      'INVALID_OPTION',
      'includeClaimable must be a boolean',
      {
        field: 'includeClaimable',
        recoveryHint: 'Pass includeClaimable as true or false.',
      },
    );
  }

  const rawAllowRpcFallback = record['allowRpcFallback'];
  if (
    rawAllowRpcFallback !== undefined &&
    typeof rawAllowRpcFallback !== 'boolean'
  ) {
    throw new BatchStreamReadError(
      400,
      'INVALID_OPTION',
      'allowRpcFallback must be a boolean',
      {
        field: 'allowRpcFallback',
        recoveryHint: 'Pass allowRpcFallback as true or false.',
      },
    );
  }

  let parsedAt: number | undefined;
  const rawAt = record['at'];
  if (rawAt !== undefined) {
    const candidate =
      typeof rawAt === 'number'
        ? rawAt
        : typeof rawAt === 'string' && /^\d+$/.test(rawAt.trim())
          ? Number.parseInt(rawAt.trim(), 10)
          : Number.NaN;
    if (!Number.isInteger(candidate) || candidate < 0) {
      throw new BatchStreamReadError(
        400,
        'INVALID_TIMESTAMP',
        "'at' must be a non-negative Unix timestamp in seconds",
        {
          field: 'at',
          recoveryHint: "Pass 'at' as a non-negative integer Unix timestamp.",
        },
      );
    }
    parsedAt = candidate;
  }

  return {
    uniqueStreamIds,
    requestedCount: rawIds.length,
    duplicateCount: rawIds.length - uniqueStreamIds.length,
    includeClaimable: rawIncludeClaimable ?? false,
    allowRpcFallback: rawAllowRpcFallback ?? false,
    ...(parsedAt !== undefined ? { at: parsedAt } : {}),
    network: configuredNetwork,
  };
}

function serializeRecord(row: unknown): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
}

interface StreamRowLike {
  streamId: bigint | number | string;
  tokenAddress?: string;
  ratePerSecond?: string;
  depositedAmount?: string;
  withdrawnAmount?: string;
  startTime?: bigint | number;
  lastUpdateTime?: bigint | number;
  isActive?: boolean;
  isPaused?: boolean;
  pausedAt?: bigint | number | null;
  totalPausedDuration?: number | null;
  updatedAt?: Date | string;
  [key: string]: unknown;
}

/**
 * Execute a bounded multi-stream read against the indexed store with optional
 * claimable calculation and bounded RPC fallback.
 */
export async function executeBatchStreamRead(
  input: ValidatedBatchStreamReadInput,
): Promise<BatchStreamReadResponse> {
  let rows: StreamRowLike[];
  try {
    rows = (await prisma.stream.findMany({
      where: {
        streamId: {
          in: input.uniqueStreamIds,
        },
      },
      take: input.uniqueStreamIds.length,
      include: {
        senderUser: true,
        recipientUser: true,
      },
    })) as unknown as StreamRowLike[];
  } catch (err) {
    logger.error('[StreamReadService] Primary batch DB read failed:', err);
    throw new BatchStreamReadError(
      503,
      'BATCH_READ_UNAVAILABLE',
      'Unable to read streams from the indexed store right now. Please retry.',
      {
        retryable: true,
        recoveryHint:
          'Retry the batch read with exponential backoff, or fetch critical streams individually.',
      },
    );
  }

  const rowById = new Map<string, StreamRowLike>();
  for (const row of rows) {
    rowById.set(String(row.streamId), row);
  }

  const items: BatchStreamItem[] = [];
  const streams: Array<Record<string, unknown>> = [];
  const missingStreamIds: string[] = [];
  const failedStreamIds: string[] = [];

  let rpcFallbacksUsed = 0;
  let rpcFallbackCapped = false;
  let indexerCount = 0;
  let chainCount = 0;

  for (const streamId of input.uniqueStreamIds) {
    const idKey = streamId.toString();
    const row = rowById.get(idKey);

    if (!row) {
      if (input.allowRpcFallback) {
        if (rpcFallbacksUsed < MAX_BATCH_RPC_FALLBACKS) {
          rpcFallbacksUsed += 1;
          try {
            const chainStream = await getStreamFromChain(streamId);
            if (chainStream) {
              const serialized = serializeRecord({
                ...chainStream,
                source: 'chain',
              });
              chainCount += 1;
              streams.push(serialized);
              items.push({
                streamId: idKey,
                status: 'found',
                source: 'chain',
                stream: serialized,
              });
              continue;
            }
          } catch (err) {
            logger.warn(
              `[StreamReadService] RPC fallback failed for stream ${idKey}:`,
              err,
            );
            failedStreamIds.push(idKey);
            items.push({
              streamId: idKey,
              status: 'error',
              source: null,
              stream: null,
              error: {
                code: 'RPC_FALLBACK_FAILED',
                message: 'Live RPC fallback failed for this stream.',
                retryable: true,
              },
            });
            continue;
          }
        } else {
          rpcFallbackCapped = true;
        }
      }

      missingStreamIds.push(idKey);
      items.push({
        streamId: idKey,
        status: 'not_found',
        source: null,
        stream: null,
      });
      continue;
    }

    let source: 'indexer' | 'chain' = 'indexer';
    let effectiveRow: Record<string, unknown> = serializeRecord(row);

    const rowUpdatedAt =
      row.updatedAt instanceof Date
        ? row.updatedAt
        : typeof row.updatedAt === 'string'
          ? new Date(row.updatedAt)
          : null;

    if (
      input.allowRpcFallback &&
      rowUpdatedAt &&
      !Number.isNaN(rowUpdatedAt.getTime()) &&
      isStale(rowUpdatedAt)
    ) {
      if (rpcFallbacksUsed < MAX_BATCH_RPC_FALLBACKS) {
        rpcFallbacksUsed += 1;
        try {
          const chainStream = await getStreamFromChain(streamId);
          if (chainStream) {
            source = 'chain';
            effectiveRow = serializeRecord({
              ...row,
              ...chainStream,
              source: 'chain',
            });
          }
        } catch (err) {
          logger.warn(
            `[StreamReadService] Stale RPC refresh failed for stream ${idKey}; serving indexed row:`,
            err,
          );
        }
      } else {
        rpcFallbackCapped = true;
      }
    }

    let claimable: ClaimableAmountResult | undefined;
    if (input.includeClaimable) {
      try {
        claimable = claimableAmountService.getClaimableAmount(
          row as Parameters<typeof claimableAmountService.getClaimableAmount>[0],
          input.at,
        );
      } catch (err) {
        logger.warn(
          `[StreamReadService] Claimable computation failed for stream ${idKey}:`,
          err,
        );
        failedStreamIds.push(idKey);
        items.push({
          streamId: idKey,
          status: 'error',
          source,
          stream: effectiveRow,
          error: {
            code: 'CLAIMABLE_CALCULATION_FAILED',
            message: 'Unable to calculate claimable amount for this stream.',
            retryable: false,
          },
        });
        continue;
      }
    }

    if (source === 'chain') {
      chainCount += 1;
    } else {
      indexerCount += 1;
    }

    streams.push(effectiveRow);
    items.push({
      streamId: idKey,
      status: 'found',
      source,
      stream: effectiveRow,
      ...(claimable !== undefined ? { claimable } : {}),
    });
  }

  let effectiveSource: DataSource = 'indexer';
  if (chainCount > 0 && indexerCount > 0) {
    effectiveSource = 'hybrid';
  } else if (chainCount > 0 && indexerCount === 0) {
    effectiveSource = 'chain';
  }

  const freshness = await getChainFreshnessMetadata({
    source: effectiveSource,
  });

  const foundCount = streams.length;
  const missingCount = missingStreamIds.length;
  const failedCount = failedStreamIds.length;
  const partial = missingCount > 0 || failedCount > 0;

  let recoveryHint: string | null = null;
  if (failedCount > 0) {
    recoveryHint =
      'One or more stream items failed during enrichment or RPC fallback. Retry failedStreamIds individually or re-submit them in a smaller batch.';
  } else if (rpcFallbackCapped) {
    recoveryHint = `RPC fallback cap (${MAX_BATCH_RPC_FALLBACKS}) was reached. Re-query missing or stale IDs individually to force live chain reads.`;
  } else if (missingCount > 0) {
    recoveryHint =
      'Some requested streamIds were not found in the indexer. If recently created on-chain, retry after ledger ingestion or enable allowRpcFallback.';
  }

  return {
    items,
    streams,
    missingStreamIds,
    failedStreamIds,
    meta: {
      requestedCount: input.requestedCount,
      uniqueCount: input.uniqueStreamIds.length,
      duplicateCount: input.duplicateCount,
      foundCount,
      missingCount,
      failedCount,
      maxBatchSize: MAX_BATCH_READ_STREAM_IDS,
      rpcFallbacksUsed,
      rpcFallbackCap: MAX_BATCH_RPC_FALLBACKS,
      rpcFallbackCapped,
      partial,
      recoveryHint,
    },
    freshness,
  };
}
