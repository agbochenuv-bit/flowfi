"use client";

/**
 * WalletContext — persistent wallet session management for FlowFi.
 *
 * Three network concepts flow through this context:
 *
 *  APP NETWORK          The network selected in NetworkSelector, stored in
 *                       localStorage as "flowfi.network". Read via useNetwork().
 *
 *  WALLET NETWORK       The network Freighter is currently connected to.
 *                       Reported in session.network after connect().
 *
 *  CONTRACT DEPLOYMENT  Determined by NEXT_PUBLIC_STREAM_CONTRACT_ID and the
 *  NETWORK              APP NETWORK. Read from NetworkConfig.contractId.
 *
 * Before any sign/submit operation callers MUST call assertWalletOnAppNetwork()
 * (or check isWalletOnAppNetwork()) to confirm WALLET NETWORK matches APP
 * NETWORK. Do not use the legacy isExpectedNetwork() helper — it compares
 * against the hardcoded env var, not the user's dynamic network choice.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import {
  connectWallet,
  toWalletErrorMessage,
  authenticateWallet,
  isWalletOnNetwork,
  type WalletSession,
  SUPPORTED_WALLETS,
  type WalletDefinition,
} from "@/lib/wallet";
import { useNetwork } from "@/context/NetworkContext";
import type { NetworkConfig } from "@/lib/stellar-config";

// ── Storage keys ──────────────────────────────────────────────────────────────

const SESSION_KEY = "flowfi.wallet.session.v1";
const AUTH_KEY = "flowfi.wallet.auth.v1";

// ── State machine ─────────────────────────────────────────────────────────────

export type WalletStatus = "idle" | "connecting" | "connected" | "error";

interface WalletState {
  status: WalletStatus;
  session: WalletSession | null;
  authToken: string | null;
  errorMessage: string | null;
  isHydrated: boolean;
}

type WalletAction =
  | { type: "hydrate:success"; session: WalletSession; authToken: string | null }
  | { type: "hydrate:idle" }
  | { type: "connect:start" }
  | { type: "connect:success"; session: WalletSession; authToken: string }
  | { type: "connect:error"; message: string }
  | { type: "disconnect" };

function reducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "hydrate:success":
      return {
        ...state,
        status: "connected",
        session: action.session,
        authToken: action.authToken,
        isHydrated: true,
      };
    case "hydrate:idle":
      return { ...state, status: "idle", isHydrated: true };
    case "connect:start":
      return { ...state, status: "connecting", errorMessage: null };
    case "connect:success":
      return {
        ...state,
        status: "connected",
        session: action.session,
        authToken: action.authToken,
        errorMessage: null,
      };
    case "connect:error":
      return {
        ...state,
        status: "error",
        session: null,
        authToken: null,
        errorMessage: action.message,
      };
    case "disconnect":
      return {
        ...state,
        status: "idle",
        session: null,
        authToken: null,
        errorMessage: null,
      };
    default:
      return state;
  }
}

const initialState: WalletState = {
  status: "idle",
  session: null,
  authToken: null,
  errorMessage: null,
  isHydrated: false,
};

// ── Auth token helpers ────────────────────────────────────────────────────────

/** Decode the `exp` claim from a JWT without a full JWT library. */
function getTokenExpiry(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function isTokenValid(token: string): boolean {
  const exp = getTokenExpiry(token);
  if (exp === null) return false;
  // Treat tokens expiring in less than 60 s as expired.
  return exp > Math.floor(Date.now() / 1000) + 60;
}

// ── Session validation ────────────────────────────────────────────────────────

function isValidSession(value: unknown): value is WalletSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s["walletId"] === "string" &&
    typeof s["walletName"] === "string" &&
    typeof s["publicKey"] === "string" &&
    typeof s["connectedAt"] === "string" &&
    typeof s["network"] === "string" &&
    s["mocked"] === false // never restore mocked sessions
  );
}

// ── Context value ─────────────────────────────────────────────────────────────

