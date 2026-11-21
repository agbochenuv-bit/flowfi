// Production-ready React hooks for stream lifecycle
// Place this in: frontend/src/hooks/useStreamEvents.ts
//
// These hooks are framework-neutral: they only depend on `react` and the
// standard `EventSource`/`fetch` APIs, so the core SDK stays decoupled from any
// specific UI framework. They are safe to import during server rendering.

import { useEffect, useState, useCallback, useRef } from 'react';

interface StreamEvent {
  type: 'created' | 'topped_up' | 'withdrawn' | 'cancelled' | 'completed';
  data: any;
  timestamp: number;
}

interface UseStreamEventsOptions {
  streamIds?: string[];
  userPublicKeys?: string[];
  subscribeToAll?: boolean;
  autoReconnect?: boolean;
  maxRetryDelay?: number;
}

interface UseStreamEventsReturn {
  events: StreamEvent[];
  connected: boolean;
  error: Error | null;
  reconnecting: boolean;
  clearEvents: () => void;
}

/**
 * Minimal transport contract so the hooks can be exercised with mocked
 * transports in tests without a real network or EventSource implementation.
 */
export interface StreamTransport {
  subscribe(url: string, handlers: StreamTransportHandlers): StreamTransportSubscription;
  fetchState?(url: string, signal?: AbortSignal): Promise<unknown>;
}

export interface StreamTransportHandlers {
  onOpen(): void;
  onEvent(type: StreamEvent['type'], data: unknown): void;
  onError(error: Error): void;
}

export interface StreamTransportSubscription {
  close(): void;
}

interface UseStreamStateOptions {
  streamId?: string;
  /** Wallet/account identity; changing it refetches and resets state. */
  walletAddress?: string | null;
  transport?: StreamTransport;
  /** Base URL for the stream state endpoint. */
  baseUrl?: string;
}

interface UseStreamStateReturn<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

const DEFAULT_BASE_URL = 'http://localhost:3001';

function resolveBaseUrl(baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  return DEFAULT_BASE_URL;
}

/**
 * Returns true when the user has requested reduced motion via the OS/browser
 * `prefers-reduced-motion: reduce` media query. Consumers should use this to
 * disable or minimize animations for live balance updates, charts, and
 * transaction status transitions while preserving the information conveyed.
 *
 * Safe for SSR: returns false when `window`/`matchMedia` are unavailable.
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(query.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handleChange);
      return () => query.removeEventListener('change', handleChange);
    }

    // Fallback for older browsers without addEventListener on MediaQueryList.
    query.addListener(handleChange);
    return () => query.removeListener(handleChange);
  }, []);

  return prefersReducedMotion;
}

/**
 * Loads the current state of a stream and keeps it fresh. Refetches when the
 * stream id or wallet changes, aborts in-flight requests on cleanup, and
 * ignores stale (out-of-order or post-unmount) responses. SSR-safe: no fetch
 * is issued when `window` is unavailable.
 */
export function useStreamState<T = unknown>(
  options: UseStreamStateOptions = {}
): UseStreamStateReturn<T> {
  const { streamId, walletAddress, transport, baseUrl } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const requestIdRef = useRef(0);

  const refetch = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    // Reset state whenever the identity (stream/wallet) changes so stale data
    // from a previous account never leaks into the new one.
    setData(null);
    setError(null);

    if (!streamId || typeof window === 'undefined') {
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    const url = `${resolveBaseUrl(baseUrl)}/streams/${encodeURIComponent(streamId)}`;

    setLoading(true);

    const run = async () => {
      try {
        const result = transport?.fetchState
          ? await transport.fetchState(url, controller.signal)
          : await fetch(url, { signal: controller.signal }).then((res) => {
              if (!res.ok) throw new Error(`Failed to load stream: ${res.status}`);
              return res.json();
            });

        // Ignore responses that are no longer the latest request.
        if (requestId !== requestIdRef.current) return;
        setData(result as T);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    };

    void run();

    return () => {
      controller.abort();
    };
  }, [streamId, walletAddress, transport, baseUrl, reloadToken]);

  return { data, loading, error, refetch };
}

