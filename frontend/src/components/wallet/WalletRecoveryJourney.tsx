import React, { useCallback, useMemo, useState } from "react";

/**
 * WalletRecoveryJourney
 *
 * A guided, step-based UI that helps a user reconnect or replace a wallet.
 *
 * IMPORTANT: This component never implies the application can recover a
 * private key. It only guides the user through reconnecting an existing
 * wallet or replacing it with a new one. Records that are address-bound
 * (streams, history, preferences) are explained separately from actions
 * that require the original signer (withdraw, cancel, top-up).
 */

export type WalletRecoveryState =
  | "disconnected"
  | "wrong-account"
  | "revoked-session"
  | "unavailable-wallet";

export type WalletRecoveryPath = "reconnect" | "replace";

export interface WalletRecoveryJourneyProps {
  /** The current recovery state that triggered the journey. */
  state: WalletRecoveryState;
  /** The address the user is expected to reconnect with, if known. */
  expectedAddress?: string;
  /** The address currently connected, if any. */
  connectedAddress?: string;
  /** Called when the user chooses to reconnect the existing wallet. */
  onReconnect?: () => void | Promise<void>;
  /** Called when the user chooses to replace the wallet with a new one. */
  onReplaceWallet?: () => void | Promise<void>;
  /** Called when the user dismisses the journey. */
  onDismiss?: () => void;
  /** Optional class name for layout customization. */
  className?: string;
}

interface StateCopy {
  title: string;
  description: string;
  primaryCta: string;
  secondaryCta: string;
}

const STATE_COPY: Record<WalletRecoveryState, StateCopy> = {
  disconnected: {
    title: "Your wallet is disconnected",
    description:
      "We lost the connection to your wallet. Reconnect the same wallet to keep using your address-bound records, or replace it with a new wallet.",
    primaryCta: "Reconnect wallet",
    secondaryCta: "Use a different wallet",
  },
  "wrong-account": {
    title: "A different account is connected",
    description:
      "The connected account does not match the one tied to your records. Switch back to the original account, or replace your wallet to continue with a new address.",
    primaryCta: "Switch to original account",
    secondaryCta: "Use a different wallet",
  },
  "revoked-session": {
    title: "Your session was revoked",
    description:
      "Your wallet session was revoked, so you need to sign in again. Reconnect the same wallet to restore access, or replace it with a new wallet.",
    primaryCta: "Sign in again",
    secondaryCta: "Use a different wallet",
  },
  "unavailable-wallet": {
    title: "Your wallet is unavailable",
    description:
      "We could not reach your wallet provider. Make sure your wallet extension or app is installed and unlocked, then reconnect. If the wallet is lost, you can replace it with a new one.",
    primaryCta: "Retry connection",
    secondaryCta: "Use a different wallet",
  },
};

const ADDRESS_BOUND_RECORDS = [
  "Streams you created or received",
  "Transaction and activity history",
  "Saved preferences and settings",
];

const SIGNER_REQUIRED_ACTIONS = [
  "Withdrawing funds",
  "Cancelling a stream",
  "Topping up a stream",
];

const NO_PRIVATE_KEY_RECOVERY_COPY =
  "This app cannot recover, restore, or reset your private key or seed phrase. Only your wallet provider can do that. If you have lost access to your wallet, you must recover it through your wallet provider or replace it with a new wallet.";

type Step = "overview" | "records" | "actions" | "choose" | "confirm";

const STEPS: Step[] = ["overview", "records", "actions", "choose", "confirm"];

const STEP_LABELS: Record<Step, string> = {
  overview: "What happened",
  records: "Address-bound records",
  actions: "Signer-required actions",
  choose: "Choose a path",
  confirm: "Confirm",
};

