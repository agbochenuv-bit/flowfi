"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useModalDialog } from "@/hooks/useModalDialog";

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
}

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
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isSubmitting });

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