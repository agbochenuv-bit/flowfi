"use client";

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type { StreamFormData, StreamFormErrors } from "@/lib/stream-validation";

type ScheduleFormData = Pick<
  StreamFormData,
  "duration" | "durationUnit" | "descriptionTag" | "memo"
>;

/**
 * Recurring payment schedule configuration.
 *
 * Kept as a separate, optional slice so existing one-off streams remain
 * backward compatible: when `recurring` is undefined the step behaves exactly
 * as before.
 */
export interface RecurringScheduleConfig {
  /** Whether the stream should be split into recurring payment obligations. */
  enabled: boolean;
  /** Cadence between generated streams. */
  cadence: "daily" | "weekly" | "monthly";
  /** Number of recurring streams to generate (>= 1). */
  occurrences: number;
  /** ISO timestamp of the first run; subsequent runs derive from cadence. */
  startAt: string;
  /** Per-run amount in the stream asset's base units (string to avoid float drift). */
  amountPerRun: string;
}

export interface RecurringPreview {
  /** ISO timestamp of the next scheduled run, or null when the schedule is exhausted. */
  nextRunAt: string | null;
  /** Total funding required across all remaining runs, in base units. */
  totalFundingRequired: string;
  /** Spendable balance available for funding, in base units. */
  availableBalance: string;
  /** True when availableBalance < totalFundingRequired. */
  insufficientFunds: boolean;
  /** True when the connected wallet's network does not match the stream network. */
  networkMismatch: boolean;
  /** True when a scheduled run was missed (nextRunAt is in the past). */
  missedRun: boolean;
}

interface ScheduleStepProps {
  formData: ScheduleFormData;
  errors: StreamFormErrors;
  onUpdate: (data: Partial<StreamFormData>) => void;
  /** Optional recurring configuration; absent means one-off stream. */
  recurring?: RecurringScheduleConfig;
  /** Optional preview computed by the parent from the recurring config. */
  recurringPreview?: RecurringPreview;
  /** Called when recurring configuration changes. */
  onRecurringUpdate?: (data: Partial<RecurringScheduleConfig>) => void;
}

const MAX_MEMO_BYTES = 28;

