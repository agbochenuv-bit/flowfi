import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useWallet } from '../hooks/useWallet';
import { api } from './api';
import type { BackendStream, Stream } from '../types/stream';

export const dashboardQueryKey = ['dashboard'] as const;

export function mapBackendStreamToFrontend(stream: BackendStream): Stream {
  return {
    id: stream.id,
    sender: stream.sender,
    recipient: stream.recipient,
    asset: stream.asset,
    totalAmount: stream.total_amount,
    withdrawnAmount: stream.withdrawn_amount,
    startTime: stream.start_time,
    endTime: stream.end_time,
    status: stream.status,
    createdAt: stream.created_at,
    updatedAt: stream.updated_at,
  };
}

export interface DashboardAnalytics {
  totalStreams: number;
  activeStreams: number;
  pausedStreams: number;
  completedStreams: number;
  totalOutgoing: number;
  totalIncoming: number;
  totalWithdrawn: number;
}

export function getDashboardAnalytics(streams: Stream[]): DashboardAnalytics {
  let activeStreams = 0;
  let pausedStreams = 0;
  let completedStreams = 0;
  let totalOutgoing = 0;
  let totalIncoming = 0;
  let totalWithdrawn = 0;

  for (const stream of streams) {
    if (stream.status === 'active') activeStreams += 1;
    else if (stream.status === 'paused') pausedStreams += 1;
    else if (stream.status === 'completed') completedStreams += 1;

    totalOutgoing += stream.totalAmount;
    totalIncoming += stream.totalAmount;
    totalWithdrawn += stream.withdrawnAmount;
  }

  return {
    totalStreams: streams.length,
    activeStreams,
    pausedStreams,
    completedStreams,
    totalOutgoing,
    totalIncoming,
    totalWithdrawn,
  };
}

export function useDashboard() {
  const { address } = useWallet();

  const query = useQuery({
    queryKey: [...dashboardQueryKey, address],
    queryFn: async () => {
      if (!address) return [] as Stream[];
      const response = await api.getStreams({ sender: address, recipient: address });
      return response.map(mapBackendStreamToFrontend);
    },
    enabled: Boolean(address),
  });

  const analytics = useMemo(
    () => getDashboardAnalytics(query.data ?? []),
    [query.data],
  );

  return { ...query, analytics };
}

// ---------------------------------------------------------------------------
// Portfolio exposure
// ---------------------------------------------------------------------------

/**
 * Per-asset concentration entry within a portfolio exposure summary.
 */
export interface AssetConcentration {
  /** Asset identifier (e.g. token contract address or symbol). */
  asset: string;
  /** Total outgoing liability for this asset. */
  outgoing: number;
  /** Total incoming expected payment for this asset. */
  incoming: number;
  /** Net exposure (outgoing - incoming) for this asset. */
  net: number;
  /** Share of total outgoing liabilities attributable to this asset (0..1). */
  outgoingShare: number;
  /** Share of total incoming expected payments attributable to this asset (0..1). */
  incomingShare: number;
}

/**
 * Source timestamp metadata describing where the exposure data came from.
 */
export interface ExposureSourceTimestamps {
  /** Latest `updatedAt` across the underlying streams, or null if none. */
  latestStreamUpdate: number | null;
  /** Latest `createdAt` across the underlying streams, or null if none. */
  latestStreamCreated: number | null;
  /** Timestamp when the exposure summary was computed (ms since epoch). */
  computedAt: number;
}

/**
 * Summary of outgoing liabilities, incoming expected payments, and asset
 * concentration derived from the mapped dashboard streams.
 */
