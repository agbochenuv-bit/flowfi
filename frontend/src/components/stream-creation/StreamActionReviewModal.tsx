"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useModalDialog } from "@/hooks/useModalDialog";
import {
  buildStreamChangePreview,
  type StreamChangePreview,
  type StreamChangePreviewInput,
} from "@/lib/streamChangePreview";

interface StreamActionReviewModalProps {
  title: string;
  actionLabel: string;
  streamId: string;
  network: string;
  token: string;
  amount: string;
  consequence: string;
  preview?: StreamChangePreviewInput;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

const formatPreviewValue = (value: string | number | null | undefined): string => {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
};

const StreamChangePreviewTable: React.FC<{ preview: StreamChangePreview }> = ({ preview }) => (
  <div className="mt-5">
    <table className="w-full table-fixed border-collapse overflow-hidden rounded-lg border border-glass-border text-sm">
      <thead>
        <tr className="bg-white/5 text-left text-xs uppercase tracking-wide text-slate-400">
          <th scope="col" className="px-3 py-2 font-medium">
            Field
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            Before
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            After
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-glass-border">
        {preview.rows.map((row) => (
          <tr key={row.field} className={row.changed ? "bg-emerald-500/5" : undefined}>
            <th scope="row" className="break-words px-3 py-2 text-left font-normal text-slate-400">
              {row.label}
            </th>
            <td className="break-words px-3 py-2 font-mono">{formatPreviewValue(row.before)}</td>
            <td
              className={`break-words px-3 py-2 font-mono ${
                row.changed ? "font-semibold text-emerald-300" : ""
              }`}
            >
              {formatPreviewValue(row.after)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    {preview.assumptions.length > 0 && (
      <div className="mt-3 rounded-lg border border-glass-border bg-white/5 p-3 text-xs text-slate-400">
        <p className="font-semibold text-slate-300">Assumptions</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {preview.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </div>
    )}
  </div>
);

export const StreamActionReviewModal: React.FC<StreamActionReviewModalProps> = ({
  title,
  actionLabel,
  streamId,
  network,
  token,
  amount,
  consequence,
  preview,
  onConfirm,
  onClose,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useModalDialog({ onClose, isCloseDisabled: isSubmitting });

  const changePreview = preview ? buildStreamChangePreview(preview) : null;
  const isBlocked = changePreview !== null && !changePreview.canConfirm;

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

        {changePreview && <StreamChangePreviewTable preview={changePreview} />}

        <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
          {consequence}
        </p>

        {changePreview && changePreview.blockers.length > 0 && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
          >
            <p className="font-semibold">Cannot continue</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {changePreview.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Back
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={isSubmitting || isBlocked}
            title={isBlocked ? "Resolve the issues above before continuing" : undefined}
          >
            {isSubmitting ? "Submitting…" : actionLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};