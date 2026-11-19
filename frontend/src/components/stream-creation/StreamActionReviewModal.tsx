"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useModalDialog } from "@/hooks/useModalDialog";

export type FeeEstimateStatus = "available" | "unavailable" | "pending";

export interface FeeEstimate {
  /** Estimated fee amount in the network's native unit, as a display string. */
  amount: string;
  /** Native unit symbol, e.g. "XLM". */
  unit: string;
  /** When the estimate was produced. */
  fetchedAt: Date | number;
  /** Congestion context, e.g. "low", "moderate", "high". */
  congestion?: string;
  /** Optional simulation status, e.g. "simulated", "not simulated". */
  simulation?: string;
}

interface StreamActionReviewModalProps {
  title: string;
  actionLabel: string;
  streamId: string;
  network: string;
  token: string;
  amount: string;
  consequence: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  /** Optional fee estimate; when omitted no cost section is rendered. */
  feeEstimate?: FeeEstimate | null;
  /** Status of the fee estimate. Defaults to "available" when feeEstimate is set. */
  feeStatus?: FeeEstimateStatus;
  /** Age (ms) after which an estimate is considered stale. Defaults to 60s. */
  staleAfterMs?: number;
  /** Optional message shown when the fee estimate is unavailable. */
  unavailableMessage?: string;
}

const DEFAULT_STALE_AFTER_MS = 60_000;

const toMillis = (value: Date | number): number =>
  value instanceof Date ? value.getTime() : value;

export const StreamActionReviewModal: React.FC<StreamActionReviewModalProps> = ({
  title,
  actionLabel,
  streamId,
  network,
  token,
  amount,
  consequence,
  onConfirm,
  onClose,
  feeEstimate,
  feeStatus,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  unavailableMessage,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isSubmitting });

  const resolvedFeeStatus: FeeEstimateStatus =
    feeStatus ?? (feeEstimate ? "available" : "unavailable");

  const isStale =
    resolvedFeeStatus === "available" &&
    !!feeEstimate &&
    Date.now() - toMillis(feeEstimate.fetchedAt) > staleAfterMs;

  const showCostSection = feeEstimate !== undefined || feeStatus !== undefined;

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm();
    } catch {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stream-action-review-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="glass-card relative mx-4 w-full max-w-md rounded-2xl border border-glass-border p-6"
      >
        <h2 id="stream-action-review-title" className="text-xl font-bold">
          {title}
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Review these transaction details before continuing to your wallet.
        </p>

        <dl className="mt-5 divide-y divide-glass-border rounded-lg border border-glass-border bg-white/5 text-sm">
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-slate-400">Stream</dt>
            <dd className="break-all text-right font-mono">#{streamId}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-slate-400">Network</dt>
            <dd className="text-right">{network}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-slate-400">Amount</dt>
            <dd className="text-right font-semibold">{amount} {token}</dd>
          </div>
        </dl>

        {showCostSection && (
          <section
            aria-label="Transaction cost and network congestion"
            className="mt-4 rounded-lg border border-glass-border bg-white/5 p-3 text-sm"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Transaction cost
            </h3>
            {resolvedFeeStatus === "available" && feeEstimate ? (
              <dl className="mt-2 space-y-1">
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-400">Estimated fee</dt>
                  <dd className="text-right font-semibold">
                    {feeEstimate.amount} {feeEstimate.unit}
                    <span className="ml-1 text-xs font-normal text-slate-400">
                      (estimate)
                    </span>
                  </dd>
                </div>
                {feeEstimate.simulation && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-400">Simulation</dt>
                    <dd className="text-right">{feeEstimate.simulation}</dd>
                  </div>
                )}
                {feeEstimate.congestion && (
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-400">Network congestion</dt>
                    <dd className="text-right">{feeEstimate.congestion}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-400">Updated</dt>
                  <dd className="text-right text-slate-300">
                    {new Date(toMillis(feeEstimate.fetchedAt)).toLocaleTimeString()}
                  </dd>
                </div>
              </dl>
            ) : resolvedFeeStatus === "pending" ? (
              <p className="mt-2 text-slate-300">Fetching fee estimate…</p>
            ) : (
              <p className="mt-2 text-slate-300">
                {unavailableMessage ??
                  "Fee estimate unavailable — the network RPC could not be reached. Your wallet will show the final fee before you sign."}
              </p>
            )}
            {isStale && (
              <p
                role="status"
                className="mt-2 rounded border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-200"
              >
                This estimate may be stale. Refresh before signing.
              </p>
            )}
          </section>
        )}

        <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
          {consequence}
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Back
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={isSubmitting}>
            {isSubmitting ? "Submitting…" : actionLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};