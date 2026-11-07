import { describe, expect, it, vi } from 'vitest';
import type { AppServerSession } from '#src/providers/contract.js';
import { acquireCodexThread, releaseCodexThread } from '#src/providers/codex/thread-release.js';
import { ProviderRpcError } from '#src/providers/app-server-transport.js';
import { wrapAppServerSession } from '#src/providers/internal/server-lease-boundary.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

function releaseConnection() {
  const time = new VirtualTime();
  const closed = createDeferred<Error | void>();
  const rpc = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ status: 'unsubscribed' }));
  const raw: AppServerSession = {
    rpc: rpc as AppServerSession['rpc'],
    subscribe: () => () => {},
    closed: closed.promise,
    interrupt: async () => ({ kind: 'not-accepted', reason: 'No fixture interrupt' }),
  };
  return {
    raw,
    time,
    rpc,
    close: () => closed.resolve(),
    unsubscribes: () => rpc.mock.calls.filter(([method]) => method === 'thread/unsubscribe').length,
  };
}

describe('Codex unsubscribe dispositions', () => {
  const protocolError = (rpcCode: number | undefined) =>
    new ProviderRpcError({
      requestId: 1,
      method: 'thread/unsubscribe',
      rpcCode,
      providerMessage: 'cannot unsubscribe',
      providerData: undefined,
      hostLog: { startSeq: 1, endSeq: 2 },
    });

  it.each([
    { name: 'unsubscribed', reply: { status: 'unsubscribed' }, kind: 'accepted' },
    { name: 'not loaded', reply: { status: 'notLoaded' }, kind: 'accepted' },
    { name: 'explicit negative reply', reply: { status: 'notSubscribed' }, kind: 'refused' },
    { name: 'null reply', reply: null, kind: 'unknown' },
    { name: 'missing reply', reply: undefined, kind: 'unknown' },
    { name: 'missing status', reply: {}, kind: 'unknown' },
    { name: 'invalid status', reply: { status: 'invalid' }, kind: 'unknown' },
    { name: 'invalid status type', reply: { status: 1 }, kind: 'unknown' },
    { name: 'transport close', error: new Error('connection closed before reply'), kind: 'unknown' },
    { name: 'explicit protocol error', error: protocolError(-32600), kind: 'refused' },
    { name: 'malformed protocol error', error: protocolError(undefined), kind: 'unknown' },
  ])('returns $kind for $name', async (scenario) => {
    const time = new VirtualTime();
    const report = vi.fn();
    const lease = {
      closed: new Promise<Error | void>(() => {}),
      rpc: async () => {
        if (scenario.error !== undefined) throw scenario.error;
        return scenario.reply;
      },
    } as unknown as AppServerSession;
    const disposition = await releaseCodexThread(lease, time, acquireCodexThread(lease, 'thread-1'), null, report);
    expect(disposition.kind).toBe(scenario.kind);
    if (scenario.kind === 'accepted') expect(report).not.toHaveBeenCalled();
    else
      expect(report).toHaveBeenCalledWith(
        expect.stringContaining(scenario.kind === 'unknown' ? 'release unconfirmed' : 'release refused'),
      );
    expect(time.now()).toBe(1_000_000);
  });

  it('returns unknown at the bound while the RPC remains pending', async () => {
    const time = new VirtualTime();
    const report = vi.fn();
    const reply = createDeferred<unknown>();
    const lease = {
      rpc: () => reply.promise,
      closed: new Promise<Error | void>(() => {}),
    } as unknown as AppServerSession;
    const released = releaseCodexThread(lease, time, acquireCodexThread(lease, 'thread-1'), null, report);
    time.tick(1000);
    expect(await released).toMatchObject({ kind: 'unknown' });
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('release unconfirmed'));
    reply.resolve({ status: 'unsubscribed' });
    await flushMicrotasks(20);
    expect(report).toHaveBeenCalledOnce();
  });
});

