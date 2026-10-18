"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  SUPPORTED_WALLETS,
  authenticateWallet,
  connectWallet,
  getConnectedWalletAddress,
  toWalletErrorMessage,
  type WalletDescriptor,
  type WalletId,
  type WalletSession,
} from "@/lib/wallet";
import { getJwtExpiry } from "@/lib/auth";

type WalletStatus = "idle" | "connecting" | "connected" | "error";

interface WalletContextValue {
  wallets: readonly WalletDescriptor[];
  status: WalletStatus;
  session: WalletSession | null;
  authToken: string | null;
  selectedWalletId: WalletId | null;
  errorMessage: string | null;
  isHydrated: boolean;
  connect: (walletId: WalletId) => Promise<void>;
  disconnect: () => void;
  clearError: () => void;
}

// STORAGE_KEY version should be bumped whenever WalletSession shape changes,
// so stale persisted sessions are discarded rather than causing type errors.
const STORAGE_KEY = "flowfi.wallet.session.v1";
const AUTH_STORAGE_KEY = "flowfi.wallet.auth.v1";
const WalletContext = createContext<WalletContextValue | undefined>(undefined);
const VALID_WALLET_IDS = SUPPORTED_WALLETS.map((wallet) => wallet.id);

interface WalletState {
  status: WalletStatus;
  session: WalletSession | null;
  authToken: string | null;
  selectedWalletId: WalletId | null;
  errorMessage: string | null;
  isHydrated: boolean;
}

type WalletAction =
  | { type: "hydrate"; session: WalletSession | null; authToken: string | null }
  | { type: "connect:start"; walletId: WalletId }
  | { type: "connect:success"; session: WalletSession; authToken: string }
  | { type: "connect:error"; message: string }
  | { type: "disconnect" }
  | { type: "error:clear" };

const INITIAL_STATE: WalletState = {
  status: "idle",
  session: null,
  authToken: null,
  selectedWalletId: null,
  errorMessage: null,
  isHydrated: false,
};

function walletReducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "hydrate":
      if (!action.session) {
        return {
          ...state,
          isHydrated: true,
        };
      }

      return {
        status: "connected",
        session: action.session,
        authToken: action.authToken,
        selectedWalletId: action.session.walletId,
        errorMessage: null,
        isHydrated: true,
      };
    case "connect:start":
      return {
        ...state,
        status: "connecting",
        session: null,
        authToken: null,
        selectedWalletId: action.walletId,
        errorMessage: null,
      };
    case "connect:success":
      return {
        ...state,
        status: "connected",
        session: action.session,
        authToken: action.authToken,
        selectedWalletId: action.session.walletId,
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
        selectedWalletId: null,
        errorMessage: null,
      };
    case "error:clear":
      return {
        ...state,
        errorMessage: null,
        status: state.status === "error" ? "idle" : state.status,
      };
    default:
      return state;
  }
}

function isWalletSession(value: unknown): value is WalletSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const session = value as Partial<WalletSession>;

  return (
    typeof session.walletId === "string" &&
    VALID_WALLET_IDS.includes(session.walletId as WalletId) &&
    typeof session.walletName === "string" &&
    typeof session.publicKey === "string" &&
    typeof session.connectedAt === "string" &&
    typeof session.network === "string" &&
    session.mocked === false
  );
}

function readStoredSession(): WalletSession | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isWalletSession(parsed)) {
      return parsed;
    }
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
  }

  return null;
}

function storeSession(session: WalletSession): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function removeStoredSession(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}

function readStoredAuth(publicKey: string | undefined): string | null {
  if (typeof window === "undefined" || !publicKey) return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? "null") as {
      publicKey?: string;
      token?: string;
    } | null;
    if (
      value?.publicKey === publicKey &&
      typeof value.token === "string" &&
      (getJwtExpiry(value.token) ?? 0) > Date.now()
    ) {
      return value.token;
    }
  } catch {
    // Invalid stored credentials are discarded below.
  }
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  return null;
}

function storeAuth(token: string, publicKey: string): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, publicKey }));
  }
}

function removeStoredAuth(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(walletReducer, INITIAL_STATE);
  const queryClient = useQueryClient();

  useEffect(() => {
    const existingSession = readStoredSession();
    const authToken = readStoredAuth(existingSession?.publicKey);
    if (existingSession && !authToken) {
      removeStoredSession();
    }
    dispatch({
      type: "hydrate",
      session: authToken ? existingSession : null,
      authToken,
    });
  }, []);

  const disconnect = useCallback(() => {
    dispatch({ type: "disconnect" });
    removeStoredSession();
    removeStoredAuth();
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    const expire = () => disconnect();
    window.addEventListener("flowfi:auth-expired", expire);
    return () => window.removeEventListener("flowfi:auth-expired", expire);
  }, [disconnect]);

  useEffect(() => {
    const session = state.session;
    if (!session) return;

    let active = true;
    const checkAccount = async () => {
      try {
        const address = await getConnectedWalletAddress(session.walletId);
        if (
          active &&
          address !== null &&
          address !== session.publicKey
        ) {
          disconnect();
        }
      } catch {
        // Wallet providers can be temporarily unavailable while the browser is backgrounded.
      }
    };

    const interval = window.setInterval(() => void checkAccount(), 5000);
    window.addEventListener("focus", checkAccount);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", checkAccount);
    };
  }, [state.session, disconnect]);

  useEffect(() => {
    if (!state.authToken) return;
    const expiresAt = getJwtExpiry(state.authToken);
    if (!expiresAt) {
      disconnect();
      return;
    }
    let timeout: number;
    const expireWhenDue = () => {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        disconnect();
        return;
      }
      timeout = window.setTimeout(expireWhenDue, Math.min(remaining, 2_147_000_000));
    };
    expireWhenDue();
    return () => window.clearTimeout(timeout);
  }, [state.authToken, disconnect]);

  const clearError = useCallback(() => {
    dispatch({ type: "error:clear" });
  }, []);

  const connect = useCallback(async (walletId: WalletId) => {
    queryClient.clear();
    removeStoredSession();
    removeStoredAuth();
    dispatch({ type: "connect:start", walletId });

    try {
      const nextSession = await connectWallet(walletId);
      const authToken = await authenticateWallet(nextSession);
      dispatch({ type: "connect:success", session: nextSession, authToken });
      storeSession(nextSession);
      storeAuth(authToken, nextSession.publicKey);
    } catch (error) {
      dispatch({
        type: "connect:error",
        message: toWalletErrorMessage(error),
      });
      removeStoredSession();
    }
  }, [queryClient]);

  const value = useMemo<WalletContextValue>(
    () => ({
      wallets: SUPPORTED_WALLETS,
      status: state.status,
      session: state.session,
      authToken: state.authToken,
      selectedWalletId: state.selectedWalletId,
      errorMessage: state.errorMessage,
      isHydrated: state.isHydrated,
      connect,
      disconnect,
      clearError,
    }),
    [
      clearError,
      connect,
      disconnect,
      state.errorMessage,
      state.isHydrated,
      state.selectedWalletId,
      state.session,
      state.authToken,
      state.status,
    ],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);

  if (!context) {
    throw new Error("useWallet must be used within WalletProvider.");
  }

  return context;
}
