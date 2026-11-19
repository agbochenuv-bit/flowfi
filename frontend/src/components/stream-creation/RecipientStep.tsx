"use client";
import React, { useRef, useEffect, useState } from "react";
import { validateRecipient } from "@/lib/stream-validation";

export interface RecipientEntry {
  /** Stable identifier so React keys survive reordering/removal. */
  id: string;
  address: string;
  /** Raw weight input as typed; parsed/validated downstream. */
  weight: string;
}

interface RecipientStepProps {
  value: RecipientEntry[];
  onChange: (value: RecipientEntry[]) => void;
  error?: string;
}

const STELLAR_PUBLIC_KEY_LENGTH = 56;
const MAX_WEIGHT = 10000;

let recipientIdCounter = 0;
const nextRecipientId = () => `recipient-${++recipientIdCounter}`;

export const createRecipientEntry = (
  address = "",
  weight = "1",
): RecipientEntry => ({
  id: nextRecipientId(),
  address,
  weight,
});

const parseWeight = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
};

const validateWeight = (raw: string): string | null => {
  const parsed = parseWeight(raw);
  if (parsed === null) return "Weight must be a whole number.";
  if (parsed < 1) return "Weight must be at least 1.";
  if (parsed > MAX_WEIGHT) return `Weight must be at most ${MAX_WEIGHT}.`;
  return null;
};

interface RecipientRowProps {
  entry: RecipientEntry;
  index: number;
  total: number;
  addressError: string | null;
  weightError: string | null;
  duplicate: boolean;
  canRemove: boolean;
  autoFocus: boolean;
  onAddressChange: (id: string, address: string) => void;
  onWeightChange: (id: string, weight: string) => void;
  onRemove: (id: string) => void;
}

