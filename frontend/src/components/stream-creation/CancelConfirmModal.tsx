"use client";

/**
 * CancelConfirmModal.tsx
 *
 * Confirmation dialog before cancelling an active stream.
 * Clearly communicates the consequences (stream stops, no refund of
 * already-withdrawn funds) before the user commits.
 */

import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useModalDialog } from "@/hooks/useModalDialog";
import toast from "react-hot-toast";
import { transactionSuccessToast } from "@/lib/transaction-feedback";

/**
 * Authoritative snapshot of the stream as read from chain at the time the
 * modal was opened. The preview is derived exclusively from these values so
 * that what the user sees matches what the contract will do.
 */
export interface CancelStreamSnapshot {
  /** Total amount deposited into the stream (token base units, as number). */
  deposited: number;
  /** Amount already withdrawn by the recipient. */
  withdrawn: number;
  /** Unix timestamp (seconds) at which the stream would have ended. */
  endTime: number;
  /** Recipient address the stream pays out to. */
  recipient: string;
  /** Ledger timestamp (seconds) the snapshot was captured at. */
  capturedAt: number;
}

interface CancelConfirmModalProps {
  streamId: string;
  network?: string;
  recipient: string;
  token: string;
  deposited: number;
  withdrawn: number;
  /** Optional authoritative snapshot; falls back to props when omitted. */
  snapshot?: CancelStreamSnapshot;
  /** Optional current ledger time (seconds) used to detect stale snapshots. */
  nowSeconds?: number;
  /** Max age (seconds) of a snapshot before it is considered stale. */
  staleAfterSeconds?: number;
  onConfirm: (streamId: string) => Promise<void>;
  onClose: () => void;
}

const DEFAULT_STALE_AFTER_SECONDS = 60;

export const CancelConfirmModal: React.FC<CancelConfirmModalProps> = ({
  streamId,
  network = "Unknown",
  recipient,
  token,
  deposited,
  withdrawn,
  snapshot,
  nowSeconds,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
  onConfirm,
  onClose,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isSubmitting });

  const preview = useMemo(() => {
    const source: CancelStreamSnapshot =
      snapshot ?? {
        deposited,
        withdrawn,
        endTime: 0,
        recipient,
        capturedAt: 0,
      };

    // Clamp to avoid negative remaining amounts from rounding drift.
    const remaining = Math.max(0, source.deposited - source.withdrawn);
    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    const ageSeconds = source.capturedAt > 0 ? Math.max(0, now - source.capturedAt) : 0;
    const isStale = source.capturedAt > 0 && ageSeconds > staleAfterSeconds;

    return {
      remaining,
      endTime: source.endTime,
      recipient: source.recipient,
      ageSeconds,
      isStale,
      hasSnapshot: Boolean(snapshot),
    };
  }, [snapshot, deposited, withdrawn, recipient, nowSeconds, staleAfterSeconds]);

  const remaining = preview.remaining;
  const isStale = preview.isStale;

  const handleConfirm = async () => {
    if (isStale) {
      toast.error("Stream state is stale. Refresh the stream before cancelling.");
      return;
    }
    setIsSubmitting(true);
    try {
      await onConfirm(streamId);
      transactionSuccessToast(`Stream ${streamId} cancelled successfully`);
    } catch {
      toast.error("Failed to cancel stream. Please try again.");
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-confirm-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="glass-card relative w-full max-w-md mx-4 rounded-2xl border border-red-500/30 p-8"
      >
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {/* Warning icon */}
          <div className="shrink-0 flex h-10 w-10 items-center justify-center rounded-full bg-red-500/15">
            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div>
            <h2 id="cancel-confirm-modal-title" className="text-xl font-bold">Cancel Stream?</h2>
            <p className="text-sm text-slate-400 mt-1">
              This action is permanent and cannot be undone.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="ml-auto text-slate-400 hover:text-foreground transition-colors disabled:opacity-50"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Stream summary */}
        <div className="mb-6 rounded-lg bg-white/5 border border-glass-border divide-y divide-glass-border text-sm">
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Stream</span>
            <code className="text-accent font-mono text-xs">{streamId}</code>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Network</span>
            <span className="font-semibold text-foreground">{network}</span>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Recipient</span>
            <code className="font-mono text-xs text-foreground">{recipient}</code>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Total deposited</span>
            <span className="font-semibold text-foreground">{deposited} {token}</span>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Already withdrawn</span>
            <span className="font-semibold text-foreground">{withdrawn} {token}</span>
          </div>
          <div className="flex justify-between px-4 py-3">
            <span className="text-slate-400">Remaining in stream</span>
            <span className="font-semibold text-accent">{remaining} {token}</span>
          </div>
        </div>

        {/* Cancellation preview: resulting stream state */}
        <div className="mb-6 rounded-lg bg-white/5 border border-glass-border text-sm">
          <div className="px-4 py-3 border-b border-glass-border">
            <h3 className="font-semibold text-foreground">After cancellation</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Preview computed from the on-chain snapshot at the time this dialog opened.
            </p>
          </div>
          <div className="divide-y divide-glass-border">
            <div className="flex justify-between px-4 py-3">
              <span className="text-slate-400">Stream status</span>
              <span className="font-semibold text-red-400">Cancelled</span>
            </div>
            <div className="flex justify-between px-4 py-3">
              <span className="text-slate-400">Beneficiary</span>
              <code className="font-mono text-xs text-foreground">{preview.recipient}</code>
            </div>
            <div className="flex justify-between px-4 py-3">
              <span className="text-slate-400">End time</span>
              <span className="font-semibold text-foreground">
                {preview.endTime > 0
                  ? new Date(preview.endTime * 1000).toLocaleString()
                  : "Immediate (now)"}
              </span>
            </div>
            <div className="flex justify-between px-4 py-3">
              <span className="text-slate-400">Remaining forfeited</span>
              <span className="font-semibold text-accent">{remaining} {token}</span>
            </div>
            <div className="flex justify-between px-4 py-3">
              <span className="text-slate-400">Already withdrawn (kept)</span>
              <span className="font-semibold text-foreground">{withdrawn} {token}</span>
            </div>
          </div>
          <div className="px-4 py-2 border-t border-glass-border text-xs text-slate-500">
            Assumptions: amounts are read from the latest confirmed snapshot; no further
            accrual is assumed after cancellation. Remaining funds stay locked in the
            contract until the recipient withdraws or the admin resolves them.
          </div>
        </div>

        {/* Stale-state guard */}
        {isStale && (
          <div
            role="alert"
            className="mb-6 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-300"
          >
            <strong className="text-amber-400">Stream state is stale.</strong>{" "}
            This preview is {preview.ageSeconds}s old. Refresh the stream before
            cancelling so the preview matches the contract.
          </div>
        )}

        {/* Consequence note */}
        <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300">
          <strong className="text-red-400">What happens:</strong> The stream stops immediately.
          The recipient keeps any already-withdrawn funds. Remaining funds
          ({remaining} {token}) stay locked in the contract until the recipient withdraws
          or the admin resolves them.
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Keep Stream
          </Button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={isSubmitting || isStale}
            title={isStale ? "Refresh the stream before cancelling" : undefined}
            className="inline-flex items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold bg-red-600 hover:bg-red-500 text-white transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
          >
            {isSubmitting ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Cancelling…
              </>
            ) : (
              "Yes, Cancel Stream"
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
