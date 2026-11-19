import toast, { type ToastOptions } from "react-hot-toast";

const SOUND_STORAGE_KEY = "flowfi-transaction-sounds";
let lastSoundAt = 0;

export function playTransactionSuccessSound(): void {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(SOUND_STORAGE_KEY) !== "true") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (Date.now() - lastSoundAt < 700) return;
  lastSoundAt = Date.now();

  try {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const now = context.currentTime;
    const master = context.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
    master.connect(context.destination);

    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const note = context.createGain();
      const start = now + index * 0.13;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      note.gain.setValueAtTime(0.0001, start);
      note.gain.exponentialRampToValueAtTime(0.7, start + 0.02);
      note.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
      oscillator.connect(note);
      note.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 0.25);
    });

    window.setTimeout(() => void context.close(), 600);
  } catch {
    // Sound is optional; autoplay restrictions must never interrupt a payment flow.
  }
}

export function transactionSuccessToast(
  message: string,
  options?: ToastOptions
): string {
  playTransactionSuccessSound();
  // Only forward options when they exist: `toast.success(msg, undefined)` is
  // equivalent at runtime, but the explicit second argument breaks callers
  // (and tests) that match against the single-argument call.
  return options ? toast.success(message, options) : toast.success(message);
}

/**
 * Finality states a transaction can be in. Success feedback is only emitted on
 * `confirmed`; submission and confirmation-in-progress states must stay silent
 * so users never see a premature or duplicate success message.
 */
export type TransactionFinality =
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed"
  | "user-action-required";

export function isTransactionConfirmed(
  finality: TransactionFinality | null | undefined
): boolean {
  return finality === "confirmed";
}

/**
 * Emit a success toast only when the transaction has reached the `confirmed`
 * finality transition. Returns the toast id, or `null` when nothing was shown.
 */
export function transactionFinalitySuccessToast(
  finality: TransactionFinality | null | undefined,
  message: string,
  options?: ToastOptions
): string | null {
  if (!isTransactionConfirmed(finality)) return null;
  return transactionSuccessToast(message, options);
}

export interface TransactionCenterToastOptions {
  /** Optional deep link to the transaction center entry for this action. */
  href?: string;
  /** Optional callback used instead of a link (e.g. router navigation). */
  onOpen?: () => void;
  /** Label for the action button. Defaults to "View in transaction center". */
  actionLabel?: string;
  /** Extra toast options; `duration` defaults to a longer value for errors. */
  toastOptions?: ToastOptions;
}

function buildTransactionCenterAction(
  options?: TransactionCenterToastOptions
): ToastOptions {
  const action = options?.onOpen
    ? { label: options.actionLabel ?? "View in transaction center", onClick: options.onOpen }
    : options?.href
      ? {
          label: options.actionLabel ?? "View in transaction center",
          onClick: () => {
            if (typeof window !== "undefined") window.location.assign(options.href!);
          },
        }
      : undefined;

  return {
    duration: 8000,
    ...options?.toastOptions,
    ...(action ? { action } : {}),
  };
}

/**
 * Surface a transaction that needs the user to act (e.g. a wallet signature or
 * a recovery step) before it can progress, with a path back to the center.
 */
export function transactionUserActionRequiredToast(
  message: string,
  options?: TransactionCenterToastOptions
): string {
  return toast(message, {
    icon: "⚠️",
    ...buildTransactionCenterAction(options),
  });
}

/**
 * Surface a failed transaction with a path back to the transaction center so
 * the user can inspect or resume it.
 */
export function transactionFailedToast(
  message: string,
  options?: TransactionCenterToastOptions
): string {
  return toast.error(message, buildTransactionCenterAction(options));
}

export { SOUND_STORAGE_KEY };
