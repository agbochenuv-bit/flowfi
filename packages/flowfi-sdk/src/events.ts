export type StreamEventType =
  | 'connected'
  | 'stream.created'
  | 'stream.topped_up'
  | 'stream.withdrawn'
  | 'stream.cancelled'
  | 'stream.completed'
  | 'stream.paused'
  | 'stream.resumed'
  | 'STREAM_LOW_BALANCE'
  | 'reconnect'
  | (string & {});

export interface FlowFiEvent<T = unknown> {
  type: StreamEventType;
  data: T;
  /** ID from the current SSE frame, when one was supplied. */
  id?: string;
  /** Latest SSE ID, retained across frames without an `id:` field. */
  lastEventId: string;
}

export interface EventClientOptions {
  headers?: HeadersInit;
  fetch?: typeof fetch;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface EventReconnectInfo {
  attempt: number;
  delayMs: number;
}

export interface EventClientLifecycle {
  open: { response: Response };
  reconnect: EventReconnectInfo;
  error: { error: unknown };
  close: undefined;
}

type EventHandler = (event: FlowFiEvent) => void;
type LifecycleHandler<K extends keyof EventClientLifecycle> = (
  event: EventClientLifecycle[K],
) => void;

/** Fetch-based SSE client with bounded reconnect backoff and Last-Event-ID support. */
export class FlowFiEventClient {
  private readonly headers: HeadersInit;
  private readonly fetcher: typeof fetch;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly lifecycleHandlers = new Map<keyof EventClientLifecycle, Set<(event: never) => void>>();
  private controller?: AbortController;
  private closed = true;
  private latestId = '';

  constructor(
    private readonly url: string | URL,
    options: EventClientOptions = {},
  ) {
    this.headers = options.headers ?? {};
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    if (this.initialRetryDelayMs < 0 || this.maxRetryDelayMs < this.initialRetryDelayMs) {
      throw new Error('SSE retry delays must satisfy 0 <= initialRetryDelayMs <= maxRetryDelayMs');
    }
  }

  get lastEventId(): string {
    return this.latestId;
  }

  on(type: StreamEventType, handler: EventHandler): () => void {
    let handlers = this.eventHandlers.get(type);
    if (!handlers) this.eventHandlers.set(type, handlers = new Set());
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  onLifecycle<K extends keyof EventClientLifecycle>(
    type: K,
    handler: LifecycleHandler<K>,
  ): () => void {
    let handlers = this.lifecycleHandlers.get(type);
    if (!handlers) this.lifecycleHandlers.set(type, handlers = new Set());
    handlers.add(handler as (event: never) => void);
    return () => handlers?.delete(handler as (event: never) => void);
  }

  connect(): void {
    if (!this.closed) return;
    this.closed = false;
    this.controller = new AbortController();
    void this.run(this.controller.signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort();
  }

  private emitLifecycle<K extends keyof EventClientLifecycle>(
    type: K,
    event: EventClientLifecycle[K],
  ): void {
    for (const handler of this.lifecycleHandlers.get(type) ?? []) {
      (handler as (value: EventClientLifecycle[K]) => void)(event);
    }
  }

  private emitEvent(event: FlowFiEvent): void {
    for (const handler of this.eventHandlers.get(event.type) ?? []) handler(event);
    for (const handler of this.eventHandlers.get('*') ?? []) handler(event);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let delayMs = this.initialRetryDelayMs;
    let retryOverride: number | undefined;
    let attempt = 0;

    while (!signal.aborted) {
      try {
        const headers = new Headers(this.headers);
        if (this.latestId) headers.set('Last-Event-ID', this.latestId);
        const response = await this.fetcher(this.url, { headers, signal });
        if (!response.ok) throw new Error(`SSE request failed with HTTP ${response.status}`);
        if (!response.body) throw new Error('SSE response has no readable body');

        this.emitLifecycle('open', { response });
        attempt = 0;
        delayMs = this.initialRetryDelayMs;
        const reader = response.body.getReader();
        try {
          const retry = await this.readStream(reader, signal, (value) => {
            retryOverride = Math.min(value, this.maxRetryDelayMs);
          });
          if (retry) retryOverride = retry;
        } finally {
          reader.releaseLock();
        }
        if (signal.aborted) break;
      } catch (error) {
        if (signal.aborted) break;
        this.emitLifecycle('error', { error });
      }

      const nextDelay = retryOverride ?? delayMs;
      attempt += 1;
      this.emitLifecycle('reconnect', { attempt, delayMs: nextDelay });
      try {
        await wait(nextDelay, signal);
      } catch {
        break;
      }
      delayMs = Math.min(Math.max(this.initialRetryDelayMs, delayMs * 2), this.maxRetryDelayMs);
      retryOverride = undefined;
    }

    this.closed = true;
    this.controller = undefined;
    this.emitLifecycle('close', undefined);
  }

  private async readStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    setRetry: (retry: number) => void,
  ): Promise<number | undefined> {
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let data: string[] = [];
    let frameId: string | undefined;
    let retry: number | undefined;

    const dispatch = () => {
      if (data.length === 0) {
        eventName = '';
        frameId = undefined;
        return;
      }
      const rawData = data.join('\n');
      let parsed: unknown = rawData;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        // Keep non-JSON SSE data available as a string.
      }
      let type = eventName || 'message';
      if (type === 'message' && isRecord(parsed) && parsed.type === 'connected') type = 'connected';
      this.emitEvent({ type, data: parsed, id: frameId, lastEventId: this.latestId });
      data = [];
      eventName = '';
      frameId = undefined;
    };

    const processLine = (line: string) => {
      if (line === '') {
        dispatch();
        return;
      }
      if (line.startsWith(':')) return;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      switch (field) {
        case 'event': eventName = value; break;
        case 'data': data.push(value); break;
        case 'id':
          if (!value.includes('\0')) {
            frameId = value;
            this.latestId = value;
          }
          break;
        case 'retry':
          if (/^\d+$/.test(value)) {
            retry = Math.min(Number(value), this.maxRetryDelayMs);
            setRetry(retry);
          }
          break;
      }
    };

    const cancelReader = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancelReader, { once: true });
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          processLine(line);
        }
      }
      if (buffer.length > 0) processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      dispatch();
      return retry;
    } finally {
      signal.removeEventListener('abort', cancelReader);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}