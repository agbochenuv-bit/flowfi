"use client";

import { useQuery } from "@tanstack/react-query";
import { getApiBaseUrl } from "@/lib/api/_shared";

export type AssetRiskStatus =
  | "configured"
  | "verified"
  | "deprecated"
  | "unverified"
  | "blocked";

export interface TokenProvenance {
  /** Where the metadata originated, e.g. "admin", "on-chain", "community". */
  source?: string;
  /** Optional free-form reference (URL, registry id, tx hash, etc.). */
  reference?: string | null;
  /** ISO timestamp of when the metadata was last confirmed, if known. */
  updatedAt?: string | null;
}

export interface TokenNetworkAddress {
  /** Stellar network identifier, e.g. "mainnet", "testnet", "futurenet". */
  network: string;
  /** Contract address on that specific network. */
  contractAddress: string;
}

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string;
  verified: boolean;
  /** Optional risk/verification status supplied by the API. */
  status?: AssetRiskStatus | string | null;
  /** Optional flag indicating the asset has been deprecated. */
  deprecated?: boolean | null;
  /** Optional flag indicating the asset is blocked from use. */
  blocked?: boolean | null;
  /** Optional provenance information for the metadata. */
  provenance?: TokenProvenance | null;
  /** Optional per-network contract addresses. */
  networkAddresses?: TokenNetworkAddress[] | null;
}

export interface AssetRiskClassification {
  status: AssetRiskStatus;
  /** Raw identifiers preserved so callers can display them verbatim. */
  symbol: string;
  contractAddress: string;
  network?: string;
  /** Human-readable explanation of why the status was assigned. */
  reason: string;
}

const TOKEN_METADATA_QUERY_KEY = ["token-metadata"] as const;

async function fetchTokenMetadata(network?: string): Promise<TokenMetadata[]> {
  const base = `${getApiBaseUrl()}/v1/tokens`;
  const url = network ? `${base}?network=${encodeURIComponent(network)}` : base;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch token metadata (${response.status})`);
  const payload = (await response.json()) as { tokens?: TokenMetadata[] };
  return Array.isArray(payload.tokens) ? payload.tokens : [];
}

export function useTokenMetadata(network?: string) {
  return useQuery({
    queryKey: [...TOKEN_METADATA_QUERY_KEY, network ?? "default"],
    queryFn: () => fetchTokenMetadata(network),
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}

export function getTokenDecimals(symbol: string, tokens: TokenMetadata[] = []): number {
  return tokens.find((entry) => entry.symbol.toUpperCase() === symbol.toUpperCase())?.decimals ?? 7;
}

/**
 * Resolve the contract address for a token on a specific network, falling back
 * to the top-level contract address when no network-specific entry exists.
 */
export function getTokenContractAddress(
  token: TokenMetadata,
  network?: string,
): string {
  if (network && Array.isArray(token.networkAddresses)) {
    const match = token.networkAddresses.find(
      (entry) => entry.network.toLowerCase() === network.toLowerCase(),
    );
    if (match) return match.contractAddress;
  }
  return token.contractAddress;
}

/**
 * Classify an asset's risk status. Precedence: blocked > deprecated > verified >
 * configured > unverified. Raw identifiers are always preserved in the result so
 * callers can display them even when metadata is unknown or the asset is blocked.
 */
export function classifyAssetRisk(
  token: TokenMetadata,
  network?: string,
): AssetRiskClassification {
  const contractAddress = getTokenContractAddress(token, network);
  const base = {
    symbol: token.symbol,
    contractAddress,
    network,
  };

  const rawStatus = typeof token.status === "string" ? token.status.toLowerCase() : null;

  if (token.blocked === true || rawStatus === "blocked") {
    return {
      ...base,
      status: "blocked",
      reason: "Asset is blocked and cannot be used to create or fund streams.",
    };
  }

  if (token.deprecated === true || rawStatus === "deprecated") {
    return {
      ...base,
      status: "deprecated",
      reason: "Asset is deprecated; prefer a supported replacement.",
    };
  }

  if (token.verified === true || rawStatus === "verified") {
    return {
      ...base,
      status: "verified",
      reason: "Asset metadata has been verified.",
    };
  }

  if (rawStatus === "configured") {
    return {
      ...base,
      status: "configured",
      reason: "Asset is configured by the operator but not independently verified.",
    };
  }

  return {
    ...base,
    status: "unverified",
    reason: "Asset metadata is unknown or unverified; confirm the contract address before use.",
  };
}