export interface PortfolioExposure {
  /** Total outgoing liabilities across all assets. */
  totalOutgoing: number;
  /** Total incoming expected payments across all assets. */
  totalIncoming: number;
  /** Net exposure (totalOutgoing - totalIncoming). */
  netExposure: number;
  /** Per-asset concentration, sorted by outgoing descending. */
  byAsset: AssetConcentration[];
  /** Number of streams contributing to the summary. */
  streamCount: number;
  /** Number of paused streams included in the summary. */
  pausedStreamCount: number;
  /** Source timestamps for the underlying data. */
  sourceTimestamps: ExposureSourceTimestamps;
  /** True when the underlying indexer data appears stale. */
  staleIndexer: boolean;
  /** Human-readable data limitations for this summary. */
  limitations: string[];
}

export interface PortfolioExposureOptions {
  /**
   * Age threshold (ms) after which the latest stream update is considered
   * stale. Defaults to 5 minutes.
   */
  staleThresholdMs?: number;
  /**
   * Reference "now" timestamp (ms since epoch). Defaults to `Date.now()`.
   * Exposed for deterministic testing.
   */
  now?: number;
}

const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Build a portfolio exposure summary from mapped dashboard streams.
 *
 * Reuses the same aggregation semantics as {@link getDashboardAnalytics} so
 * that totals reconcile with the underlying streams. Paused streams are
 * included in the totals (their remaining liability is still owed) but are
 * surfaced separately via `pausedStreamCount` and a limitation note.
 */
export function getPortfolioExposure(
  streams: Stream[],
  options: PortfolioExposureOptions = {},
): PortfolioExposure {
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const now = options.now ?? Date.now();

  const assetMap = new Map<string, { outgoing: number; incoming: number }>();
  let totalOutgoing = 0;
  let totalIncoming = 0;
  let pausedStreamCount = 0;
  let latestStreamUpdate: number | null = null;
  let latestStreamCreated: number | null = null;

  for (const stream of streams) {
    const outgoing = stream.totalAmount;
    const incoming = stream.totalAmount;

    totalOutgoing += outgoing;
    totalIncoming += incoming;

    if (stream.status === 'paused') pausedStreamCount += 1;

    const entry = assetMap.get(stream.asset) ?? { outgoing: 0, incoming: 0 };
    entry.outgoing += outgoing;
    entry.incoming += incoming;
    assetMap.set(stream.asset, entry);

    if (latestStreamUpdate === null || stream.updatedAt > latestStreamUpdate) {
      latestStreamUpdate = stream.updatedAt;
    }
    if (latestStreamCreated === null || stream.createdAt > latestStreamCreated) {
      latestStreamCreated = stream.createdAt;
    }
  }

  const byAsset: AssetConcentration[] = Array.from(assetMap.entries())
    .map(([asset, entry]) => ({
      asset,
      outgoing: entry.outgoing,
      incoming: entry.incoming,
      net: entry.outgoing - entry.incoming,
      outgoingShare: totalOutgoing > 0 ? entry.outgoing / totalOutgoing : 0,
      incomingShare: totalIncoming > 0 ? entry.incoming / totalIncoming : 0,
    }))
    .sort((a, b) => b.outgoing - a.outgoing);

  const staleIndexer =
    latestStreamUpdate !== null && now - latestStreamUpdate > staleThresholdMs;

  const limitations: string[] = [];
  if (streams.length === 0) {
    limitations.push('No streams found for this wallet; exposure is empty.');
  }
  if (pausedStreamCount > 0) {
    limitations.push(
      `${pausedStreamCount} paused stream(s) are included in totals; their remaining liability may not accrue.`,
    );
  }
  if (staleIndexer) {
    limitations.push(
      'Indexer data appears stale; totals may not reflect recent on-chain activity.',
    );
  }
  if (latestStreamUpdate === null) {
    limitations.push('No source timestamps available for this exposure summary.');
  }

  return {
    totalOutgoing,
    totalIncoming,
    netExposure: totalOutgoing - totalIncoming,
    byAsset,
    streamCount: streams.length,
    pausedStreamCount,
    sourceTimestamps: {
      latestStreamUpdate,
      latestStreamCreated,
      computedAt: now,
    },
    staleIndexer,
    limitations,
  };
}