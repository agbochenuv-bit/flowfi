/**
 * lib/wallet.ts
 *
 * Production wallet adapter for FlowFi.
 * Currently supports Freighter (browser extension).
 *
 * Albedo and xBull are intentionally not advertised until real connectors are
 * implemented. No mock sessions are created in production paths.
 * Set NEXT_PUBLIC_STELLAR_NETWORK=TESTNET|MAINNET in .env to control network.
 */

// ── Network configuration ─────────────────────────────────────────────────────

export const STELLAR_NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ??
  "TESTNET") as "TESTNET" | "MAINNET";

export const STELLAR_NETWORK_ID =
  STELLAR_NETWORK === "MAINNET"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";

import {
  isConnected,
  setAllowed,
  getAddress,
  getNetworkDetails,
} from "@stellar/freighter-api";
import { getApiBaseUrl, fetchWithTimeout } from "@/lib/api/_shared";

export type WalletId = "freighter" | "albedo" | "xbull" | "hana" | "walletconnect";

export interface WalletDescriptor {
  id: WalletId;
  name: string;
  badge: string;
  description: string;
}

export interface WalletSession {
  walletId: WalletId;
  walletName: string;
  publicKey: string;
  connectedAt: string;
  network: string;
  mocked: boolean;
  accessToken?: string;
}

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * Thrown when the user tries to connect Freighter but the extension is not
 * installed. The UI checks for this to show an install prompt instead of a
 * generic error message.
 */
export class FreighterNotInstalledError extends Error {
  constructor() {
    super(
      "Freighter extension is not installed. Please install it from freighter.app.",
    );
    this.name = "FreighterNotInstalledError";
  }
}

// ── Wallet metadata ───────────────────────────────────────────────────────────

export const SUPPORTED_WALLETS: readonly WalletDescriptor[] = [
  { id: "freighter", name: "Freighter", badge: "Extension", description: "Direct browser wallet for Stellar accounts and Soroban apps." },
  { id: "albedo", name: "Albedo", badge: "Web / Mobile", description: "Popup wallet for browser and mobile users." },
  { id: "xbull", name: "xBull", badge: "Extension / Web", description: "Stellar wallet for desktop and web users." },
  { id: "hana", name: "Hana", badge: "Extension", description: "Secure Stellar browser wallet." },
  { id: "walletconnect", name: "WalletConnect", badge: "Mobile", description: "Connect mobile wallets with WalletConnect." },
];

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildSession(
  walletId: WalletId,
  publicKey: string,
  network: string,
): WalletSession {
  const descriptor = SUPPORTED_WALLETS.find((w) => w.id === walletId);

  if (!descriptor) {
    throw new Error("Unsupported wallet selected.");
  }

  return {
    walletId,
    walletName: descriptor.name,
    publicKey,
    connectedAt: new Date().toISOString(),
    network,
    mocked: false,
  };
}

// ── Freighter ─────────────────────────────────────────────────────────────────

async function connectFreighter(): Promise<WalletSession> {
  const connObj = await isConnected();
  if (!connObj.isConnected) {
    throw new FreighterNotInstalledError();
  }

  await setAllowed();

  const { address, error: addressError } = await getAddress();

  if (!address || addressError) {
    throw new Error(
      addressError || "Freighter did not return a valid public key.",
    );
  }

  let networkId = STELLAR_NETWORK_ID.toLowerCase().includes("public")
    ? "Mainnet"
    : "Testnet";

  try {
    const details = await getNetworkDetails();
    if (details.networkPassphrase && !details.error) {
      const raw = String(details.networkPassphrase).toLowerCase();
      if (raw.includes("public") || raw === "mainnet") {
        networkId = "Mainnet";
      } else if (raw.includes("test") || raw.includes("sdf")) {
        networkId = "Testnet";
      } else {
        networkId = "Other";
      }
    }
  } catch {
    // ignore
  }

  return buildSession("freighter", address, networkId);
}

// ── Public connect dispatch ───────────────────────────────────────────────────

