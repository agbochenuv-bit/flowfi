// Production-ready React hook for SSE stream events
// Place this in: frontend/src/hooks/useStreamEvents.ts
//
// Reference partner event consumer (issue #284).
// Demonstrates: versioned event envelope handling, signature verification,
// idempotent processing (duplicate/replay safe), cursor recovery after gaps
// or restarts, and redacted logging.

import { useEffect, useState, useCallback, useRef } from 'react';

// Versioned FlowFi event envelope. `version` lets partners evolve safely.
const SUPPORTED_EVENT_VERSION = 1;

interface StreamEventEnvelope {
  id: string; // unique event id, used for idempotency
  version: number; // envelope schema version
  type: 'created' | 'topped_up' | 'withdrawn' | 'cancelled' | 'completed';
  cursor: string; // monotonic cursor for recovery
  signature?: string; // HMAC/signature over the canonical payload
  data: any;
  timestamp: number;
}

interface StreamEvent {
  type: StreamEventEnvelope['type'];
  data: any;
  timestamp: number;
}

interface UseStreamEventsOptions {
  streamIds?: string[];
  userPublicKeys?: string[];
  subscribeToAll?: boolean;
  autoReconnect?: boolean;
  maxRetryDelay?: number;
  // Optional verifier: return true when the signature is valid.
  verifySignature?: (envelope: StreamEventEnvelope) => boolean | Promise<boolean>;
  // Persist/restore the last processed cursor (e.g. localStorage).
  loadCursor?: () => string | null;
  saveCursor?: (cursor: string) => void;
}

interface UseStreamEventsReturn {
  events: StreamEvent[];
  connected: boolean;
  error: Error | null;
  reconnecting: boolean;
  clearEvents: () => void;
}

// Redact sensitive fields before logging so partner logs stay safe.
function redact(value: any): any {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/secret|token|key|signature|authorization/i.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
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
    verifySignature,
    loadCursor,
    saveCursor,
  } = options;

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(1000);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  // Idempotency: track processed event ids so replays are ignored.
  const processedIdsRef = useRef<Set<string>>(new Set());
  // Cursor recovery: resume from the last processed cursor.
  const cursorRef = useRef<string | null>(loadCursor ? loadCursor() : null);

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams();

    if (subscribeToAll) {
      params.append('all', 'true');
    } else {
      streamIds.forEach(id => params.append('streams', id));
      userPublicKeys.forEach(key => params.append('users', key));
    }

    // Resume from the last known cursor after a gap or restart.
    if (cursorRef.current) {
      params.append('cursor', cursorRef.current);
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    return `${baseUrl}/events/subscribe?${params}`;
  }, [streamIds, userPublicKeys, subscribeToAll]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const processEnvelope = useCallback(
    async (envelope: StreamEventEnvelope) => {
      // Version guard: ignore envelopes we cannot safely interpret.
      if (envelope.version !== SUPPORTED_EVENT_VERSION) {
        console.warn('Skipping unsupported event version', {
          id: envelope.id,
          version: envelope.version,
        });
        return;
      }

      // Idempotency: skip already-processed events (safe replay).
      if (processedIdsRef.current.has(envelope.id)) {
        return;
      }

      // Signature verification before trusting the payload.
      if (verifySignature) {
        const ok = await verifySignature(envelope);
        if (!ok) {
          console.error('Rejected event with invalid signature', {
            id: envelope.id,
          });
          return;
        }
      }

      processedIdsRef.current.add(envelope.id);

      // Advance cursor only after successful processing.
      if (envelope.cursor) {
        cursorRef.current = envelope.cursor;
        if (saveCursor) saveCursor(envelope.cursor);
      }

      setEvents(prev => [
        { type: envelope.type, data: envelope.data, timestamp: envelope.timestamp },
        ...prev.slice(0, 99), // Keep last 100 events
      ]);
    },
    [verifySignature, saveCursor]
  );

  const connect = useCallback(() => {
    const url = buildUrl();
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      setError(null);
      retryDelayRef.current = 1000; // Reset retry delay
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') {
          console.log('SSE connected:', data.clientId);
        }
      } catch (err) {
        console.error('Failed to parse SSE message:', redact(err));
      }
    };

    const handleEvent = (type: StreamEventEnvelope['type']) => (e: MessageEvent) => {
      try {
        const envelope: StreamEventEnvelope = JSON.parse(e.data);
        // Fall back to the listener type when the envelope omits it.
        if (!envelope.type) envelope.type = type;
        void processEnvelope(envelope);
      } catch (err) {
        console.error(`Failed to parse ${type} event:`, redact(err));
      }
    };

    eventSource.addEventListener('stream.created', handleEvent('created'));
    eventSource.addEventListener('stream.topped_up', handleEvent('topped_up'));
    eventSource.addEventListener('stream.withdrawn', handleEvent('withdrawn'));
    eventSource.addEventListener('stream.cancelled', handleEvent('cancelled'));
    eventSource.addEventListener('stream.completed', handleEvent('completed'));

    eventSource.onerror = () => {
      setConnected(false);
      setError(new Error('SSE connection failed'));
      eventSource.close();

      if (autoReconnect) {
        setReconnecting(true);
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log(`Reconnecting in ${retryDelayRef.current}ms...`);
          connect();
          retryDelayRef.current = Math.min(
            retryDelayRef.current * 2,
            maxRetryDelay
          );
        }, retryDelayRef.current);
      }
    };
  }, [buildUrl, autoReconnect, maxRetryDelay, processEnvelope]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connect]);

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
import { useStreamEvents } from '@/hooks/useStreamEvents';

export function StreamDashboard({ streamId }: { streamId: string }) {
  const { events, connected, reconnecting, clearEvents } = useStreamEvents({
    streamIds: [streamId],
    // Verify signatures with your shared secret / public key.
    verifySignature: async (envelope) => {
      const res = await fetch('/api/verify', {
        method: 'POST',
        body: JSON.stringify(envelope),
      });
      return res.ok;
    },
    // Persist the cursor so restarts resume where they left off.
    loadCursor: () => localStorage.getItem('flowfi:cursor'),
    saveCursor: (cursor) => localStorage.setItem('flowfi:cursor', cursor),
  });

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span>{connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected'}</span>
        <button onClick={clearEvents}>Clear</button>
      </div>

      <div className="space-y-2">
        {events.map((event, i) => (
          <div key={i} className="border p-3 rounded">
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
