export type StreamSnapshot<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: unknown };

export interface StreamTransport<T> {
  load(stream: string, wallet: string, signal: AbortSignal): Promise<T>;
  subscribe(stream: string, wallet: string, invalidate: () => void): () => void;
}

const loading = { status: 'loading' } as const;

/** Create once per stream, wallet and transport. IO starts on first subscription. */
export function createStreamStore<T>(transport: StreamTransport<T>, stream: string, wallet: string) {
  let snapshot: StreamSnapshot<T> = loading;
  const listeners = new Set<() => void>();
  let active: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;

  function refresh() {
    if (!listeners.size) return;
    active?.abort();
    const request = new AbortController();
    active = request;
    async function read() {
      try {
        const value = await transport.load(stream, wallet, request.signal);
        if (request.signal.aborted) return;
        snapshot = { status: 'ready', value };
      } catch (error) {
        if (request.signal.aborted) return;
        snapshot = { status: 'error', error };
      }
      listeners.forEach(notify => notify());
    }
    void read();
  }

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => loading,
    subscribe(notify: () => void) {
      listeners.add(notify);
      if (listeners.size === 1) {
        try {
          unsubscribe = transport.subscribe(stream, wallet, refresh);
          refresh();
        } catch (error) {
          snapshot = { status: 'error', error };
          notify();
        }
      }
      return () => {
        listeners.delete(notify);
        if (!listeners.size) {
          active?.abort();
          unsubscribe?.();
          snapshot = loading;
        }
      };
    },
  };
}
