"use client";

import { createContext, useCallback, useContext, useMemo, useReducer, useRef, useSyncExternalStore } from "react";
import { getNetworkConfig, NETWORK_CONFIGS, type NetworkConfig, type NetworkId } from "@/lib/stellar-config";

const STORAGE_KEY = "flowfi.network";
const DEFAULT_NETWORK: NetworkId = "testnet";

/**
 * A pending action that would be invalidated by switching networks (e.g. an
 * in-flight contract call, a signed-but-unsubmitted transaction, or a form
 * bound to the current contract/token addresses).
 */
export interface PendingNetworkAction {
  id: string;
  description?: string;
}

export interface NetworkSwitchRequest {
  from: NetworkId;
  to: NetworkId;
  pendingActions: PendingNetworkAction[];
}

export interface NetworkSwitchResult {
  switched: boolean;
  requiresConfirmation: boolean;
  request?: NetworkSwitchRequest;
}

export interface WalletNetworkStatus {
  /** Whether the connected wallet is on the same network as the app. */
  matches: boolean;
  /** The network the wallet reports, when known. */
  walletNetworkId?: NetworkId;
  /** The network the app is currently configured for. */
  activeNetworkId: NetworkId;
}

interface NetworkContextValue {
  network: NetworkConfig;
  networkId: NetworkId;
  /**
   * Request a network switch. When pending actions exist the switch is not
   * applied immediately; the caller receives `requiresConfirmation: true` and
   * must re-invoke with `{ confirm: true }` to proceed.
   */
  setNetworkId: (id: NetworkId, options?: { confirm?: boolean }) => NetworkSwitchResult;
  isHydrated: boolean;
  /** Pending actions registered for the active network. */
  pendingActions: PendingNetworkAction[];
  registerPendingAction: (action: PendingNetworkAction) => () => void;
  /** Validate the connected wallet's network against the active network. */
  walletNetworkStatus: WalletNetworkStatus;
  setWalletNetworkId: (id: NetworkId | undefined) => void;
  /** Bumped whenever the active network changes; use to key caches. */
  networkEpoch: number;
}

const NetworkContext = createContext<NetworkContextValue | undefined>(undefined);

// localStorage is an external store, so it is read through useSyncExternalStore
// instead of mirroring it into state from an effect. React hydrates with the
// server snapshot and then adopts the stored value, which keeps the server and
// client markup in sync without a setState-in-effect cascade.
const listeners = new Set<() => void>();

function subscribeToStorage(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function readStoredNetworkId(): NetworkId {
  const stored = window.localStorage.getItem(STORAGE_KEY) as NetworkId | null;
  return stored && stored in NETWORK_CONFIGS ? stored : DEFAULT_NETWORK;
}

const getServerNetworkId = () => DEFAULT_NETWORK;
const subscribeToNothing = () => () => {};
const readHydratedOnClient = () => true;
const readHydratedOnServer = () => false;

// Network-scoped cache registry. Contract/token configuration and any derived
// data are keyed by network so a switch can never surface stale values from the
// previous network. Entries are dropped when their network is left.
const networkCaches = new Map<NetworkId, Map<string, unknown>>();

export function getNetworkScopedCache<T>(networkId: NetworkId, key: string, factory: () => T): T {
  let scoped = networkCaches.get(networkId);
  if (!scoped) {
    scoped = new Map();
    networkCaches.set(networkId, scoped);
  }
  if (!scoped.has(key)) scoped.set(key, factory());
  return scoped.get(key) as T;
}

export function clearNetworkScopedCache(networkId: NetworkId): void {
  networkCaches.delete(networkId);
}

export function clearAllNetworkScopedCaches(): void {
  networkCaches.clear();
}

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const networkId = useSyncExternalStore(subscribeToStorage, readStoredNetworkId, getServerNetworkId);
  const isHydrated = useSyncExternalStore(subscribeToNothing, readHydratedOnClient, readHydratedOnServer);

  // Pending actions and wallet network are tracked per network so switching
  // cannot leak state across networks.
  const pendingActionsRef = useRef(new Map<NetworkId, Map<string, PendingNetworkAction>>());
  const walletNetworkRef = useRef<NetworkId | undefined>(undefined);
  const networkEpochRef = useRef(0);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  const getPendingFor = useCallback((id: NetworkId): PendingNetworkAction[] => {
    const map = pendingActionsRef.current.get(id);
    return map ? Array.from(map.values()) : [];
  }, []);

  const registerPendingAction = useCallback((action: PendingNetworkAction) => {
    const current = readStoredNetworkId();
    let map = pendingActionsRef.current.get(current);
    if (!map) {
      map = new Map();
      pendingActionsRef.current.set(current, map);
    }
    map.set(action.id, action);
    forceRender();
    return () => {
      const scoped = pendingActionsRef.current.get(current);
      if (scoped?.delete(action.id)) forceRender();
    };
  }, []);

  const setWalletNetworkId = useCallback((id: NetworkId | undefined) => {
    walletNetworkRef.current = id;
    forceRender();
  }, []);

  const setPersistedNetwork = useCallback(
    (id: NetworkId, options?: { confirm?: boolean }): NetworkSwitchResult => {
      const from = readStoredNetworkId();
      if (id === from) return { switched: false, requiresConfirmation: false };
      if (!(id in NETWORK_CONFIGS)) return { switched: false, requiresConfirmation: false };

      const pendingActions = getPendingFor(from);
      if (pendingActions.length > 0 && !options?.confirm) {
        return {
          switched: false,
          requiresConfirmation: true,
          request: { from, to: id, pendingActions },
        };
      }

      // Isolate stale data: drop caches for the network being left and reset
      // any pending actions bound to it.
      clearNetworkScopedCache(from);
      pendingActionsRef.current.delete(from);
      networkEpochRef.current += 1;

      window.localStorage.setItem(STORAGE_KEY, id);
      listeners.forEach((listener) => listener());
      return { switched: true, requiresConfirmation: false };
    },
    [getPendingFor],
  );

  const pendingActions = getPendingFor(networkId);
  const walletNetworkId = walletNetworkRef.current;
  const walletNetworkStatus = useMemo<WalletNetworkStatus>(
    () => ({
      matches: walletNetworkId === undefined ? true : walletNetworkId === networkId,
      walletNetworkId,
      activeNetworkId: networkId,
    }),
    [walletNetworkId, networkId],
  );

  const value = useMemo(
    () => ({
      network: getNetworkConfig(networkId),
      networkId,
      setNetworkId: setPersistedNetwork,
      isHydrated,
      pendingActions,
      registerPendingAction,
      walletNetworkStatus,
      setWalletNetworkId,
      networkEpoch: networkEpochRef.current,
    }),
    [networkId, isHydrated, setPersistedNetwork, pendingActions, registerPendingAction, walletNetworkStatus, setWalletNetworkId],
  );
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue { const context = useContext(NetworkContext); if (!context) throw new Error("useNetwork must be used within NetworkProvider"); return context; }