export async function connectWallet(
  walletId: WalletId,
): Promise<WalletSession> {
  if (walletId === "freighter") return connectFreighter();

  // These adapters are exposed through their wallet web bridges when installed.
  // Fail clearly rather than creating an unverifiable/mock session.
  const bridge = (window as unknown as Record<string, unknown>)[walletId];
  if (!bridge || typeof bridge !== "object") {
    throw new Error(`${SUPPORTED_WALLETS.find((wallet) => wallet.id === walletId)?.name ?? walletId} is not installed or available.`);
  }
  const api = bridge as { connect?: () => Promise<{ publicKey?: string; address?: string }> };
  if (!api.connect) throw new Error(`${walletId} does not expose a compatible connect API.`);
  const result = await api.connect();
  const publicKey = result.publicKey ?? result.address;
  if (!publicKey) throw new Error(`${walletId} did not return a public key.`);
  return buildSession(walletId, publicKey, STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet");
}

export async function authenticateWallet(
  publicKey: string,
  walletId: WalletId,
): Promise<string> {
  const apiBase = getApiBaseUrl();
  const authBase = `${apiBase}${apiBase.endsWith("/v1") ? "" : "/v1"}/auth`;
  const challengeResponse = await fetchWithTimeout(`${authBase}/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  if (!challengeResponse.ok) {
    throw new Error(`Wallet authentication challenge failed (${challengeResponse.status})`);
  }
  const { nonce } = await challengeResponse.json() as { nonce: string };

  const { Account, BASE_FEE, Networks, Operation, TransactionBuilder } =
    await import("@stellar/stellar-sdk");
  const networkPassphrase = STELLAR_NETWORK === "MAINNET" ? Networks.PUBLIC : Networks.TESTNET;
  const nonceBytes = new Uint8Array(nonce.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
  const transaction = new TransactionBuilder(new Account(publicKey, "0"), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.manageData({ name: "flowfi-auth", value: nonceBytes }))
    .setTimeout(60)
    .build();

  type SignedTransaction = { signedTxXdr?: string; error?: unknown };
  type SignTransaction = (xdr: string, options: { networkPassphrase: string }) => Promise<SignedTransaction>;
  let sign: SignTransaction;
  if (walletId === "freighter") {
    sign = (await import("@stellar/freighter-api")).signTransaction as SignTransaction;
  } else {
    const bridge = (window as unknown as Record<string, { signTransaction?: SignTransaction }>)[walletId];
    if (!bridge?.signTransaction) throw new Error("This wallet does not support signed API authentication.");
    sign = bridge.signTransaction.bind(bridge);
  }

  const signed = await sign(transaction.toXDR(), { networkPassphrase });
  if (signed.error || !signed.signedTxXdr) {
    throw new Error("Wallet authentication signature was declined or unavailable.");
  }
  const verifyResponse = await fetchWithTimeout(`${authBase}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey, signedTransaction: signed.signedTxXdr }),
  });
  if (!verifyResponse.ok) {
    throw new Error(`Wallet authentication failed (${verifyResponse.status})`);
  }
  const result = await verifyResponse.json() as { token: string };
  if (!result.token) throw new Error("Wallet authentication response did not include a token.");
  return result.token;
}

// ── Error message mapping ─────────────────────────────────────────────────────

const USER_REJECTION_PATTERNS = [
  /rejected/i,
  /declined/i,
  /denied/i,
  /canceled/i,
  /cancelled/i,
  /closed/i,
  /user.*denied/i,
  /user.*abort/i,
  /popup.*closed/i,
  /window.*closed/i,
];

export function toWalletErrorMessage(error: unknown): string {
  // Provide a specialised message for the extension-not-installed case.
  if (error instanceof FreighterNotInstalledError) {
    return error.message;
  }

  const baseMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Wallet connection failed. Please try again.";

  if (USER_REJECTION_PATTERNS.some((pattern) => pattern.test(baseMessage))) {
    return "You rejected the connection request. Try again when ready.";
  }

  return baseMessage;
}

// ── Display helpers ───────────────────────────────────────────────────────────

export function shortenPublicKey(publicKey: string): string {
  if (publicKey.length <= 14) {
    return publicKey;
  }

  return `${publicKey.slice(0, 7)}...${publicKey.slice(-7)}`;
}

/**
 * Maps raw Stellar network strings (passphrases, env-style IDs, legacy labels)
 * to friendly display labels: "Mainnet" | "Testnet" | original string.
 */
export function formatNetwork(network: string): string {
  const n = network.trim().toLowerCase();

  if (n.includes("public") || n === "mainnet" || n === "public") {
    return "Mainnet";
  }

  if (
    n.includes("test") ||
    n === "testnet" ||
    n.includes("sdf") ||
    n === "stellar testnet"
  ) {
    return "Testnet";
  }

  return network;
}

/**
 * Returns true if the connected wallet's network matches what this app is
 * configured to use (NEXT_PUBLIC_STELLAR_NETWORK).
 */
export function isExpectedNetwork(sessionNetwork: string): boolean {
  const sessionLabel = formatNetwork(sessionNetwork);
  const expectedLabel = STELLAR_NETWORK === "MAINNET" ? "Mainnet" : "Testnet";
  return sessionLabel === expectedLabel;
}
