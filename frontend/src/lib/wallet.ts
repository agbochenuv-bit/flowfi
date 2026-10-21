/**
 * wallet.ts — Wallet utilities for FlowFi.
 *
 * Network terminology used throughout this module:
 *  - APP NETWORK:    The network the user selected in NetworkSelector, stored in
 *                    localStorage as "flowfi.network" and available via useNetwork().
 *  - WALLET NETWORK: The network Freighter is currently connected to, exposed as
 *                    session.network from wallet-context.
 *  - CONTRACT DEPLOYMENT NETWORK: Determined by NEXT_PUBLIC_STREAM_CONTRACT_ID
 *                    and the app's selected network (APP NETWORK).
 *
 * isExpectedNetwork() compares WALLET NETWORK against the hardcoded env-var
 * (CONTRACT DEPLOYMENT NETWORK). Use isWalletOnNetwork() when you want to
 * compare against the dynamically chosen APP NETWORK instead.
 */

import type { NetworkConfig } from "@/lib/stellar-config";

// ── Environment-based network constants (CONTRACT DEPLOYMENT NETWORK) ───────

/** Env-var network name, e.g. "TESTNET" or "MAINNET". Defaults to "TESTNET". */
export const STELLAR_NETWORK: string =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET";

/** Network passphrase corresponding to STELLAR_NETWORK. */
export const STELLAR_NETWORK_ID: string =
  STELLAR_NETWORK === "MAINNET"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

// ── WalletSession ────────────────────────────────────────────────────────────

/** Shape of a persisted wallet session stored in localStorage. */
export interface WalletSession {
  walletId: string;
  walletName: string;
  publicKey: string;
  connectedAt: string;
  /** Human-readable network name or passphrase reported by the wallet. */
  network: string;
  /** True only for synthetic/mock sessions used in testing. */
  mocked: boolean;
}

// ── Supported wallet definitions ─────────────────────────────────────────────

export interface WalletDefinition {
  id: string;
  name: string;
  badge: string;
  description: string;
  installUrl?: string;
}

export const SUPPORTED_WALLETS: WalletDefinition[] = [
  {
    id: "freighter",
    name: "Freighter",
    badge: "Extension",
    description: "Direct browser wallet for Stellar",
    installUrl: "https://freighter.app",
  },
];

// ── Custom errors ─────────────────────────────────────────────────────────────

export class FreighterNotInstalledError extends Error {
  constructor() {
    super(
      "Freighter wallet extension is not installed. Visit https://freighter.app to install it.",
    );
    this.name = "FreighterNotInstalledError";
  }
}

// ── Network helpers ──────────────────────────────────────────────────────────

/**
 * Maps a raw network string (passphrase or short name returned by Freighter)
 * to a human-readable display name.
 */
export function formatNetwork(network: string): string {
  const n = network.toLowerCase();
  if (n.includes("public global") || n === "mainnet") return "Mainnet";
  if (
    n.includes("test sdf network") ||
    n === "testnet" ||
    n.includes("testnet")
  )
    return "Testnet";
  if (n.includes("future") || n === "futurenet") return "Futurenet";
  if (n.includes("standalone") || n === "sandbox" || n.includes("sandbox"))
    return "Local Sandbox";
  return network;
}

/**
 * Returns true if the given wallet network string matches the app's
 * CONTRACT DEPLOYMENT NETWORK (read from NEXT_PUBLIC_STELLAR_NETWORK env var).
 *
 * @deprecated Prefer isWalletOnNetwork() which accepts a NetworkConfig so the
 * check is made against the user's dynamically selected APP NETWORK instead of
 * the hardcoded env var.
 */
export function isExpectedNetwork(walletNetwork: string): boolean {
  const formatted = formatNetwork(walletNetwork);
  const expected = formatNetwork(STELLAR_NETWORK);
  return formatted.toLowerCase() === expected.toLowerCase();
}

/**
 * Returns true if the given wallet network matches the provided NetworkConfig.
 *
 * This should be preferred over isExpectedNetwork() when you have access to
 * the app-selected NetworkConfig from useNetwork(), because it compares against
 * the APP NETWORK (user's choice) rather than the hardcoded env var.
 *
 * Comparison is done by network passphrase first (most reliable), then falls
 * back to display name matching.
 *
 * @param walletNetwork - The network string reported by Freighter (session.network).
 * @param networkConfig - The NetworkConfig from useNetwork().
 */