function shortenAddress(address?: string): string {
  if (!address) return "";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletRecoveryJourney({
  state,
  expectedAddress,
  connectedAddress,
  onReconnect,
  onReplaceWallet,
  onDismiss,
  className,
}: WalletRecoveryJourneyProps): JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  const [path, setPath] = useState<WalletRecoveryPath | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = STATE_COPY[state];
  const step = STEPS[stepIndex];

  const goNext = useCallback(() => {
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }, []);

  const goBack = useCallback(() => {
    setStepIndex((i) => Math.max(i - 1, 0));
  }, []);

  const choosePath = useCallback(
    (next: WalletRecoveryPath) => {
      setPath(next);
      setError(null);
      goNext();
    },
    [goNext],
  );

  const handleConfirm = useCallback(async () => {
    if (!path) return;
    setPending(true);
    setError(null);
    try {
      if (path === "reconnect") {
        await onReconnect?.();
      } else {
        await onReplaceWallet?.();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }, [path, onReconnect, onReplaceWallet]);

  const addressMismatch = useMemo(() => {
    if (!expectedAddress || !connectedAddress) return false;
    return (
      expectedAddress.toLowerCase() !== connectedAddress.toLowerCase()
    );
  }, [expectedAddress, connectedAddress]);

  return (
    <section
      className={className}
      aria-labelledby="wallet-recovery-title"
      data-testid="wallet-recovery-journey"
      data-state={state}
      data-step={step}
    >
      <header>
        <h2 id="wallet-recovery-title">{copy.title}</h2>
        <p>{copy.description}</p>
        {addressMismatch && (
          <p role="alert" data-testid="wallet-recovery-address-mismatch">
            Connected account {shortenAddress(connectedAddress)} does not match
            the expected account {shortenAddress(expectedAddress)}.
          </p>
        )}
      </header>

      <nav aria-label="Recovery steps">
        <ol>
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={i === stepIndex ? "step" : undefined}
              data-testid={`wallet-recovery-step-${s}`}
            >
              {STEP_LABELS[s]}
            </li>
          ))}
        </ol>
      </nav>

      <div data-testid="wallet-recovery-step-content">
        {step === "overview" && (
          <div>
            <p>
              Your wallet connection needs attention. This guide walks you
              through reconnecting the same wallet or replacing it with a new
              one.
            </p>
            <p data-testid="wallet-recovery-no-key-recovery">
              {NO_PRIVATE_KEY_RECOVERY_COPY}
            </p>
          </div>
        )}

        {step === "records" && (
          <div>
            <h3>Records tied to your address</h3>
            <p>
              These records are bound to your wallet address. Reconnecting the
              same wallet keeps them accessible. Replacing your wallet with a
              new address will not automatically move these records.
            </p>
            <ul data-testid="wallet-recovery-address-bound-records">
              {ADDRESS_BOUND_RECORDS.map((record) => (
                <li key={record}>{record}</li>
              ))}
            </ul>
          </div>
        )}

        {step === "actions" && (
          <div>
            <h3>Actions that require the original signer</h3>
            <p>
              These actions must be signed by the original wallet. If you no
              longer control that wallet, you cannot perform them from a
              replacement wallet.
            </p>
            <ul data-testid="wallet-recovery-signer-actions">
              {SIGNER_REQUIRED_ACTIONS.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </div>
        )}

        {step === "choose" && (
          <div>
            <h3>Choose how to continue</h3>
            <div role="group" aria-label="Recovery path">
              <button
                type="button"
                onClick={() => choosePath("reconnect")}
                data-testid="wallet-recovery-choose-reconnect"
              >
                {copy.primaryCta}
              </button>
              <button
                type="button"
                onClick={() => choosePath("replace")}
                data-testid="wallet-recovery-choose-replace"
              >
                {copy.secondaryCta}
              </button>
            </div>
          </div>
        )}

        {step === "confirm" && (
          <div>
            <h3>
              {path === "reconnect"
                ? "Reconnect your wallet"
                : "Replace your wallet"}
            </h3>
            {path === "reconnect" ? (
              <p>
                We will ask your wallet to reconnect. Make sure the original
                wallet is available and unlocked.
              </p>
            ) : (
              <p>
                You will connect a new wallet. Address-bound records will stay
                with your previous address, and signer-required actions will
                need the original wallet.
              </p>
            )}
            <p data-testid="wallet-recovery-no-key-recovery-confirm">
              {NO_PRIVATE_KEY_RECOVERY_COPY}
            </p>
            {error && (
              <p role="alert" data-testid="wallet-recovery-error">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={pending}
              data-testid="wallet-recovery-confirm"
            >
              {pending ? "Working…" : "Continue"}
            </button>
          </div>
        )}
      </div>

      <footer>
        <button
          type="button"
          onClick={goBack}
          disabled={stepIndex === 0 || pending}
          data-testid="wallet-recovery-back"
        >
          Back
        </button>
        {step !== "choose" && step !== "confirm" && (
          <button
            type="button"
            onClick={goNext}
            data-testid="wallet-recovery-next"
          >
            Next
          </button>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            disabled={pending}
            data-testid="wallet-recovery-dismiss"
          >
            Dismiss
          </button>
        )}
      </footer>
    </section>
  );
}

export const WALLET_RECOVERY_NO_PRIVATE_KEY_COPY = NO_PRIVATE_KEY_RECOVERY_COPY;
export const WALLET_RECOVERY_ADDRESS_BOUND_RECORDS = ADDRESS_BOUND_RECORDS;
export const WALLET_RECOVERY_SIGNER_REQUIRED_ACTIONS = SIGNER_REQUIRED_ACTIONS;

export default WalletRecoveryJourney;