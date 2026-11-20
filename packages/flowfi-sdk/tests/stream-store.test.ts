import { expect, it, vi } from 'vitest';
import { createStreamStore } from '../src/stream-store.js';

it('keeps SSR idle and ignores superseded reads and late wallet updates', async () => {
  const reads: Array<(value: number) => void> = [];
  let invalidate = () => {};
  const stop = vi.fn();
  const transport = {
    load: vi.fn(() => new Promise<number>(resolve => reads.push(resolve))),
    subscribe: (_id: string, _wallet: string, refresh: () => void) => {
      invalidate = refresh;
      return stop;
    },
  };
  const a = createStreamStore(transport, '1', 'a');
  expect(a.getServerSnapshot().status).toBe('loading');
  expect(reads).toHaveLength(0);
  const cleanup = a.subscribe(vi.fn());
  invalidate();
  reads[1](2);
  reads[0](1);
  await Promise.resolve();
  expect(a.getSnapshot()).toEqual({status: 'ready', value: 2});
  invalidate();
  cleanup();
  const b = createStreamStore(transport, '1', 'b');
  const disconnect = b.subscribe(vi.fn());
  reads[2](3);
  await Promise.resolve();
  expect(b.getSnapshot().status).toBe('loading');
  expect(transport.load).toHaveBeenLastCalledWith('1', 'b', expect.any(AbortSignal));
  disconnect();
  expect(stop).toHaveBeenCalledTimes(2);
});
