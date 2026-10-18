import React from "react";
import TransactionTracker, {
  TransactionStatus,
  TransactionAction,
} from "../TransactionTracker";

/**
 * Storybook / Visual Component Definition for Transaction Progress Bar
 * Illustrates all UI states across the on-chain transaction lifecycle:
 * - Idle
 * - Signing (wallet prompt)
 * - Submitted (in-flight broadcast)
 * - Confirming (polling indexer)
 * - Confirmed (ledger confirmed)
 * - Failed (error details & retry)
 * - Cancelled (user aborted)
 */

export interface TransactionProgressBarStoryProps {
  status: TransactionStatus;
  action: TransactionAction;
  txHash?: string;
  error?: string;
  errorCode?: string;
  onRetry?: () => void;
  onCancel?: () => void;
}

export const TransactionProgressBarStories = {
  Idle: {
    props: {
      status: "idle" as TransactionStatus,
      action: "create" as TransactionAction,
    },
  },
  Signing: {
    props: {
      status: "signing" as TransactionStatus,
      action: "create" as TransactionAction,
      onCancel: () => console.log("Cancelled signing"),
    },
  },
  Submitted: {
    props: {
      status: "submitted" as TransactionStatus,
      action: "withdraw" as TransactionAction,
      txHash: "0x3a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b",
    },
  },
  Confirming: {
    props: {
      status: "confirming" as TransactionStatus,
      action: "topup" as TransactionAction,
      txHash: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    },
  },
  Confirmed: {
    props: {
      status: "confirmed" as TransactionStatus,
      action: "create" as TransactionAction,
      txHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    },
  },
  Failed: {
    props: {
      status: "failed" as TransactionStatus,
      action: "withdraw" as TransactionAction,
      error: "Transaction underfunded or expired sequence number",
      errorCode: "TX_INSUFFICIENT_FEE",
      onRetry: () => console.log("Retrying transaction"),
      onCancel: () => console.log("Dismiss error"),
    },
  },
  Cancelled: {
    props: {
      status: "cancelled" as TransactionStatus,
      action: "cancel" as TransactionAction,
      error: "User rejected transaction signature in wallet",
      onRetry: () => console.log("Restart action"),
    },
  },
};

/**
 * Preview showcase component rendering all progress bar states simultaneously.
 */
export function TransactionProgressBarShowcase() {
  return (
    <div className="space-y-6 p-6 max-w-2xl mx-auto bg-background text-foreground">
      <h2 className="text-xl font-bold tracking-tight">Transaction Progress Bar Story Showcase</h2>

      <div className="space-y-4">
        {Object.entries(TransactionProgressBarStories).map(([name, story]) => (
          <div key={name} className="border rounded-lg p-4 bg-card shadow-sm">
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground uppercase">
              State: {name}
            </h3>
            <TransactionTracker {...story.props} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default TransactionProgressBarShowcase;
