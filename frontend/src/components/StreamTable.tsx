import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Stream } from '../types/stream';
import { calculateStreamProgress } from '../lib/streamCalculations';

interface StreamTableProps {
  streams: Stream[];
  onBulkAction?: (action: BulkAction, streamIds: string[]) => Promise<BulkActionResult[]>;
  onSelectStream?: (stream: Stream) => void;
}

export type BulkAction = 'cancel' | 'pause' | 'resume';

export interface BulkActionResult {
  streamId: string;
  status: 'success' | 'failure' | 'cancelled';
  message?: string;
}

const BULK_ACTION_LABELS: Record<BulkAction, string> = {
  cancel: 'Cancel',
  pause: 'Pause',
  resume: 'Resume',
};

const OUTCOME_LABELS: Record<BulkActionResult['status'], string> = {
  success: 'Succeeded',
  failure: 'Failed',
  cancelled: 'Cancelled',
};

interface BulkReviewDialogProps {
  action: BulkAction;
  streams: Stream[];
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}

function BulkReviewDialog({ action, streams, onConfirm, onCancel, busy }: BulkReviewDialogProps) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
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
    [busy, onCancel],
  );

  return (
    <div className="bulk-review-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bulk-review-dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId}>Review bulk {BULK_ACTION_LABELS[action].toLowerCase()} action</h2>
        <p id={descId}>
          You are about to {BULK_ACTION_LABELS[action].toLowerCase()} {streams.length}{' '}
          {streams.length === 1 ? 'stream' : 'streams'}. Review the list below before confirming.
        </p>
        <ul className="bulk-review-list">
          {streams.map((stream) => (
            <li key={stream.id}>
              <span className="bulk-review-stream-name">{stream.name}</span>
              <span className="bulk-review-stream-action">{BULK_ACTION_LABELS[action]}</span>
            </li>
          ))}
        </ul>
        <div className="bulk-review-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" onClick={onConfirm} disabled={busy}>
            {busy ? 'Applying…' : `Confirm ${BULK_ACTION_LABELS[action].toLowerCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export function StreamTable({ streams, onBulkAction, onSelectStream }: StreamTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<BulkActionResult[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const submissionRef = useRef(false);

  const selectedStreams = useMemo(
    () => streams.filter((stream) => selectedIds.has(stream.id)),
    [streams, selectedIds],
  );

  const toggleSelection = useCallback((streamId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(streamId)) next.delete(streamId);
      else next.add(streamId);
      return next;
    });
  }, []);

  const requestAction = useCallback(
    (action: BulkAction) => {
      if (selectedStreams.length === 0 || busy) return;
      setOutcomes(null);
      setPendingAction(action);
    },
    [selectedStreams.length, busy],
  );

  const cancelReview = useCallback(() => {
    if (busy) return;
    setPendingAction(null);
    setAnnouncement('Bulk action review cancelled.');
  }, [busy]);

  const confirmAction = useCallback(async () => {
    if (!pendingAction || !onBulkAction || submissionRef.current) return;
    submissionRef.current = true;
    setBusy(true);
    const action = pendingAction;
    const ids = selectedStreams.map((stream) => stream.id);
    setAnnouncement(`Applying ${BULK_ACTION_LABELS[action].toLowerCase()} to ${ids.length} streams.`);
    try {
      const results = await onBulkAction(action, ids);
      setOutcomes(results);
      const succeeded = results.filter((r) => r.status === 'success').length;
      const failed = results.filter((r) => r.status === 'failure').length;
      const cancelled = results.filter((r) => r.status === 'cancelled').length;
      setAnnouncement(
        `Bulk action complete. ${succeeded} succeeded, ${failed} failed, ${cancelled} cancelled.`,
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        results.forEach((r) => {
          if (r.status === 'success') next.delete(r.streamId);
        });
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setOutcomes(ids.map((streamId) => ({ streamId, status: 'failure', message })));
      setAnnouncement(`Bulk action failed. ${message}`);
    } finally {
      submissionRef.current = false;
      setBusy(false);
      setPendingAction(null);
    }
  }, [pendingAction, onBulkAction, selectedStreams]);

  const outcomeByStream = useMemo(() => {
    const map = new Map<string, BulkActionResult>();
    outcomes?.forEach((outcome) => map.set(outcome.streamId, outcome));
    return map;
  }, [outcomes]);

  return (
    <div className="stream-table">
      <div className="stream-table-toolbar" role="toolbar" aria-label="Bulk stream actions">
        <span aria-live="polite" className="stream-table-selection-count">
          {selectedStreams.length} selected
        </span>
        {(Object.keys(BULK_ACTION_LABELS) as BulkAction[]).map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => requestAction(action)}
            disabled={selectedStreams.length === 0 || busy}
          >
            {BULK_ACTION_LABELS[action]} selected
          </button>
        ))}
      </div>

      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

      <table>
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">Name</th>
            <th scope="col">Progress</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {streams.map((stream) => {
            const outcome = outcomeByStream.get(stream.id);
            return (
              <tr key={stream.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(stream.id)}
                    onChange={() => toggleSelection(stream.id)}
                    aria-label={`Select ${stream.name}`}
                  />
                </td>
                <td>
                  <button type="button" className="stream-name-button" onClick={() => onSelectStream?.(stream)}>
                    {stream.name}
                  </button>
                </td>
                <td>{calculateStreamProgress(stream)}%</td>
                <td>
                  {outcome ? (
                    <span className={`stream-outcome stream-outcome-${outcome.status}`}>
                      {OUTCOME_LABELS[outcome.status]}
                      {outcome.message ? `: ${outcome.message}` : ''}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {pendingAction ? (
        <BulkReviewDialog
          action={pendingAction}
          streams={selectedStreams}
          onConfirm={confirmAction}
          onCancel={cancelReview}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

export default StreamTable;
