import { describe, expect, it, vi } from 'vitest';
import { FlowFiEventClient } from '../src/events.js';

function response(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('FlowFiEventClient', () => {
  it('parses named events, connected envelopes, multiline data, and retained IDs', async () => {
    let requests = 0;
    const events = new FlowFiEventClient('https://example.test/events', {
      fetch: vi.fn(async () => {
        requests += 1;
        if (requests === 1) {
          return response([
            'data: {"type":"connected","clientId":"client-1"}',
            '',
            'id: evt-12',
            'event: stream.created',
            'data: {"streamId":"7"}',
            '',
            'event: stream.withdrawn',
            'data: first',
            'data: second',
            '',
          ].join('\n'));
        }
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }),
      initialRetryDelayMs: 0,
      maxRetryDelayMs: 0,
    });
    const connected = vi.fn();
    const created = vi.fn();
    const withdrawn = vi.fn();
    events.on('connected', connected);
    events.on('stream.created', created);
    events.on('stream.withdrawn', withdrawn);
    const framesSeen = new Promise<void>((resolve) => {
      let count = 0;
      const done = () => { count += 1; if (count === 3) resolve(); };
      events.on('connected', done);
      events.on('stream.created', done);
      events.on('stream.withdrawn', done);
    });
    const closed = new Promise<void>((resolve) => events.onLifecycle('close', resolve));

    events.connect();
    await framesSeen;
    events.close();
    await closed;

    expect(connected).toHaveBeenCalledWith(expect.objectContaining({ data: { type: 'connected', clientId: 'client-1' } }));
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-12', lastEventId: 'evt-12', data: { streamId: '7' } }));
    expect(withdrawn).toHaveBeenCalledWith(expect.objectContaining({ id: undefined, lastEventId: 'evt-12', data: 'first\nsecond' }));
  });

  it('sends the last event ID on reconnect and reports lifecycle events', async () => {
    const seenIds: Array<string | null> = [];
    let callCount = 0;
    const reconnecting = new FlowFiEventClient('https://example.test/events', {
      initialRetryDelayMs: 0,
      maxRetryDelayMs: 0,
      fetch: vi.fn(async (_url, init) => {
        seenIds.push(new Headers(init?.headers).get('Last-Event-ID'));
        callCount += 1;
        if (callCount === 1) return response('id: cursor-99\ndata: {"type":"connected"}\n\n');
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }),
    });
    const reconnect = new Promise<{ attempt: number }>((resolve) => {
      reconnecting.onLifecycle('reconnect', resolve);
    });
    const secondOpen = new Promise<void>((resolve) => {
      let opens = 0;
      reconnecting.onLifecycle('open', () => {
        opens += 1;
        if (opens === 2) resolve();
      });
    });
    const closed = new Promise<void>((resolve) => reconnecting.onLifecycle('close', resolve));

    reconnecting.connect();
    await Promise.all([reconnect, secondOpen]);
    reconnecting.close();
    await closed;

    expect(seenIds).toEqual([null, 'cursor-99']);
    expect(reconnecting.lastEventId).toBe('cursor-99');
  });
});