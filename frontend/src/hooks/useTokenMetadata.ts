"use client";

import { useQuery } from "@tanstack/react-query";
import { getApiBaseUrl } from "@/lib/api/_shared";

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string;
  verified: boolean;
}

const TOKEN_METADATA_QUERY_KEY = ["token-metadata"] as const;

async function fetchTokenMetadata(): Promise<TokenMetadata[]> {
  const response = await fetch(`${getApiBaseUrl()}/v1/tokens`);
  if (!response.ok) throw new Error(`Failed to fetch token metadata (${response.status})`);
  const payload = (await response.json()) as { tokens?: TokenMetadata[] };
  return Array.isArray(payload.tokens) ? payload.tokens : [];
}

export function useTokenMetadata() {
  return useQuery({
    queryKey: TOKEN_METADATA_QUERY_KEY,
    queryFn: fetchTokenMetadata,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}

export function getTokenDecimals(symbol: string, tokens: TokenMetadata[] = []): number {
  return tokens.find((entry) => entry.symbol.toUpperCase() === symbol.toUpperCase())?.decimals ?? 7;
}