export function isWalletOnNetwork(
  walletNetwork: string,
  networkConfig: NetworkConfig,
): boolean {
  // Primary: compare by passphrase (exact match)
  if (
    walletNetwork === networkConfig.passphrase ||
    walletNetwork.toLowerCase() === networkConfig.passphrase.toLowerCase()
  ) {
    return true;
  }

  // Secondary: compare display names (normalized)
  const formattedWallet = formatNetwork(walletNetwork).toLowerCase();
  const formattedConfig = networkConfig.name.toLowerCase();
  return formattedWallet === formattedConfig;
}

// ── Key display helpers ───────────────────────────────────────────────────────

/**
 * Returns a shortened Stellar public key, e.g. "GAAAAA...ZZZZZZ".
 * If the key is 14 characters or fewer it is returned unchanged.
 */
export function shortenPublicKey(publicKey: string, prefixLen = 7, suffixLen = 7): string {
  if (publicKey.length <= prefixLen + suffixLen) return publicKey;
  return `${publicKey.slice(0, prefixLen)}...${publicKey.slice(-suffixLen)}`;
}

// ── Error message helpers ─────────────────────────────────────────────────────

const REJECTION_PATTERN = /reject|cancel|denied|declined|closed|window closed/i;

/**
 * Converts a wallet connection error (any shape) into a user-friendly string.
 */
export function toWalletErrorMessage(error: unknown): string {
  if (error instanceof FreighterNotInstalledError) return error.message;

  if (error instanceof Error) {
    if (REJECTION_PATTERN.test(error.message)) {
      return "You rejected the connection request. Try again when ready.";
    }
    return error.message;
  }

  if (typeof error === "string") {
    if (REJECTION_PATTERN.test(error)) {
      return "You rejected the connection request. Try again when ready.";
    }
    return error;
  }

  return "Wallet connection failed. Please try again.";
}

// ── Freighter connect / authenticate helpers ──────────────────────────────────

/**
 * Connects to the specified wallet and returns a WalletSession.
 * Currently only "freighter" is supported.
 */
export async function connectWallet(walletId: string): Promise<WalletSession> {
  if (walletId !== "freighter") {
    throw new Error(`Unsupported wallet: ${walletId}`);
  }

  const freighter = await import("@stellar/freighter-api");

  // Check if Freighter is installed
  const isConnected =
    typeof (freighter as { isConnected?: () => Promise<{ isConnected: boolean }> }).isConnected ===
    "function"
      ? await (freighter as { isConnected: () => Promise<{ isConnected: boolean }> }).isConnected()
      : { isConnected: typeof window !== "undefined" && ("freighter" in window || "stellar" in window) };

  if (
    !(
      (typeof isConnected === "object" && isConnected !== null && "isConnected" in isConnected)
        ? (isConnected as { isConnected: boolean }).isConnected
        : isConnected
    )
  ) {
    throw new FreighterNotInstalledError();
  }

  const result = await freighter.getAddress();
  if ("error" in result && result.error) {
    throw new Error(String(result.error));
  }

  const publicKey = (result as { address: string }).address;

  const networkResult = await freighter.getNetwork();
  const network =
    "network" in networkResult
      ? (networkResult as { network: string }).network
      : "Testnet";

  return {
    walletId: "freighter",
    walletName: "Freighter",
    publicKey,
    connectedAt: new Date().toISOString(),
    network,
    mocked: false,
  };
}

/**
 * Fetches the currently connected wallet address from Freighter.
 * Throws if Freighter is not installed or no account is connected.
 */
export async function getConnectedWalletAddress(): Promise<string> {
  const freighter = await import("@stellar/freighter-api");
  const result = await freighter.getAddress();
  if ("error" in result && result.error) {
    throw new Error(String(result.error));
  }
  return (result as { address: string }).address;
}

/**
 * Authenticates the wallet by obtaining a JWT from the backend.
 * Returns the raw JWT string.
 *
 * NOTE: This is a placeholder implementation. Replace with a proper
 * challenge/response flow (e.g. SEP-10) when the backend auth endpoint
 * is finalized.
 */
export async function authenticateWallet(
  publicKey: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _walletId: string,
): Promise<string> {
  // Encode a minimal JWT with a far-future expiry for local/test use.
  // In production this should call the backend challenge endpoint and
  // have the user sign the challenge transaction.
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const payload = btoa(
    JSON.stringify({
      sub: publicKey,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${header}.${payload}.placeholder`;
}
