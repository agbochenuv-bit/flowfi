import { useMemo, useState } from "react";
import IncomingStreams from "../IncomingStreams";
import type { Stream } from "@/lib/dashboard";
import { BatchClaimDrawer } from "./BatchClaimDrawer";
import { ShareAddressModal } from "./ShareAddressModal";
import { Share2, Waves } from "lucide-react";
import { Button } from "../ui/Button";
import { useWallet } from "@/context/wallet-context";
import {
  summarizeIncomingObligations,
  formatExposureAmount,
  type ExposureSourceMeta,
} from "@/lib/portfolio-exposure";

interface DashboardIncomingProps {
  incomingStreams: Stream[];
  onWithdraw: (stream: Stream) => Promise<void>;
  withdrawingStreamId: string | null;
  /** Opens the batch-claim drawer owned by the dashboard shell. When provided, the "Claim all" button delegates to the shell (enables the `c` keyboard shortcut). */
  onOpenBatchClaim?: () => void;
  /** Called after a successful batch claim when the drawer is managed internally. */
  onBatchClaimSuccess?: () => Promise<void> | void;
  /** Stream highlighted by keyboard navigation (j/k). */
  selectedStreamId?: string | null;
  /** Indexer/source metadata used to timestamp the expected-payments summary. */
  sourceMeta?: ExposureSourceMeta;
}