const RecipientRow: React.FC<RecipientRowProps> = ({
  entry,
  index,
  total,
  addressError,
  weightError,
  duplicate,
  canRemove,
  autoFocus,
  onAddressChange,
  onWeightChange,
  onRemove,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const trimmed = entry.address.trim();

  // Real-time feedback: validate once the user has committed the field
  // (blur / paste) or entered a full-length key, so partial typing does not
  // flash errors while still catching bad checksums immediately.
  const liveError =
    touched || trimmed.length >= STELLAR_PUBLIC_KEY_LENGTH
      ? validateRecipient(entry.address)
      : null;

  const displayError = addressError ?? liveError;

  const addressId = `recipient-address-${entry.id}`;
  const weightId = `recipient-weight-${entry.id}`;
  const addressErrorId = `${addressId}-error`;
  const weightErrorId = `${weightId}-error`;

  const handleAddressChange = (next: string) => {
    setTouched(true);
    onAddressChange(entry.id, next);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted) return;

    // Replace the current selection with the trimmed clipboard text so
    // whitespace-padded keys copied from wallets/explorers just work.
    e.preventDefault();
    const target = e.currentTarget;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const next =
      target.value.slice(0, start) + pasted.trim() + target.value.slice(end);
    setTouched(true);
    onAddressChange(entry.id, next);
  };

  const handleBlur = () => {
    setTouched(true);
    const cleaned = entry.address.trim();
    if (cleaned !== entry.address) {
      onAddressChange(entry.id, cleaned);
    }
  };

  const describedBy = [
    displayError ? addressErrorId : null,
    weightError ? weightErrorId : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      className="rounded-lg border border-glass-border bg-glass/40 p-4 space-y-3"
      aria-label={`Recipient ${index + 1} of ${total}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1 min-w-0">
          <label
            htmlFor={addressId}
            className="block text-sm font-medium mb-2 text-foreground"
          >
            Recipient {index + 1} public key
          </label>
          <input
            ref={inputRef}
            id={addressId}
            type="text"
            value={entry.address}
            onChange={(e) => handleAddressChange(e.target.value)}
            onPaste={handlePaste}
            onBlur={handleBlur}
            placeholder="GABCDEFGHIJKLMNOPQRSTUVWXYZ..."
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            className={`w-full px-4 py-3 rounded-lg bg-glass border ${
              displayError
                ? "border-red-500 focus:border-red-500 focus:ring-red-500"
                : "border-glass-border focus:border-accent focus:ring-accent"
            } focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-colors text-foreground placeholder-slate-500`}
            aria-invalid={!!displayError}
            aria-describedby={describedBy || undefined}
          />
          {displayError && (
            <p
              id={addressErrorId}
              className="mt-2 text-sm text-red-400 flex items-center gap-1"
              role="alert"
            >
              <svg
                className="w-4 h-4 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {displayError}
            </p>
          )}
          {duplicate && (
            <p
              id={`${addressId}-duplicate`}
              className="mt-2 text-sm text-red-400"
              role="alert"
            >
              This address is already listed. Each recipient may appear only
              once.
            </p>
          )}
        </div>

        <div className="sm:w-32">
          <label
            htmlFor={weightId}
            className="block text-sm font-medium mb-2 text-foreground"
          >
            Weight
          </label>
          <input
            id={weightId}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_WEIGHT}
            step={1}
            value={entry.weight}
            onChange={(e) => onWeightChange(entry.id, e.target.value)}
            className={`w-full px-4 py-3 rounded-lg bg-glass border ${
              weightError
                ? "border-red-500 focus:border-red-500 focus:ring-red-500"
                : "border-glass-border focus:border-accent focus:ring-accent"
            } focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-colors text-foreground`}
            aria-invalid={!!weightError}
            aria-describedby={weightError ? weightErrorId : undefined}
          />
          {weightError && (
            <p
              id={weightErrorId}
              className="mt-2 text-sm text-red-400"
              role="alert"
            >
              {weightError}
            </p>
          )}
        </div>

        <div className="sm:pt-8">
          <button
            type="button"
            onClick={() => onRemove(entry.id)}
            disabled={!canRemove}
            className="px-3 py-2 rounded-lg border border-glass-border text-sm text-slate-300 hover:text-red-400 hover:border-red-500/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label={`Remove recipient ${index + 1}`}
          >
            Remove
          </button>
        </div>
      </div>
    </li>
  );
};

export const RecipientStep: React.FC<RecipientStepProps> = ({
  value,
  onChange,
  error,
}) => {
  const [focusId, setFocusId] = useState<string | null>(null);

  const recipients = value.length > 0 ? value : [createRecipientEntry()];

  // Normalize an empty list to a single blank row without mutating props.
  useEffect(() => {
    if (value.length === 0) {
      onChange([createRecipientEntry()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.length]);

  const addressCounts = new Map<string, number>();
  for (const entry of recipients) {
    const key = entry.address.trim();
    if (!key) continue;
    addressCounts.set(key, (addressCounts.get(key) ?? 0) + 1);
  }

  const totalWeight = recipients.reduce((sum, entry) => {
    const parsed = parseWeight(entry.weight);
    return sum + (parsed ?? 0);
  }, 0);

  const handleAddressChange = (id: string, address: string) => {
    onChange(
      recipients.map((entry) =>
        entry.id === id ? { ...entry, address } : entry,
      ),
    );
  };

  const handleWeightChange = (id: string, weight: string) => {
    onChange(
      recipients.map((entry) => (entry.id === id ? { ...entry, weight } : entry)),
    );
  };

  const handleRemove = (id: string) => {
    if (recipients.length <= 1) return;
    onChange(recipients.filter((entry) => entry.id !== id));
  };

  const handleAdd = () => {
    const entry = createRecipientEntry();
    setFocusId(entry.id);
    onChange([...recipients, entry]);
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold mb-2">Recipients</h3>
        <p className="text-sm text-slate-400 mb-4">
          Add one or more Stellar public keys (G...) and assign each a weight.
          Payments are split proportionally to weight.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      <ul className="space-y-3">
        {recipients.map((entry, index) => {
          const key = entry.address.trim();
          return (
            <RecipientRow
              key={entry.id}
              entry={entry}
              index={index}
              total={recipients.length}
              addressError={null}
              weightError={validateWeight(entry.weight)}
              duplicate={!!key && (addressCounts.get(key) ?? 0) > 1}
              canRemove={recipients.length > 1}
              autoFocus={focusId === entry.id}
              onAddressChange={handleAddressChange}
              onWeightChange={handleWeightChange}
              onRemove={handleRemove}
            />
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={handleAdd}
          className="px-4 py-2 rounded-lg border border-accent/40 text-sm text-accent hover:bg-accent/10 transition-colors"
        >
          Add recipient
        </button>
        <p
          className="text-sm text-slate-300"
          aria-live="polite"
          aria-atomic="true"
        >
          Total weight: <strong className="text-accent">{totalWeight}</strong>
        </p>
      </div>

      <div className="mt-6 p-4 rounded-lg bg-accent/5 border border-accent/20">
        <p className="text-sm text-slate-300">
          <strong className="text-accent">Tip:</strong> You can copy the public
          key from the recipient&apos;s wallet or Stellar account explorer.
        </p>
      </div>
    </div>
  );
};
