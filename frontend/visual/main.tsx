import React from "react";
import { createRoot } from "react-dom/client";
import { IncomingStreamCard } from "../src/components/streams/IncomingStreamCard";
import { StreamDetailsModal } from "../src/components/dashboard/StreamDetailsModal";
import { StreamActionReviewModal } from "../src/components/stream-creation/StreamActionReviewModal";
import "../src/app/globals.css";

const noOp = () => {};
const view = new URLSearchParams(location.search).get("view") ?? "summary";
const stream = {
  id: "42", streamId: 42, senderDisplay: "Payroll treasury", recipient: "GDBX55OJUOXRSTWICUESBZAHSMJNFWZ57NEEPVN74BXKH7OGZV23RYCG",
  token: "USDC", ratePerSecond: 0.125, deposited: 1000, withdrawn: 250,
  status: "Active" as const, isActive: true, isPaused: false,
  lastUpdateTime: 1_700_000_000, date: "Nov 14, 2023",
};

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-slate-950 text-white p-5">
    {view === "summary" && (
      <div className="mx-auto max-w-xl pt-10">
        <IncomingStreamCard stream={stream as React.ComponentProps<typeof IncomingStreamCard>["stream"]} withdrawing={false} network="Testnet" onWithdraw={noOp} />
      </div>
    )}
    {view === "details" && (
      <StreamDetailsModal stream={stream as React.ComponentProps<typeof StreamDetailsModal>["stream"]} onClose={noOp} onCancelClick={noOp} onTopUpClick={noOp} />
    )}
    {view === "confirmation" && (
      <StreamActionReviewModal title="Review withdrawal" actionLabel="Continue to wallet" streamId="42" network="Testnet" token="USDC" amount="750" consequence="Network fee: 0.00001 XLM. You will receive 750 USDC. This action cannot be undone." onConfirm={noOp} onClose={noOp} />
    )}
  </main>,
);