const CADENCE_LABELS: Record<RecurringScheduleConfig["cadence"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

function formatAmount(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : value;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function ScheduleStep({
  formData,
  errors,
  onUpdate,
  recurring,
  recurringPreview,
  onRecurringUpdate,
}: ScheduleStepProps) {
  const memo = formData.memo || "";
  // UTF-8 byte length, derived during render rather than stored in state.
  const memoByteCount = useMemo(
    () => new TextEncoder().encode(memo).length,
    [memo],
  );

  const isNearLimit = memoByteCount >= MAX_MEMO_BYTES * 0.8;
  const isOverLimit = memoByteCount > MAX_MEMO_BYTES;

  const recurringEnabled = Boolean(recurring?.enabled);
  const occurrences = recurring?.occurrences ?? 1;
  const occurrencesInvalid = recurringEnabled && (!Number.isInteger(occurrences) || occurrences < 1);

  // Confirmation must be blocked when the preview reports a shortfall or a
  // wallet/network mismatch. The parent reads this via the disabled state of
  // its confirm control; we also surface it inline below.
  const blockedByPreview = Boolean(
    recurringEnabled &&
      recurringPreview &&
      (recurringPreview.insufficientFunds || recurringPreview.networkMismatch),
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Schedule & Details</h2>
        <p className="text-slate-400">Configure the stream duration and add optional details</p>
      </div>

      {onRecurringUpdate && (
        <div className="space-y-4 p-4 rounded-lg bg-white/5 border border-white/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Recurring payment schedule</p>
              <p className="text-slate-400 text-xs mt-1">
                Split this stream into separate payment obligations on a fixed cadence.
              </p>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={recurringEnabled}
                onChange={(e) => onRecurringUpdate({ enabled: e.target.checked })}
                className="h-4 w-4 rounded border-white/20 bg-black/40 accent-accent"
                aria-label="Enable recurring payment schedule"
              />
              <span className="text-sm">Enable</span>
            </label>
          </div>

          {recurringEnabled && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="recurringCadence" className="block text-sm font-medium mb-2">
                    Cadence
                  </label>
                  <select
                    id="recurringCadence"
                    value={recurring?.cadence ?? "monthly"}
                    onChange={(e) =>
                      onRecurringUpdate({
                        cadence: e.target.value as RecurringScheduleConfig["cadence"],
                      })
                    }
                    className="w-full px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
                  >
                    {(Object.keys(CADENCE_LABELS) as RecurringScheduleConfig["cadence"][]).map(
                      (cadence) => (
                        <option key={cadence} value={cadence}>
                          {CADENCE_LABELS[cadence]}
                        </option>
                      ),
                    )}
                  </select>
                </div>

                <div>
                  <label htmlFor="recurringOccurrences" className="block text-sm font-medium mb-2">
                    Occurrences
                  </label>
                  <input
                    id="recurringOccurrences"
                    type="number"
                    min="1"
                    step="1"
                    value={recurring?.occurrences ?? 1}
                    onChange={(e) =>
                      onRecurringUpdate({ occurrences: Number(e.target.value) })
                    }
                    className="w-full px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
                  />
                  {occurrencesInvalid && (
                    <p className="text-red-400 text-sm mt-1" role="alert">
                      Occurrences must be a whole number of at least 1.
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="recurringStartAt" className="block text-sm font-medium mb-2">
                    First run
                  </label>
                  <input
                    id="recurringStartAt"
                    type="datetime-local"
                    value={recurring?.startAt ?? ""}
                    onChange={(e) => onRecurringUpdate({ startAt: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="recurringAmount" className="block text-sm font-medium mb-2">
                    Amount per run
                  </label>
                  <input
                    id="recurringAmount"
                    type="text"
                    inputMode="decimal"
                    value={recurring?.amountPerRun ?? ""}
                    onChange={(e) => onRecurringUpdate({ amountPerRun: e.target.value })}
                    className="w-full px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
                    placeholder="e.g., 100"
                  />
                </div>
              </div>

              {recurringPreview && (
                <div className="space-y-2 p-3 rounded-lg bg-black/30 border border-white/10">
                  <p className="text-sm font-semibold">Before you confirm</p>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <dt className="text-slate-400">Next run</dt>
                    <dd className="font-mono">{formatTimestamp(recurringPreview.nextRunAt)}</dd>
                    <dt className="text-slate-400">Funding required</dt>
                    <dd className="font-mono">
                      {formatAmount(recurringPreview.totalFundingRequired)}
                    </dd>
                    <dt className="text-slate-400">Available balance</dt>
                    <dd className="font-mono">{formatAmount(recurringPreview.availableBalance)}</dd>
                  </dl>

                  {recurringPreview.missedRun && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                      <AlertTriangle className="h-4 w-4 text-yellow-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-yellow-400 text-sm font-semibold">Missed run detected</p>
                        <p className="text-yellow-400/80 text-xs mt-1">
                          The next scheduled run is in the past. Adjust the first run or cadence
                          before confirming.
                        </p>
                      </div>
                    </div>
                  )}

                  {recurringPreview.insufficientFunds && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                      <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-red-400 text-sm font-semibold">Insufficient funds</p>
                        <p className="text-red-400/80 text-xs mt-1">
                          Available balance does not cover the total funding required. Top up or
                          reduce the schedule before confirming.
                        </p>
                      </div>
                    </div>
                  )}

                  {recurringPreview.networkMismatch && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                      <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-red-400 text-sm font-semibold">Wallet network mismatch</p>
                        <p className="text-red-400/80 text-xs mt-1">
                          Your wallet is connected to a different network than this stream. Switch
                          networks before confirming.
                        </p>
                      </div>
                    </div>
                  )}

                  {blockedByPreview && (
                    <p className="text-red-400 text-xs" role="alert">
                      Confirmation is disabled until the issues above are resolved.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
=======

      <div className="space-y-4">
        <div>
          <label htmlFor="duration" className="block text-sm font-medium mb-2">
            Duration
          </label>
          <div className="flex gap-3">
            <input
              id="duration"
              type="number"
              min="1"
              value={formData.duration}
              onChange={(e) => onUpdate({ duration: e.target.value })}
              className="flex-1 px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
              placeholder="Enter duration"
            />
            <select
              value={formData.durationUnit}
              onChange={(e) =>
                onUpdate({
                  durationUnit: e.target.value as StreamFormData["durationUnit"],
                })
              }
              className="px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
            >
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </div>
          {errors.duration && (
            <p className="text-red-400 text-sm mt-1" role="alert">{errors.duration}</p>
          )}
          {errors.rate && (
            <p className="text-red-400 text-sm mt-1" role="alert">{errors.rate}</p>
          )}
        </div>

        <div>
          <label htmlFor="descriptionTag" className="block text-sm font-medium mb-2">
            Description Tag
          </label>
          <input
            id="descriptionTag"
            type="text"
            value={formData.descriptionTag ?? ""}
            onChange={(e) => onUpdate({ descriptionTag: e.target.value })}
            className="w-full px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
            placeholder="e.g., salary, contractor-payment, subscription"
          />
          {errors.descriptionTag && (
            <p className="text-red-400 text-sm mt-1" role="alert">{errors.descriptionTag}</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="memo" className="block text-sm font-medium">
              Memo (Optional)
            </label>
            <span
              className={`text-xs font-mono ${
                isOverLimit
                  ? "text-red-400"
                  : isNearLimit
                  ? "text-yellow-400"
                  : "text-slate-400"
              }`}
            >
              {memoByteCount} / {MAX_MEMO_BYTES} bytes
            </span>
          </div>
          <textarea
            id="memo"
            value={memo}
            onChange={(e) => onUpdate({ memo: e.target.value })}
            className={`w-full px-4 py-3 rounded-lg bg-black/40 border outline-none resize-none ${
              isOverLimit
                ? "border-red-500/50 focus:border-red-500"
                : "border-white/10 focus:border-accent"
            }`}
            placeholder="Add a note (max 28 bytes)"
            rows={3}
            maxLength={MAX_MEMO_BYTES * 4} // Allow more chars for validation, UTF-8 can use up to 4 bytes per char
          />
          {isOverLimit && (
            <div className="mt-2 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-red-400 text-sm font-semibold">Memo exceeds byte limit</p>
                <p className="text-red-400/80 text-xs mt-1">
                  Stellar memos are limited to 28 bytes. Note that some characters use multiple bytes.
                </p>
              </div>
            </div>
          )}
          {isNearLimit && !isOverLimit && (
            <p className="text-yellow-400 text-xs mt-1">
              ⚠ Approaching byte limit - some characters use multiple bytes
            </p>
          )}
          <p className="text-slate-400 text-xs mt-1">
            Add a custom note to your stream transaction (UTF-8 encoded)
          </p>
        </div>
      </div>
    </div>
  );
}
