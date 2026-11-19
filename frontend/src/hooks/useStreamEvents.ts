import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Stream lifecycle event types that can trigger notifications.
 *
 * Privacy model:
 * - Notification preferences are scoped strictly to the connected wallet's
 *   public key. No personally identifiable information (PII) is collected,
 *   stored, or transmitted.
 * - Preferences are persisted locally (localStorage) and optionally synced to
 *   the backend `NotificationPreference` model keyed by wallet public key.
 * - Users may opt out of any channel/event combination at any time; opt-out is
 *   honored immediately and persisted so it survives reloads and reconnects.
 * - Browser notifications require explicit permission; denial is handled
 *   gracefully and never blocks in-app notifications.
 */
export type StreamEventType =
  | 'CREATED'
  | 'TOPPED_UP'
  | 'WITHDRAWN'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'PAUSED'
  | 'RESUMED';

export const STREAM_EVENT_TYPES: readonly StreamEventType[] = [
  'CREATED',
  'TOPPED_UP',
  'WITHDRAWN',
  'CANCELLED',
  'COMPLETED',
  'PAUSED',
  'RESUMED',
] as const;

export type NotificationChannel = 'inApp' | 'browser';

export interface ChannelPreferences {
  inApp: boolean;
  browser: boolean;
}

export type NotificationPreferences = Record<StreamEventType, ChannelPreferences>;

export interface StreamEvent {
  eventType: StreamEventType;
  streamId: string;
  transactionHash: string;
  /** Optional ledger/timestamp for ordering; not required for dedupe. */
  timestamp?: number;
}

export interface NotificationPreferenceRecord {
  walletPublicKey: string;
  preferences: NotificationPreferences;
  updatedAt: number;
}

const STORAGE_KEY_PREFIX = 'stream-notification-preferences:';
const DEDUPE_KEY_PREFIX = 'stream-notification-dedupe:';
const DEDUPE_MAX_ENTRIES = 500;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  CREATED: { inApp: true, browser: true },
  TOPPED_UP: { inApp: true, browser: false },
  WITHDRAWN: { inApp: true, browser: false },
  CANCELLED: { inApp: true, browser: true },
  COMPLETED: { inApp: true, browser: true },
  PAUSED: { inApp: true, browser: false },
  RESUMED: { inApp: true, browser: false },
};

function clonePreferences(prefs: NotificationPreferences): NotificationPreferences {
  const result = {} as NotificationPreferences;
  for (const type of STREAM_EVENT_TYPES) {
    const channel = prefs[type] ?? DEFAULT_NOTIFICATION_PREFERENCES[type];
    result[type] = { inApp: !!channel.inApp, browser: !!channel.browser };
  }
  return result;
}

function storageKey(walletPublicKey: string): string {
  return `${STORAGE_KEY_PREFIX}${walletPublicKey}`;
}

function dedupeKey(walletPublicKey: string): string {
  return `${DEDUPE_KEY_PREFIX}${walletPublicKey}`;
}

function safeGetItem(key: string): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode, quota); preferences still work
    // for the current session via in-memory state.
  }
}

export function loadPreferences(walletPublicKey: string): NotificationPreferences {
  const raw = safeGetItem(storageKey(walletPublicKey));
  if (!raw) return clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES);
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPreferences>;
    return clonePreferences(parsed as NotificationPreferences);
  } catch {
    return clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES);
  }
}

export function savePreferences(
  walletPublicKey: string,
  preferences: NotificationPreferences,
): void {
  const record: NotificationPreferenceRecord = {
    walletPublicKey,
    preferences: clonePreferences(preferences),
    updatedAt: Date.now(),
  };
  safeSetItem(storageKey(walletPublicKey), JSON.stringify(record.preferences));
}

function loadDedupeSet(walletPublicKey: string): string[] {
  const raw = safeGetItem(dedupeKey(walletPublicKey));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function saveDedupeSet(walletPublicKey: string, keys: string[]): void {
  const trimmed = keys.slice(-DEDUPE_MAX_ENTRIES);
  safeSetItem(dedupeKey(walletPublicKey), JSON.stringify(trimmed));
}

export function dedupeIdentifier(event: StreamEvent): string {
  return `${event.transactionHash}:${event.eventType}`;
}

export function buildStreamDeepLink(streamId: string): string {
  const encoded = encodeURIComponent(streamId);
  return `/streams/${encoded}`;
}

export interface NotificationPermissionState {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
}

function getPermissionState(): NotificationPermissionState {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return { supported: false, permission: 'unsupported' };
  }
  return { supported: true, permission: window.Notification.permission };
}

export interface UseStreamEventsOptions {
  walletPublicKey: string | null | undefined;
  /** Optional backend sync hook. Called after local persistence. */
  syncPreferences?: (
    walletPublicKey: string,
    preferences: NotificationPreferences,
  ) => Promise<void> | void;
  /** Optional in-app notification sink. */
  onInAppNotification?: (event: StreamEvent, deepLink: string) => void;
}