export interface WalletContextValue {
  /** Current wallet connection state. */
  status: WalletStatus;
  /** Active session, or null when not connected. */
  session: WalletSession | null;
  /** JWT auth token for backend calls, or null when not authenticated. */
  authToken: string | null;
  /** Last connection error message, or null. */
  errorMessage: string | null;
  /** True once the initial localStorage hydration is complete. */
  isHydrated: boolean;
  /** Supported wallet definitions. */
  supportedWallets: WalletDefinition[];
  /**
   * Connect a wallet by ID (e.g. "freighter").
   * Calls connectWallet() → authenticateWallet() and persists the session.
   */
  connect: (walletId: string) => Promise<void>;
  /**
   * Disconnect: clears session, authToken, and localStorage entries.
   */
  disconnect: () => void;
  /**
   * Returns true when session.network matches the current APP NETWORK
   * (i.e. the network the user chose in NetworkSelector).
   *
   * Always false when not connected.
   */
  isWalletOnAppNetwork: () => boolean;
  /**
   * Throws a user-friendly Error when the wallet is not on the APP NETWORK.
   * Call this at the top of any sign/submit handler.
   */
  assertWalletOnAppNetwork: (appNetwork: NetworkConfig) => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { network: appNetwork } = useNetwork();

  // Hydrate from localStorage on first render.
  useEffect(() => {
    try {
      const rawSession = localStorage.getItem(SESSION_KEY);
      if (!rawSession) {
        dispatch({ type: "hydrate:idle" });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawSession);
      } catch {
        // Malformed JSON — discard silently.
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(AUTH_KEY);
        dispatch({ type: "hydrate:idle" });
        return;
      }

      if (!isValidSession(parsed)) {
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(AUTH_KEY);
        dispatch({ type: "hydrate:idle" });
        return;
      }

      // Restore auth token if present and still valid.
      let authToken: string | null = null;
      try {
        const rawAuth = localStorage.getItem(AUTH_KEY);
        if (rawAuth) {
          const auth = JSON.parse(rawAuth) as { publicKey?: string; token?: string };
          if (
            auth.publicKey === parsed.publicKey &&
            typeof auth.token === "string" &&
            isTokenValid(auth.token)
          ) {
            authToken = auth.token;
          }
        }
      } catch {
        // Malformed auth entry — ignore, proceed without token.
        localStorage.removeItem(AUTH_KEY);
      }

      dispatch({ type: "hydrate:success", session: parsed, authToken });
    } catch {
      dispatch({ type: "hydrate:idle" });
    }
  }, []);

  const connect = useCallback(async (walletId: string) => {
    dispatch({ type: "connect:start" });
    try {
      const session = await connectWallet(walletId);
      const token = await authenticateWallet(session.publicKey, walletId);

      // Persist session and auth token.
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.setItem(AUTH_KEY, JSON.stringify({ publicKey: session.publicKey, token }));

      dispatch({ type: "connect:success", session, authToken: token });
    } catch (err) {
      // Clear any stale persisted session on failure.
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(AUTH_KEY);
      dispatch({ type: "connect:error", message: toWalletErrorMessage(err) });
    }
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(AUTH_KEY);
    dispatch({ type: "disconnect" });
  }, []);

  /**
   * Returns true when the connected wallet's network matches the APP NETWORK.
   * Uses isWalletOnNetwork() which compares by passphrase first, display name
   * second — covers both the short name ("Testnet") and the full passphrase
   * ("Test SDF Network ; September 2015") that Freighter may return.
   */
  const isWalletOnAppNetwork = useCallback((): boolean => {
    if (!state.session) return false;
    return isWalletOnNetwork(state.session.network, appNetwork);
  }, [state.session, appNetwork]);

  const assertWalletOnAppNetwork = useCallback(
    (currentAppNetwork: NetworkConfig) => {
      if (!state.session) {
        throw new Error("No wallet connected. Please connect your wallet first.");
      }
      if (!isWalletOnNetwork(state.session.network, currentAppNetwork)) {
        throw new Error(
          `Your wallet is connected to ${state.session.network} but the app is set to ` +
            `${currentAppNetwork.name}. Switch your Freighter network to ` +
            `${currentAppNetwork.name} before signing.`,
        );
      }
    },
    [state.session],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      status: state.status,
      session: state.session,
      authToken: state.authToken,
      errorMessage: state.errorMessage,
      isHydrated: state.isHydrated,
      supportedWallets: SUPPORTED_WALLETS,
      connect,
      disconnect,
      isWalletOnAppNetwork,
      assertWalletOnAppNetwork,
    }),
    [
      state.status,
      state.session,
      state.authToken,
      state.errorMessage,
      state.isHydrated,
      connect,
      disconnect,
      isWalletOnAppNetwork,
      assertWalletOnAppNetwork,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Access the wallet context.
 * Must be used inside a <WalletProvider> tree.
 */
export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within WalletProvider.");
  }
  return ctx;
}
