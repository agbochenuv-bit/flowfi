"use client";

import Link from "next/link";
import { AlertTriangle, RefreshCw, LifeBuoy } from "lucide-react";
import { useWallet } from "@/context/wallet-context";
import { useNetwork } from "@/context/NetworkContext";
import { formatNetwork } from "@/lib/wallet";

export function WalletMismatchBanner() {
  const { session, connect, selectedWalletId } = useWallet();
  const { network } = useNetwork();

  if (!session || formatNetwork(session.network).toLowerCase() === network.name.toLowerCase()) {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 border-b border-orange-400/30 bg-orange-400/10 px-6 py-2 text-sm text-orange-100 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <span className="flex items-start gap-2 sm:items-center">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 sm:mt-0" />
        <span>
          Wallet is on {formatNetwork(session.network)}; app is using {network.name}. Transactions may fail.
          <span className="mt-1 block text-xs text-orange-200/80">
            Reconnecting keeps your address-bound records with your original public key. Actions that require the
            original signer still need that signer — this app can never recover a private key.
          </span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => {
            if (selectedWalletId) void connect(selectedWalletId);
          }}
          className="flex items-center gap-2 rounded border border-orange-300/40 px-3 py-1 text-xs font-semibold"
        >
          <RefreshCw size={13} />
          Reconnect wallet
        </button>
        <Link
          href="/wallet/recovery"
          className="flex items-center gap-2 rounded border border-orange-300/40 px-3 py-1 text-xs font-semibold"
        >
          <LifeBuoy size={13} />
          Recover or replace wallet
        </Link>
      </span>
    </div>
  );
}