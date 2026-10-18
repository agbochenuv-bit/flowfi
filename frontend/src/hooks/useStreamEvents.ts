import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { getApiBaseUrl } from '@/lib/api/_shared';

interface StreamEvent {
  type: 'created' | 'topped_up' | 'withdrawn' | 'cancelled' | 'completed' | 'paused' | 'resumed';
  data: unknown;
  timestamp: number;
}

export interface UseStreamEventsOptions {
  streamIds?: string[];
  userPublicKeys?: string[];
  subscribeToAll?: boolean;
  autoReconnect?: boolean;
  maxRetryDelay?: number;
  jwtToken?: string;
}

interface UseStreamEventsReturn {
  events: StreamEvent[];
  connected: boolean;
  error: Error | null;
  reconnecting: boolean;
  clearEvents: () => void;
  /** Force an immediate reconnect attempt, bypassing the current backoff. */
  retryNow: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 20;

export function useStreamEvents(
  options: UseStreamEventsOptions = {}
): UseStreamEventsReturn {
  const {
    streamIds: rawStreamIds = [],
    userPublicKeys: rawUserPublicKeys = [],
    subscribeToAll = false,
    autoReconnect = true,
    maxRetryDelay = 30000,
    jwtToken,
  } = options;

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const connectAttemptRef = useRef(0);
  const retryDelayRef = useRef(1000);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);

  const subscriptionKey = useMemo(() => {
    const streams = [...rawStreamIds].sort().join(',');
    const users = [...rawUserPublicKeys].sort().join(',');
    return `${subscribeToAll ? 'all' : streams}|${users}|${jwtToken || ''}`;
  }, [rawStreamIds, rawUserPublicKeys, subscribeToAll, jwtToken]);

  const buildUrl = useCallback(async () => {
    const baseUrl = getApiBaseUrl();
    if (!jwtToken) throw new Error('Wallet authentication is required for live events');
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/events/subscribe-ticket`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({
        streams: rawStreamIds,
        users: rawUserPublicKeys,
        all: subscribeToAll,
      }),
    });
    if (!response.ok) throw new Error(`Could not authorize live events (${response.status})`);
    const result = await response.json() as { ticket?: string };
    if (!result.ticket) throw new Error('Live event authorization returned no ticket');
    return `${baseUrl.replace(/\/$/, '')}/v1/events/subscribe?ticket=${encodeURIComponent(result.ticket)}`;
    // subscriptionKey captures all subscription parameters as a stable string
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionKey]);
  /**
   * Force an immediate reconnect (issue #1508).
   *
   * Cancels any pending backoff timer, resets the delay and attempt
   * counters, and calls connect() synchronously. Used by the
   * SSEStatusIndicator's "Retry Now" button so a user doesn't have to
   * wait out the current exponential-backoff window when they know
   * their network is back.
   */
  const retryNow = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    retryDelayRef.current = 1000;
    reconnectAttemptsRef.current = 0;
    connectRef.current();
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const attempt = ++connectAttemptRef.current;
    const scheduleReconnect = () => {
      if (!autoReconnect) return;
      setReconnecting(true);
      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current <= MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(retryDelayRef.current, maxRetryDelay);
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, maxRetryDelay);
        reconnectTimeoutRef.current = setTimeout(() => connectRef.current(), delay);
      }
    };

    void (async () => {
      try {
        const url = await buildUrl();
        if (attempt !== connectAttemptRef.current) return;
        const eventSource = new EventSource(url);
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          setConnected(true);
          setReconnecting(false);
          setError(null);
          retryDelayRef.current = 1000;
          reconnectAttemptsRef.current = 0;
        };

    const handleEvent = (type: StreamEvent['type']) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setEvents((prev: StreamEvent[]) => [
          { type, data, timestamp: Date.now() },
          ...prev.slice(0, 99),
        ]);
      } catch {
        // Silently ignore malformed event messages
      }
    };

        eventSource.addEventListener('stream.created', handleEvent('created'));
        eventSource.addEventListener('stream.topped_up', handleEvent('topped_up'));
        eventSource.addEventListener('stream.withdrawn', handleEvent('withdrawn'));
        eventSource.addEventListener('stream.cancelled', handleEvent('cancelled'));
        eventSource.addEventListener('stream.completed', handleEvent('completed'));
        eventSource.addEventListener('stream.paused', handleEvent('paused'));
        eventSource.addEventListener('stream.resumed', handleEvent('resumed'));

        eventSource.onerror = () => {
          if (eventSourceRef.current !== eventSource) return;
          setConnected(false);
          setError(new Error('SSE connection failed'));
          eventSource.close();
          scheduleReconnect();
        };
      } catch (error) {
        if (attempt !== connectAttemptRef.current) return;
        setConnected(false);
        setError(error instanceof Error ? error : new Error('SSE authorization failed'));
        scheduleReconnect();
      }
    })();

  }, [buildUrl, autoReconnect, maxRetryDelay]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      connectAttemptRef.current += 1;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current !== null) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [connect]);

  return {
    events,
    connected,
    error,
    reconnecting,
    clearEvents,
    retryNow,
  };
}