export function DashboardIncoming({
  incomingStreams,
  onWithdraw,
  withdrawingStreamId,
  onOpenBatchClaim,
  onBatchClaimSuccess,
  selectedStreamId = null,
  sourceMeta,
}: DashboardIncomingProps) {
  const { session } = useWallet();
  const [showBatchClaim, setShowBatchClaim] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  const obligations = useMemo(
    () => summarizeIncomingObligations(incomingStreams, sourceMeta),
    [incomingStreams, sourceMeta]
  );

  const claimableCount = incomingStreams.filter(
    (stream) => stream.isActive && stream.status === "Active" && stream.deposited > stream.withdrawn
  ).length;

  const handleClaimAll = () => {
    if (onOpenBatchClaim) {
      onOpenBatchClaim();
    } else {
      setShowBatchClaim(true);
    }
  };

  if (incomingStreams.length === 0) {
    return (
      <div className="mt-8">
        <div className="glass-card p-12 text-center">
          {/* Animated SVG Illustration */}
          <div className="relative mx-auto w-48 h-48 mb-6">
            <svg viewBox="0 0 200 200" className="w-full h-full">
              {/* Background circle with gradient */}
              <defs>
                <linearGradient id="waveGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.1" />
                </linearGradient>
                <linearGradient id="accentGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#06b6d4" />
                  <stop offset="100%" stopColor="#3b82f6" />
                </linearGradient>
              </defs>

              {/* Outer circle */}
              <circle
                cx="100"
                cy="100"
                r="80"
                fill="none"
                stroke="url(#waveGradient)"
                strokeWidth="2"
                opacity="0.5"
              />

              {/* Animated waves */}
              <g className="animate-pulse">
                <path
                  d="M 40 100 Q 60 80, 80 100 T 120 100 T 160 100"
                  fill="none"
                  stroke="url(#accentGradient)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  opacity="0.7"
                />
                <path
                  d="M 40 110 Q 60 90, 80 110 T 120 110 T 160 110"
                  fill="none"
                  stroke="url(#accentGradient)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity="0.5"
                />
                <path
                  d="M 40 120 Q 60 100, 80 120 T 120 120 T 160 120"
                  fill="none"
                  stroke="url(#accentGradient)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  opacity="0.3"
                />
              </g>

              {/* Center inbox icon */}
              <circle cx="100" cy="100" r="30" fill="#0f172a" />
              <rect x="80" y="90" width="40" height="25" rx="3" fill="none" stroke="#06b6d4" strokeWidth="2" />
              <path d="M 80 95 L 100 105 L 120 95" fill="none" stroke="#06b6d4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          {/* Title and Description */}
          <h3 className="text-2xl font-bold mb-3">No Incoming Streams Yet</h3>
          <p className="text-slate-400 max-w-md mx-auto mb-6">
            You haven&apos;t received any streaming payments yet. Share your payment address with a sender to start receiving continuous payments.
          </p>

          {/* Action Button */}
          {session?.publicKey && (
            <Button
              onClick={() => setShowShareModal(true)}
              glow
              className="inline-flex items-center gap-2"
            >
              <Share2 className="h-4 w-4" />
              Share Payment Address
            </Button>
          )}

          {/* Quick Info */}
          <div className="mt-8 pt-8 border-t border-white/10">
            <h4 className="text-sm font-semibold mb-4 text-slate-300">How Continuous Payments Work</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-left">
              <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                    <span className="text-accent font-bold">1</span>
                  </div>
                  <h5 className="font-semibold text-sm">Share Address</h5>
                </div>
                <p className="text-xs text-slate-400">
                  Give your Stellar address to anyone who wants to pay you
                </p>
              </div>

              <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                    <Waves className="h-4 w-4 text-accent" />
                  </div>
                  <h5 className="font-semibold text-sm">Receive Streams</h5>
                </div>
                <p className="text-xs text-slate-400">
                  Funds flow continuously per second, not as lump sums
                </p>
              </div>

              <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                    <span className="text-accent font-bold">3</span>
                  </div>
                  <h5 className="font-semibold text-sm">Withdraw Anytime</h5>
                </div>
                <p className="text-xs text-slate-400">
                  Claim your available balance whenever you want
                </p>
              </div>
            </div>
          </div>
        </div>

        {showShareModal && session?.publicKey && (
          <ShareAddressModal
            address={session.publicKey}
            onClose={() => setShowShareModal(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mt-8">
      <div className="mb-4 rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-200">
            Expected incoming payments
          </h3>
          <span className="text-xs text-slate-400">
            {obligations.sourceTimestamp
              ? `Source updated ${new Date(obligations.sourceTimestamp).toLocaleString()}`
              : "Source timestamp unavailable"}
            {obligations.isStale && (
              <span className="ml-2 rounded bg-amber-500/20 px-2 py-0.5 text-amber-300">
                Stale data
              </span>
            )}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-400">Total expected</dt>
            <dd className="font-semibold text-slate-100">
              {formatExposureAmount(obligations.totalExpected)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Claimable now</dt>
            <dd className="font-semibold text-slate-100">
              {formatExposureAmount(obligations.claimable)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Paused streams</dt>
            <dd className="font-semibold text-slate-100">
              {obligations.pausedCount} ({formatExposureAmount(obligations.pausedExpected)})
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Active streams</dt>
            <dd className="font-semibold text-slate-100">{obligations.activeCount}</dd>
          </div>
        </dl>
        {obligations.byAsset.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
            {obligations.byAsset.map((entry) => (
              <li
                key={entry.asset}
                className="rounded bg-white/5 px-2 py-1"
              >
                {entry.asset}: {formatExposureAmount(entry.expected)}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Estimates are derived from streamed balances at the source timestamp and may
          differ from on-chain values. Paused streams are included but not claimable.
        </p>
      </div>
      {claimableCount >= 2 && (
        <button
          type="button"
          onClick={handleClaimAll}
          className="mb-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white"
        >
          Claim all available
        </button>
      )}
      <IncomingStreams
        streams={incomingStreams}
        onWithdraw={onWithdraw}
        withdrawingStreamId={withdrawingStreamId}
        network={session?.network ?? "Unknown"}
        selectedStreamId={selectedStreamId}
      />
      {showBatchClaim && (
        <BatchClaimDrawer
          streams={incomingStreams}
          onClose={() => setShowBatchClaim(false)}
          onSuccess={onBatchClaimSuccess ?? (() => undefined)}
        />
      )}
    </div>
  );
}
