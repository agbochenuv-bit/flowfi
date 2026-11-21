import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

export type BulkActionKind = 'pause' | 'resume' | 'cancel' | 'archive';

export interface BulkActionRequest {
  streamId: string;
  streamName: string;
  action: BulkActionKind;
}

export type BulkItemOutcome = 'success' | 'failure' | 'cancelled';

export interface BulkItemResult {
  streamId: string;
  streamName: string;
  action: BulkActionKind;
  outcome: BulkItemOutcome;
  message?: string;
}

export interface BulkActionReviewDialogProps {
  open: boolean;
  requests: BulkActionRequest[];
  /** Executes a single request. Rejections are reported as failures. */
  onExecute: (request: BulkActionRequest) => Promise<void>;
  onClose: () => void;
}

const ACTION_LABELS: Record<BulkActionKind, string> = {
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel',
  archive: 'Archive',
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function BulkActionReviewDialog({
  open,
  requests,
  onExecute,
  onClose,
}: BulkActionReviewDialogProps): JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const runningRef = useRef(false);

  const [phase, setPhase] = useState<'review' | 'running' | 'done'>('review');
  const [results, setResults] = useState<BulkItemResult[]>([]);
  const [announcement, setAnnouncement] = useState('');

  const summary = useMemo(() => {
    const counts = new Map<BulkActionKind, number>();
    for (const request of requests) {
      counts.set(request.action, (counts.get(request.action) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([action, count]) => `${count} ${ACTION_LABELS[action].toLowerCase()}`);
  }, [requests]);

  useEffect(() => {
    if (!open) {
      setPhase('review');
      setResults([]);
      setAnnouncement('');
      runningRef.current = false;
      return;
    }
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (phase !== 'running') {
          onClose();
        }
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose, phase],
  );

  const runBulkAction = useCallback(async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setPhase('running');
    setResults([]);
    setAnnouncement(`Executing ${requests.length} bulk actions.`);

    const collected: BulkItemResult[] = [];
    for (const request of requests) {
      try {
        await onExecute(request);
        collected.push({ ...request, outcome: 'success' });
      } catch (error) {
        collected.push({
          ...request,
          outcome: 'failure',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      setResults([...collected]);
    }

    const succeeded = collected.filter((item) => item.outcome === 'success').length;
    const failed = collected.filter((item) => item.outcome === 'failure').length;
    setPhase('done');
    setAnnouncement(
      `Bulk action complete. ${succeeded} succeeded, ${failed} failed, ${collected.length} total.`,
    );
    runningRef.current = false;
  }, [onExecute, requests]);

  if (!open) {
    return null;
  }

  return (
    <div className="bulk-review-backdrop" onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="bulk-review-dialog"
      >
        <h2 id={titleId}>Review bulk actions</h2>
        <p id={descriptionId}>
          {requests.length} stream{requests.length === 1 ? '' : 's'} will be affected
          {summary.length > 0 ? ` (${summary.join(', ')})` : ''}. Review each item below before confirming.
        </p>

        <ul className="bulk-review-list" aria-label="Requested bulk actions">
          {requests.map((request) => {
            const result = results.find((item) => item.streamId === request.streamId);
            return (
              <li key={request.streamId} className="bulk-review-item">
                <span className="bulk-review-item-name">{request.streamName}</span>
                <span className="bulk-review-item-action">{ACTION_LABELS[request.action]}</span>
                {result ? (
                  <span
                    className={`bulk-review-item-outcome bulk-review-item-outcome--${result.outcome}`}
                    aria-label={`Outcome: ${result.outcome}`}
                  >
                    {result.outcome === 'success' ? 'Succeeded' : result.outcome === 'failure' ? `Failed: ${result.message ?? 'error'}` : 'Cancelled'}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="bulk-review-actions">
          {phase === 'review' ? (
            <>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" onClick={runBulkAction} disabled={requests.length === 0}>
                Confirm {requests.length} action{requests.length === 1 ? '' : 's'}
              </button>
            </>
          ) : null}
          {phase === 'running' ? <p role="status">Executing…</p> : null}
          {phase === 'done' ? (
            <button type="button" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>

        <div role="status" aria-live="polite" className="visually-hidden">
          {announcement}
        </div>
      </div>
    </div>
  );
}

export default BulkActionReviewDialog;
