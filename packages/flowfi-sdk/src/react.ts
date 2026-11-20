import { useMemo, useSyncExternalStore } from 'react';
import { createStreamStore, type StreamTransport } from './stream-store.js';

export function useStream<T>(transport: StreamTransport<T>, stream: string, wallet: string) {
  const store = useMemo(() => createStreamStore(transport, stream, wallet), [transport, stream, wallet]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