function createEventSourceTransport(): StreamTransport {
  return {
    subscribe(url, handlers) {
      const eventSource = new EventSource(url);

      eventSource.onopen = () => handlers.onOpen();
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'connected') {
            console.log('SSE connected:', data.clientId);
          }
        } catch (err) {
          console.error('Failed to parse SSE message:', err);
        }
      };

      const handleEvent = (type: StreamEvent['type']) => (e: MessageEvent) => {
        try {
          handlers.onEvent(type, JSON.parse(e.data));
        } catch (err) {
          console.error(`Failed to parse ${type} event:`, err);
        }
      };

      eventSource.addEventListener('stream.created', handleEvent('created'));
      eventSource.addEventListener('stream.topped_up', handleEvent('topped_up'));
      eventSource.addEventListener('stream.withdrawn', handleEvent('withdrawn'));
      eventSource.addEventListener('stream.cancelled', handleEvent('cancelled'));
      eventSource.addEventListener('stream.completed', handleEvent('completed'));

      eventSource.onerror = () => handlers.onError(new Error('SSE connection failed'));

      return { close: () => eventSource.close() };
    },
  };
}

export function useStreamEvents(
  options: UseStreamEventsOptions = {}
): UseStreamEventsReturn {
  const {
    streamIds = [],
    userPublicKeys = [],
    subscribeToAll = false,
    autoReconnect = true,
    maxRetryDelay = 30000,
  } = options;

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const subscriptionRef = useRef<StreamTransportSubscription | null>(null);
  const retryDelayRef = useRef(1000);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const mountedRef = useRef(true);

  // Serialize the subscription key so array identity changes don't churn the
  // connection while genuine wallet/stream changes do.
  const subscriptionKey = JSON.stringify({ streamIds, userPublicKeys, subscribeToAll });

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams();

    if (subscribeToAll) {
      params.append('all', 'true');
    } else {
      streamIds.forEach((id) => params.append('streams', id));
      userPublicKeys.forEach((key) => params.append('users', key));
    }

    return `${resolveBaseUrl()}/events/subscribe?${params}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionKey]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    // SSR safety: no EventSource during server rendering.
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    const transport = createEventSourceTransport();

    const connect = () => {
      if (!mountedRef.current) return;

      const subscription = transport.subscribe(buildUrl(), {
        onOpen() {
          if (!mountedRef.current) return;
          setConnected(true);
          setReconnecting(false);
          setError(null);
          retryDelayRef.current = 1000;
        },
        onEvent(type, data) {
          if (!mountedRef.current) return;
          setEvents((prev) => [
            { type, data, timestamp: Date.now() },
            ...prev.slice(0, 99), // Keep last 100 events
          ]);
        },
        onError(err) {
          if (!mountedRef.current) return;
          setConnected(false);
          setError(err);
          subscriptionRef.current?.close();
          subscriptionRef.current = null;

          if (autoReconnect) {
            setReconnecting(true);
            reconnectTimeoutRef.current = setTimeout(() => {
              connect();
              retryDelayRef.current = Math.min(retryDelayRef.current * 2, maxRetryDelay);
            }, retryDelayRef.current);
          }
        },
      });

      subscriptionRef.current = subscription;
    };

    connect();

    return () => {
      mountedRef.current = false;
      subscriptionRef.current?.close();
      subscriptionRef.current = null;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = undefined;
      }
      setConnected(false);
      setReconnecting(false);
    };
  }, [buildUrl, autoReconnect, maxRetryDelay]);

  return {
    events,
    connected,
    error,
    reconnecting,
    clearEvents,
  };
}

// Example usage in a component:
/*
import { useStreamEvents, useStreamState, usePrefersReducedMotion } from '@/hooks/useStreamEvents';

export function StreamDashboard({ streamId, walletAddress }: { streamId: string; walletAddress: string }) {
  const { data, loading, error } = useStreamState({ streamId, walletAddress });
  const { events, connected, reconnecting, clearEvents } = useStreamEvents({
    streamIds: [streamId],
  });
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <div>
      <div className="flex items-center gap-2">
        <div
          className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          aria-hidden="true"
        />
        <span role="status" aria-live="polite">
          {connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected'}
        </span>
        <button onClick={clearEvents}>Clear</button>
      </div>

      {loading && <p>Loading stream…</p>}
      {error && <p role="alert">{error.message}</p>}
      {data && <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>}

      <div className="space-y-2">
        {events.map((event, i) => (
          <div
            key={i}
            className="border p-3 rounded"
            style={prefersReducedMotion ? { transition: 'none', animation: 'none' } : undefined}
          >
            <div className="font-bold">{event.type}</div>
            <pre className="text-xs">{JSON.stringify(event.data, null, 2)}</pre>
            <div className="text-xs text-gray-500">
              {new Date(event.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
*/
