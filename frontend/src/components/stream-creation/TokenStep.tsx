"use client";
import React from "react";

export type AssetVerificationStatus =
  | "configured"
  | "verified"
  | "deprecated"
  | "unverified"
  | "blocked";

export interface TokenAssetMetadata {
  /** Raw on-chain identifier (e.g. issuer:asset or contract address). Always displayed. */
  id: string;
  name?: string;
  symbol?: string;
  description?: string;
  /** Where the metadata came from, e.g. "asset-list", "issuer-toml", "user-input". */
  provenance?: string;
  /** Network-specific contract / issuer address. */
  address?: string;
  network?: string;
  verification?: AssetVerificationStatus;
  /** Reason supplied by the API when an asset is blocked. */
  blockedReason?: string;
}

interface TokenStepProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** Assets resolved from the API. Falls back to the built-in list when omitted. */
  assets?: TokenAssetMetadata[];
}

const DEFAULT_TOKENS: TokenAssetMetadata[] = [
  {
    id: "USDC",
    name: "USDC",
    symbol: "USDC",
    description: "USD Coin",
    provenance: "asset-list",
    verification: "verified",
  },
  {
    id: "XLM",
    name: "Stellar Lumens",
    symbol: "XLM",
    description: "Native Stellar token",
    provenance: "asset-list",
    verification: "configured",
  },
  {
    id: "EURC",
    name: "EURC",
    symbol: "EURC",
    description: "Euro Coin",
    provenance: "asset-list",
    verification: "verified",
  },
];

const STATUS_STYLES: Record<AssetVerificationStatus, string> = {
  configured: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  verified: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  deprecated: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  unverified: "bg-slate-500/15 text-slate-300 border-slate-500/40",
  blocked: "bg-red-500/15 text-red-300 border-red-500/40",
};

const STATUS_LABELS: Record<AssetVerificationStatus, string> = {
  configured: "Configured",
  verified: "Verified",
  deprecated: "Deprecated",
  unverified: "Unverified",
  blocked: "Blocked",
};

const isBlocked = (asset: TokenAssetMetadata) =>
  asset.verification === "blocked";

export const TokenStep: React.FC<TokenStepProps> = ({
  value,
  onChange,
  error,
  assets,
}) => {
  const tokens = assets && assets.length > 0 ? assets : DEFAULT_TOKENS;
  const selectedAsset = tokens.find((token) => token.id === value);
  const selectedBlocked = selectedAsset ? isBlocked(selectedAsset) : false;
======= 
  return (
    <div className="space-y-4">
      <div>
        <h3 id="token-group-label" className="text-xl font-semibold mb-2">Select Token</h3>
        <p className="text-sm text-slate-400 mb-4">
          Choose the token you want to stream to the recipient.
        </p>
      </div>

      <div 
        className="grid grid-cols-1 md:grid-cols-3 gap-4"
        role="radiogroup"
        aria-labelledby="token-group-label"
        aria-describedby={error ? "token-error" : undefined}
      >
        {tokens.map((token) => {
          const isSelected = value === token.id;
          const blocked = isBlocked(token);
          const status = token.verification;
          return (
            <button
              key={token.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-disabled={blocked || undefined}
              disabled={blocked}
              tabIndex={isSelected ? 0 : -1}
              data-token-id={token.id}
              data-verification={status ?? "unknown"}
              onKeyDown={(event) => {
                const direction = ["ArrowRight", "ArrowDown"].includes(event.key)
                  ? 1
                  : ["ArrowLeft", "ArrowUp"].includes(event.key)
                    ? -1
                    : event.key === "Home"
                      ? -tokens.length
                      : event.key === "End"
                        ? tokens.length
                        : 0;
                if (!direction) return;
                event.preventDefault();
                const options = Array.from(
                  event.currentTarget.closest('[role="radiogroup"]')?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])') ?? [],
                );
                const currentIndex = options.indexOf(event.currentTarget);
                const nextIndex = direction === tokens.length
                  ? options.length - 1
                  : direction === -tokens.length
                    ? 0
                    : (currentIndex + direction + options.length) % options.length;
                const nextOption = options[nextIndex];
                if (nextOption) {
                  nextOption.focus();
                  onChange(nextOption.dataset.tokenId ?? "");
                }
              }}
              onClick={() => {
                if (blocked) return;
                onChange(token.id);
              }}
              className={`p-4 rounded-lg border-2 transition-all text-left ${
                blocked
                  ? "border-red-500/40 bg-red-500/5 opacity-70 cursor-not-allowed"
                  : isSelected
                    ? "border-accent bg-accent/10 shadow-lg shadow-accent/10"
                    : "border-glass-border bg-glass hover:border-glass-highlight"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-lg">
                  {token.symbol ?? token.id}
                </span>
                {isSelected && !blocked && (
                  <svg
                    className="w-5 h-5 text-accent"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
              <p className="text-sm text-slate-400">
                {token.name ?? "Unknown asset"}
              </p>
              {token.description && (
                <p className="text-xs text-slate-500 mt-1">{token.description}</p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {status ? (
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[status]}`}
                    data-testid={`token-status-${token.id}`}
                  >
                    {STATUS_LABELS[status]}
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center rounded-full border border-slate-500/40 bg-slate-500/15 px-2 py-0.5 text-[11px] font-medium text-slate-300"
                    data-testid={`token-status-${token.id}`}
                  >
                    Unknown
                  </span>
                )}
                {token.provenance && (
                  <span
                    className="inline-flex items-center rounded-full border border-glass-border px-2 py-0.5 text-[11px] text-slate-400"
                    data-testid={`token-provenance-${token.id}`}
                  >
                    Source: {token.provenance}
                  </span>
                )}
              </div>

              <dl className="mt-2 space-y-0.5 text-[11px] text-slate-500">
                <div className="flex gap-1">
                  <dt className="shrink-0">ID:</dt>
                  <dd
                    className="font-mono break-all"
                    data-testid={`token-raw-id-${token.id}`}
                  >
                    {token.id}
                  </dd>
                </div>
                {token.address && (
                  <div className="flex gap-1">
                    <dt className="shrink-0">
                      {token.network ? `${token.network} address:` : "Address:"}
                    </dt>
                    <dd
                      className="font-mono break-all"
                      data-testid={`token-address-${token.id}`}
                    >
                      {token.address}
                    </dd>
                  </div>
                )}
              </dl>

              {blocked && (
                <p
                  className="mt-2 text-xs text-red-300"
                  role="note"
                  data-testid={`token-blocked-reason-${token.id}`}
                >
                  {token.blockedReason ?? "This asset is blocked and cannot be streamed."}
                </p>
              )}
            </button>
          );
        })}
      </div>

      {selectedBlocked && (
        <p
          id="token-blocked-error"
          className="mt-2 text-sm text-red-400"
          role="alert"
        >
          The selected asset is blocked. Choose a different token to continue.
        </p>
      )}

      {error && (
        <p
          id="token-error"
          className="mt-2 text-sm text-red-400 flex items-center gap-1"
          role="alert"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
};
