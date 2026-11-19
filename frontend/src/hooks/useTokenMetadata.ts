"use client";

import { useQuery } from "@tanstack/react-query";
import { getApiBaseUrl } from "@/lib/api/_shared";

/**
 * Trust level describing how much confidence clients may place in a piece of
 * token metadata.
 *
 * - `verified`: metadata confirmed against an authoritative source (e.g. the
 *   token issuer or a curated registry). Safe to display as canonical.
 * - `onchain`: metadata read directly from the token contract. Trustworthy
 *   but not independently verified.
 * - `hint`: best-effort / user-supplied metadata. Display only as a hint and
 *   never use for accounting decisions.
 * - `unknown`: no trustworthy source available; clients must fall back to
 *   defaults (symbol = contract address, decimals = network default).
 */
export type TokenMetadataTrustLevel = "verified" | "onchain" | "hint" | "unknown";

export interface TokenMetadataProvenance {
  /** Trust level of the metadata as reported by the API. */
  trustLevel: TokenMetadataTrustLevel;
  /** Human-readable source identifier (e.g. "registry", "contract", "user"). */
  source?: string;
  /** ISO-8601 timestamp of when the metadata was last observed/updated. */
  updatedAt?: string;
  /** ISO-8601 timestamp after which the metadata should be considered stale. */
  staleAt?: string;
}

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string;
  verified: boolean;
  /** Provenance of the metadata. Optional for backwards compatibility. */
  provenance?: TokenMetadataProvenance;
  /** Whether the API flagged this entry as stale at response time. */
  stale?: boolean;
}

/** Default decimals used when no trustworthy metadata is available. */
export const DEFAULT_TOKEN_DECIMALS = 7;

/** Default staleness window applied when the API does not provide `staleAt`. */
export const DEFAULT_TOKEN_METADATA_STALE_MS = 60 * 60 * 1000;

const TOKEN_METADATA_QUERY_KEY = ["token-metadata"] as const;

const TRUST_LEVELS: readonly TokenMetadataTrustLevel[] = ["verified", "onchain", "hint", "unknown"];

function normalizeTrustLevel(value: unknown, verified: boolean): TokenMetadataTrustLevel {
  if (typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value)) {
    return value as TokenMetadataTrustLevel;
  }
  // Fallback: derive from the legacy `verified` flag.
  return verified ? "verified" : "unknown";
}

function normalizeToken(raw: unknown): TokenMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const contractAddress = typeof entry.contractAddress === "string" ? entry.contractAddress : "";
  if (!contractAddress) return null;

  const verified = entry.verified === true;
  const provenanceRaw =
    entry.provenance && typeof entry.provenance === "object"
      ? (entry.provenance as Record<string, unknown>)
      : undefined;

  const trustLevel = normalizeTrustLevel(provenanceRaw?.trustLevel, verified);
  const decimals =
    typeof entry.decimals === "number" && Number.isFinite(entry.decimals) && entry.decimals >= 0
      ? Math.trunc(entry.decimals)
      : DEFAULT_TOKEN_DECIMALS;

  const provenance: TokenMetadataProvenance = {
    trustLevel,
    source: typeof provenanceRaw?.source === "string" ? provenanceRaw.source : undefined,
    updatedAt: typeof provenanceRaw?.updatedAt === "string" ? provenanceRaw.updatedAt : undefined,
    staleAt: typeof provenanceRaw?.staleAt === "string" ? provenanceRaw.staleAt : undefined,
  };

  return {
    symbol: typeof entry.symbol === "string" && entry.symbol ? entry.symbol : contractAddress,
    name: typeof entry.name === "string" && entry.name ? entry.name : contractAddress,
    decimals,
    contractAddress,
    verified,
    provenance,
    stale: entry.stale === true,
  };
}

async function fetchTokenMetadata(): Promise<TokenMetadata[]> {
  const response = await fetch(`${getApiBaseUrl()}/v1/tokens`);
  if (!response.ok) throw new Error(`Failed to fetch token metadata (${response.status})`);
  const payload = (await response.json()) as { tokens?: unknown };
  if (!Array.isArray(payload.tokens)) return [];
  return payload.tokens
    .map(normalizeToken)
    .filter((entry): entry is TokenMetadata => entry !== null);
}

/**
 * Returns true when the metadata entry should be treated as stale, either
 * because the API flagged it or because its `staleAt` timestamp has passed.
 */
export function isTokenMetadataStale(
  token: TokenMetadata,
  now: number = Date.now(),
): boolean {
  if (token.stale === true) return true;
  const staleAt = token.provenance?.staleAt;
  if (!staleAt) return false;
  const parsed = Date.parse(staleAt);
  if (Number.isNaN(parsed)) return true; // malformed timestamp -> treat as stale
  return parsed <= now;
}

/**
 * Returns true when the metadata may be used for display as canonical data.
 * Stale or untrusted entries are treated as hints only.
 */
export function isTokenMetadataTrusted(
  token: TokenMetadata,
  now: number = Date.now(),
): boolean {
  const trustLevel = token.provenance?.trustLevel ?? (token.verified ? "verified" : "unknown");
  if (trustLevel !== "verified" && trustLevel !== "onchain") return false;
  return !isTokenMetadataStale(token, now);
}

export function useTokenMetadata() {
  return useQuery({
    queryKey: TOKEN_METADATA_QUERY_KEY,
    queryFn: fetchTokenMetadata,
    staleTime: DEFAULT_TOKEN_METADATA_STALE_MS,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}

/**
 * Resolves the decimals for a symbol. Falls back to the network default when
 * the token is unknown, metadata is unavailable, or the entry is untrusted.
 * Raw on-chain amounts are never altered by this helper.
 */
export function getTokenDecimals(symbol: string, tokens: TokenMetadata[] = []): number {
  const match = tokens.find((entry) => entry.symbol.toUpperCase() === symbol.toUpperCase());
  if (!match) return DEFAULT_TOKEN_DECIMALS;
  if (!isTokenMetadataTrusted(match)) return DEFAULT_TOKEN_DECIMALS;
  return match.decimals;
}

/**
 * Resolves the display metadata for a symbol, including provenance and
 * staleness so the UI can distinguish verified data from hints.
 */
export function getTokenMetadata(
  symbol: string,
  tokens: TokenMetadata[] = [],
): TokenMetadata | undefined {
  return tokens.find((entry) => entry.symbol.toUpperCase() === symbol.toUpperCase());
}