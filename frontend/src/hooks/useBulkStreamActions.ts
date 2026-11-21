import { useCallback, useRef, useState } from 'react';

export type BulkActionType = 'pause' | 'resume' | 'cancel' | 'archive';

export interface BulkActionRequest {
  streamId: string;
  streamName: string;
  action: BulkActionType;
}

export type BulkItemStatus = 'success' | 'failure' | 'cancelled';

export interface BulkItemOutcome {
  streamId: string;
  streamName: string;
  action: BulkActionType;
  status: BulkItemStatus;
  error?: string;
}

export interface BulkReviewState {
  requests: BulkActionRequest[];
  isOpen: boolean;
}

export type BulkExecutor = (request: BulkActionRequest) => Promise<void>;

export interface UseBulkStreamActionsResult {
  review: BulkReviewState;
  outcomes: BulkItemOutcome[];
  isExecuting: boolean;
  openReview: (requests: BulkActionRequest[]) => void;
  cancelReview: () => void;
  confirmReview: () => Promise<void>;
  resetOutcomes: () => void;
}

/**
 * Manages the accessible bulk action review flow: preflight summary,
 * explicit confirmation, and per-item outcomes. Guards against duplicate
 * submissions while a batch is in flight.
 */
export function useBulkStreamActions(executor: BulkExecutor): UseBulkStreamActionsResult {
  const [review, setReview] = useState<BulkReviewState>({ requests: [], isOpen: false });
  const [outcomes, setOutcomes] = useState<BulkItemOutcome[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const executingRef = useRef(false);

  const openReview = useCallback((requests: BulkActionRequest[]) => {
    if (executingRef.current) return;
    setOutcomes([]);
    setReview({ requests, isOpen: true });
  }, []);

  const cancelReview = useCallback(() => {
    if (executingRef.current) return;
    setReview({ requests: [], isOpen: false });
  }, []);

  const resetOutcomes = useCallback(() => {
    setOutcomes([]);
  }, []);

  const confirmReview = useCallback(async () => {
    if (executingRef.current) return;
    const requests = review.requests;
    if (requests.length === 0) {
      setReview({ requests: [], isOpen: false });
      return;
    }

    executingRef.current = true;
    setIsExecuting(true);
    setReview((prev) => ({ ...prev, isOpen: false }));

    const results: BulkItemOutcome[] = [];
    for (const request of requests) {
      try {
        await executor(request);
        results.push({
          streamId: request.streamId,
          streamName: request.streamName,
          action: request.action,
          status: 'success',
        });
      } catch (error) {
        results.push({
          streamId: request.streamId,
          streamName: request.streamName,
          action: request.action,
          status: 'failure',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    setOutcomes(results);
    setReview({ requests: [], isOpen: false });
    executingRef.current = false;
    setIsExecuting(false);
  }, [executor, review.requests]);

  return {
    review,
    outcomes,
    isExecuting,
    openReview,
    cancelReview,
    confirmReview,
    resetOutcomes,
  };
}
