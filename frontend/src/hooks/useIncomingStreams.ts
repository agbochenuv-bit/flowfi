"use client";

import {
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchIncomingStreams, type IncomingStreamRecord } from "@/lib/api/streams";
import { logger } from "@/lib/logger";
import {
  withdrawFromStream,
  type SorobanResult,
  type TransactionStageCallback,
} from "@/lib/soroban";
import type { WalletSession } from "@/lib/wallet";

export function incomingStreamsQueryKey(publicKey: string | null | undefined) {
  return ["incoming-streams", publicKey] as const;
}

// Current production behavior: no automatic polling. Tests can override this
// via `options.refetchInterval` instead of having to mock timers globally.
const DEFAULT_INCOMING_STREAMS_REFETCH_INTERVAL: number | false = false;

export interface UseIncomingStreamsOptions {
  refetchInterval?: number | false;
  authToken?: string | null;
}

export function useIncomingStreams(
  publicKey: string | null | undefined,
  options?: UseIncomingStreamsOptions,
) {
  return useQuery({
    queryKey: incomingStreamsQueryKey(publicKey),
    queryFn: () => fetchIncomingStreams(publicKey!, undefined, options?.authToken),
    enabled: Boolean(publicKey),
    refetchInterval:
      options?.refetchInterval ?? DEFAULT_INCOMING_STREAMS_REFETCH_INTERVAL,
  });
}

export function useWithdrawIncomingStream(
  session: WalletSession | null,
  publicKey: string | null | undefined,
  authToken?: string | null,
  options?: {
    onSuccess?: (
      result: SorobanResult,
      stream: IncomingStreamRecord,
    ) => Promise<void> | void;
    onError?: (error: unknown, stream: IncomingStreamRecord) => void;
    onStage?: TransactionStageCallback;
  },
) {
  const queryClient = useQueryClient();

  // Ref to the active poll AbortController so we can cancel on unmount/
  // wallet change. Each mutation resets it.
  const pollControllerRef = useRef<AbortController | null>(null);

  // Abort any in-flight poll when the component unmounts or the wallet
  // changes.  This prevents stale fetches and state writes.
  useEffect(() => {
    return () => {
      pollControllerRef.current?.abort();
      pollControllerRef.current = null;
    };
  }, [publicKey]);

  const pollIndexer = useCallback(
    (
      pk: string,
      streamId: number,
      oldWithdrawn: number,
      expectedWithdrawn: number,
    ) => {
      // Abort any previous poll that may still be running
      pollControllerRef.current?.abort();
      const controller = new AbortController();
      pollControllerRef.current = controller;

      pollIndexerForWithdraw(
        pk,
        streamId,
        oldWithdrawn,
        expectedWithdrawn,
        queryClient,
        controller.signal,
        authToken,
      );
    },
    [queryClient, authToken],
  );

  return useMutation({
    mutationFn: async (stream: IncomingStreamRecord) => {
      if (!session) {
        throw new Error("Please connect your wallet first");
      }

      return withdrawFromStream(session, {
        streamId: BigInt(stream.streamId),
      }, options?.onStage);
    },
    onMutate: async (stream) => {
      if (!publicKey) {
        return { previousStreams: undefined, expectedWithdrawn: stream.withdrawn };
      }

      // Cancel any outgoing refetches (so they don't overwrite our optimistic update)
      await queryClient.cancelQueries({
        queryKey: incomingStreamsQueryKey(publicKey),
      });

      const cachedStreams = queryClient.getQueryData<IncomingStreamRecord[]>(
        incomingStreamsQueryKey(publicKey),
      );

      let expectedWithdrawn = stream.withdrawn;

      if (cachedStreams) {
        const nowSeconds = Date.now() / 1000;
        const cachedStream = cachedStreams.find((candidate) => candidate.id === stream.id) ?? stream;
        const elapsed = Math.max(0, nowSeconds - cachedStream.lastUpdateTime);
        const paused = cachedStream.isPaused && cachedStream.pausedAt
          ? Math.max(0, nowSeconds - cachedStream.pausedAt)
          : 0;
        const accrued = Math.max(0, elapsed - paused) * cachedStream.ratePerSecond;
        const claimable = Math.min(
          Math.max(0, cachedStream.deposited - cachedStream.withdrawn),
          accrued,
        );
        expectedWithdrawn = cachedStream.withdrawn + claimable;
      }

      return { expectedWithdrawn };
    },
    onSuccess: async (result, stream, context) => {
      if (publicKey) {
        const ctx = context as {
          previousStreams?: IncomingStreamRecord[];
          expectedWithdrawn?: number;
        };
        const targetWithdrawn = ctx.expectedWithdrawn ?? stream.withdrawn;
        // Start polling in the background without blocking the mutation
        pollIndexer(
          publicKey,
          stream.streamId,
          stream.withdrawn,
          targetWithdrawn,
        );
      }

      await options?.onSuccess?.(result, stream);
    },
    onError: (error, stream, context) => {
      void error;
      void context;
      options?.onError?.(error, stream);
    },
  });
}

async function pollIndexerForWithdraw(
  publicKey: string,
  streamId: number,
  oldWithdrawn: number,
  expectedWithdrawn: number,
  queryClient: ReturnType<typeof useQueryClient>,
  signal?: AbortSignal,
  authToken?: string | null,
  maxRetries = 6,
  initialDelay = 1000,
) {
  let delay = initialDelay;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Stop immediately if the caller has aborted (unmount / wallet change)
    if (signal?.aborted) return;

    await new Promise((resolve) => setTimeout(resolve, delay));

    // Re-check after the delay – the signal may have been aborted while we
    // were waiting.
    if (signal?.aborted) return;

    try {
      const streams = await fetchIncomingStreams(publicKey, undefined, authToken);
      if (signal?.aborted) return;

      const updatedStream = streams.find((s) => s.streamId === streamId);
      if (
        updatedStream &&
        (updatedStream.withdrawn > oldWithdrawn ||
          updatedStream.withdrawn >= expectedWithdrawn - 0.000001)
      ) {
        queryClient.setQueryData(incomingStreamsQueryKey(publicKey), streams);
        return;
      }
    } catch (err) {
      // AbortError is expected when the signal fires; don't log it as a
      // warning.
      if (signal?.aborted) return;
      logger.warn("Error polling indexer for withdraw:", err);
    }
    delay *= 2;
  }
  if (!signal?.aborted) {
    await queryClient.invalidateQueries({
      queryKey: incomingStreamsQueryKey(publicKey),
    });
  }
}
