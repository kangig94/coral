import { expect, it, vi } from 'vitest';
import type { AppServerTransport } from '#src/providers/contract.js';
import { observeCodexThreadRead } from '#src/providers/codex/thread-read.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

it('detaches stopped readers across successive observations while retaining one unanswered request', async () => {
  const reply = createDeferred<unknown>();
  const rpc = vi.fn(() => reply.promise);
  const lease = {
    rpc,
    closed: new Promise<void>(() => {}),
    subscribe: () => () => {},
  } as AppServerTransport;
  const stopped = Array.from({ length: 3 }, () => vi.fn());
  for (const reader of stopped) {
    const stop = observeCodexThreadRead(lease, 'thread-1', reader);
    stop();
  }
  const active = vi.fn();
  observeCodexThreadRead(lease, 'thread-1', active);
  expect(rpc).toHaveBeenCalledTimes(1);
  const response = { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] } };
  reply.resolve(response);
  await flushMicrotasks(10);
  for (const reader of stopped) expect(reader).not.toHaveBeenCalled();
  expect(active).toHaveBeenCalledExactlyOnceWith(response);
});

it('clears a rejected shared read so a later observation can recover through a fresh request', async () => {
  const failed = createDeferred<unknown>();
  const response = { thread: { id: 'thread-1', turns: [{ id: 'turn-1', status: 'completed' }] } };
  const rpc = vi
    .fn()
    .mockImplementationOnce(() => failed.promise)
    .mockResolvedValueOnce(response);
  const lease = {
    rpc,
    closed: new Promise<void>(() => {}),
    subscribe: () => () => {},
  } as AppServerTransport;
  const first = vi.fn();
  observeCodexThreadRead(lease, 'thread-1', first);
  failed.reject(new Error('temporary read failure'));
  await flushMicrotasks(10);
  expect(first).toHaveBeenCalledExactlyOnceWith(null);
  const recovered = vi.fn();
  observeCodexThreadRead(lease, 'thread-1', recovered);
  await flushMicrotasks(10);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(recovered).toHaveBeenCalledExactlyOnceWith(response);
});