export interface UseStreamEventsResult {
  preferences: NotificationPreferences;
  permission: NotificationPermissionState;
  setChannelEnabled: (
    eventType: StreamEventType,
    channel: NotificationChannel,
    enabled: boolean,
  ) => void;
  setAllForChannel: (channel: NotificationChannel, enabled: boolean) => void;
  requestBrowserPermission: () => Promise<NotificationPermission | 'unsupported'>;
  handleEvent: (event: StreamEvent) => void;
  resetPreferences: () => void;
}

export function useStreamEvents(options: UseStreamEventsOptions): UseStreamEventsResult {
  const { walletPublicKey, syncPreferences, onInAppNotification } = options;

  const [preferences, setPreferences] = useState<NotificationPreferences>(() =>
    walletPublicKey
      ? loadPreferences(walletPublicKey)
      : clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES),
  );
  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    getPermissionState(),
  );

  const walletRef = useRef<string | null>(walletPublicKey ?? null);
  const onInAppRef = useRef(onInAppNotification);
  onInAppRef.current = onInAppNotification;
  const syncRef = useRef(syncPreferences);
  syncRef.current = syncPreferences;

  // Reload preferences whenever the wallet changes so preferences are strictly
  // wallet-scoped and never leak between accounts.
  useEffect(() => {
    walletRef.current = walletPublicKey ?? null;
    if (walletPublicKey) {
      setPreferences(loadPreferences(walletPublicKey));
    } else {
      setPreferences(clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES));
    }
    setPermission(getPermissionState());
  }, [walletPublicKey]);

  const persist = useCallback((next: NotificationPreferences) => {
    const wallet = walletRef.current;
    if (!wallet) return;
    savePreferences(wallet, next);
    if (syncRef.current) {
      try {
        void syncRef.current(wallet, next);
      } catch {
        // Backend sync failures must not break local opt-out semantics.
      }
    }
  }, []);

  const setChannelEnabled = useCallback(
    (eventType: StreamEventType, channel: NotificationChannel, enabled: boolean) => {
      setPreferences((prev) => {
        const next = clonePreferences(prev);
        next[eventType] = { ...next[eventType], [channel]: enabled };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const setAllForChannel = useCallback(
    (channel: NotificationChannel, enabled: boolean) => {
      setPreferences((prev) => {
        const next = clonePreferences(prev);
        for (const type of STREAM_EVENT_TYPES) {
          next[type] = { ...next[type], [channel]: enabled };
        }
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const requestBrowserPermission = useCallback(async (): Promise<
    NotificationPermission | 'unsupported'
  > => {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
      setPermission({ supported: false, permission: 'unsupported' });
      return 'unsupported';
    }
    try {
      const result = await window.Notification.requestPermission();
      setPermission({ supported: true, permission: result });
      return result;
    } catch {
      // Some browsers throw on requestPermission (e.g. insecure context).
      const state = getPermissionState();
      setPermission(state);
      return state.permission;
    }
  }, []);

  const handleEvent = useCallback((event: StreamEvent) => {
    const wallet = walletRef.current;
    if (!wallet) return;

    const prefs = loadPreferences(wallet);
    const channelPrefs = prefs[event.eventType];
    if (!channelPrefs) return;

    const identifier = dedupeIdentifier(event);
    const seen = loadDedupeSet(wallet);
    if (seen.includes(identifier)) {
      // Duplicate event (same transactionHash + eventType) — suppress.
      return;
    }
    seen.push(identifier);
    saveDedupeSet(wallet, seen);

    const deepLink = buildStreamDeepLink(event.streamId);

    if (channelPrefs.inApp && onInAppRef.current) {
      try {
        onInAppRef.current(event, deepLink);
      } catch {
        // Sink errors must not prevent browser notification attempts.
      }
    }

    if (channelPrefs.browser) {
      const state = getPermissionState();
      setPermission(state);
      if (state.supported && state.permission === 'granted') {
        try {
          const notification = new window.Notification(
            `Stream ${event.eventType.toLowerCase().replace('_', ' ')}`,
            {
              body: `Stream ${event.streamId}`,
              tag: identifier,
              data: { deepLink, streamId: event.streamId, eventType: event.eventType },
            },
          );
          notification.onclick = () => {
            try {
              if (typeof window !== 'undefined') {
                window.focus();
                window.location.assign(deepLink);
              }
            } catch {
              // Navigation failures are non-fatal.
            }
          };
        } catch {
          // Notification construction can fail; ignore gracefully.
        }
      }
      // If permission is 'denied' or 'default', we silently skip browser
      // notifications. In-app notifications above are unaffected.
    }
  }, []);

  const resetPreferences = useCallback(() => {
    const next = clonePreferences(DEFAULT_NOTIFICATION_PREFERENCES);
    setPreferences(next);
    persist(next);
  }, [persist]);

  return useMemo(
    () => ({
      preferences,
      permission,
      setChannelEnabled,
      setAllForChannel,
      requestBrowserPermission,
      handleEvent,
      resetPreferences,
    }),
    [
      preferences,
      permission,
      setChannelEnabled,
      setAllForChannel,
      requestBrowserPermission,
      handleEvent,
      resetPreferences,
    ],
  );
}

export default useStreamEvents;