describe('Codex connection ownership release', () => {
  it('returns superseded without dispatch or diagnostic when a successor owns the thread', async () => {
    const h = releaseConnection();
    const first = wrapAppServerSession(h.raw, 'first');
    const second = wrapAppServerSession(h.raw, 'second');
    const oldOwner = acquireCodexThread(first, 'thread-shared');
    const pending = createDeferred();
    const report = vi.fn();
    const released = releaseCodexThread(first, h.time, oldOwner, pending.promise, report);
    const newOwner = acquireCodexThread(second, 'thread-shared');
    pending.resolve();
    expect(await released).toEqual({ kind: 'superseded' });
    expect(h.unsubscribes()).toBe(0);
    expect(report).not.toHaveBeenCalled();
    expect(await releaseCodexThread(second, h.time, newOwner, null, report)).toEqual({ kind: 'accepted' });
    expect(h.unsubscribes()).toBe(1);
  });

  it('preserves connection ownership through nested boundary wrappers', async () => {
    const h = releaseConnection();
    const first = wrapAppServerSession(h.raw, 'first');
    const second = wrapAppServerSession(first, 'nested');
    const owner = acquireCodexThread(first, 'thread-shared');
    acquireCodexThread(second, 'thread-shared');
    expect(first.closed).not.toBe(second.closed);
    expect(await releaseCodexThread(first, h.time, owner, null, vi.fn())).toEqual({ kind: 'superseded' });
    expect(h.unsubscribes()).toBe(0);
  });

  it('retires connection ownership when the transport closes', async () => {
    const h = releaseConnection();
    const owner = acquireCodexThread(h.raw, 'thread-shared');
    h.close();
    await flushMicrotasks(30);
    expect(await releaseCodexThread(h.raw, h.time, owner, null, vi.fn())).toEqual({ kind: 'superseded' });
    expect(h.unsubscribes()).toBe(0);
  });

  it('cancels deferred unsubscribe when the observation bound expires', async () => {
    const h = releaseConnection();
    const owner = acquireCodexThread(h.raw, 'thread-shared');
    const pending = createDeferred();
    const report = vi.fn();
    const released = releaseCodexThread(h.raw, h.time, owner, pending.promise, report);
    h.time.tick(1000);
    expect(await released).toMatchObject({ kind: 'unknown' });
    pending.resolve();
    await flushMicrotasks(30);
    expect(h.unsubscribes()).toBe(0);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('release unconfirmed'));
  });

  it('reports superseded at expiry when the old thread use is still pending', async () => {
    const h = releaseConnection();
    const owner = acquireCodexThread(h.raw, 'thread-shared');
    const pending = createDeferred();
    const report = vi.fn();
    const released = releaseCodexThread(h.raw, h.time, owner, pending.promise, report);
    acquireCodexThread(h.raw, 'thread-shared');
    h.time.tick(1000);
    expect(await released).toEqual({ kind: 'superseded' });
    pending.resolve();
    await flushMicrotasks(30);
    expect(h.unsubscribes()).toBe(0);
    expect(report).not.toHaveBeenCalled();
  });

  it('preserves the successor token when an earlier dispatched unsubscribe replies late', async () => {
    const h = releaseConnection();
    const reply = createDeferred<unknown>();
    const lease: AppServerSession = {
      ...h.raw,
      rpc: vi
        .fn()
        .mockImplementationOnce(() => reply.promise)
        .mockResolvedValue({ status: 'unsubscribed' }),
    };
    const owner = acquireCodexThread(lease, 'thread-shared');
    const oldRelease = releaseCodexThread(lease, h.time, owner, null, vi.fn());
    expect(lease.rpc).toHaveBeenCalledOnce();
    const successor = acquireCodexThread(lease, 'thread-shared');
    reply.resolve({ status: 'unsubscribed' });
    expect(await oldRelease).toEqual({ kind: 'accepted' });
    expect(await releaseCodexThread(lease, h.time, successor, null, vi.fn())).toEqual({ kind: 'accepted' });
    expect(lease.rpc).toHaveBeenCalledTimes(2);
  });

  it('keeps an already dispatched RPC unknown at expiry after a successor claims ownership', async () => {
    const h = releaseConnection();
    const reply = createDeferred<unknown>();
    const lease: AppServerSession = { ...h.raw, rpc: vi.fn(() => reply.promise) as AppServerSession['rpc'] };
    const report = vi.fn();
    const owner = acquireCodexThread(lease, 'thread-shared');
    const released = releaseCodexThread(lease, h.time, owner, null, report);
    expect(lease.rpc).toHaveBeenCalledOnce();
    acquireCodexThread(lease, 'thread-shared');
    h.time.tick(1000);
    expect(await released).toMatchObject({ kind: 'unknown' });
    expect(report).toHaveBeenCalledWith(expect.stringContaining('release unconfirmed'));
    reply.resolve({ status: 'unsubscribed' });
    await flushMicrotasks(30);
    expect(report).toHaveBeenCalledOnce();
  });
});
