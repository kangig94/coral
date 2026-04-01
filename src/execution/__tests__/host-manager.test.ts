import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderServerHandle } from '../engine.js';
import * as engineModule from '../engine.js';
import { DefaultProviderHostManager, hostKeyFromSpec } from '../host-manager.js';
import type { ProviderServerSpec } from '../../providers/types.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeProviderServerHandle(options?: {
  generation?: number;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  const closed = createDeferred<Error | void>();
  const request =
    options?.request ??
    (async (_method: string, _params: Record<string, unknown>) => {
      return {};
    });
  const requestMock = vi.fn((method: string, params: Record<string, unknown> = {}) => request(method, params));
  const notifyMock = vi.fn();
  const onNotificationMock = vi.fn((handler: (message: { method: string; params?: Record<string, unknown> }) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });
  const markExpectedCloseMock = vi.fn();
  const closeMock = vi.fn(async () => {
    closed.resolve();
  });

  return {
    handle: {
      pid: options?.generation ?? 1,
      child: {} as never,
      generation: options?.generation ?? 1,
      rpc: {
        request: requestMock as unknown as ProviderServerHandle['rpc']['request'],
        notify: notifyMock,
      },
      onNotification: onNotificationMock as unknown as ProviderServerHandle['onNotification'],
      closePromise: closed.promise,
      markExpectedClose: markExpectedCloseMock,
      close: closeMock,
    } satisfies ProviderServerHandle,
    requestMock,
    markExpectedCloseMock,
    closeMock,
    emitNotification: (message: { method: string; params?: Record<string, unknown> }) => {
      for (const handler of handlers) {
        handler(message);
      }
    },
    resolveClosed: () => {
      closed.resolve();
    },
  };
}

describe('ProviderHostManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('hostKeyFromSpec normalizes empty envs, sorts env entries, and separates incompatible hosts', () => {
    const base: ProviderServerSpec = {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace/a',
    };

    expect(hostKeyFromSpec(base)).toBe(
      hostKeyFromSpec({
        ...base,
        env: {},
      }),
    );
    expect(
      hostKeyFromSpec({
        ...base,
        env: {
          BETA: '2',
          ALPHA: '1',
        },
      }),
    ).toBe(
      hostKeyFromSpec({
        ...base,
        env: {
          ALPHA: '1',
          BETA: '2',
        },
      }),
    );
    expect(
      hostKeyFromSpec({
        ...base,
        cwd: '/workspace/b',
      }),
    ).not.toBe(hostKeyFromSpec(base));
    expect(
      hostKeyFromSpec({
        ...base,
        env: {
          ALPHA: 'different',
        },
      }),
    ).not.toBe(hostKeyFromSpec(base));
  });

  it('reuses one shared host and isolates incompatible codex hosts by spawn invariants', async () => {
    const manager = new DefaultProviderHostManager();
    const firstHandle = createFakeProviderServerHandle({ generation: 11 });
    const secondHandle = createFakeProviderServerHandle({ generation: 22 });
    const thirdHandle = createFakeProviderServerHandle({ generation: 33 });
    const spawnProviderServer = vi
      .spyOn(engineModule, 'spawnProviderServer')
      .mockResolvedValueOnce(firstHandle.handle)
      .mockResolvedValueOnce(secondHandle.handle)
      .mockResolvedValueOnce(thirdHandle.handle);

    const sharedSpec: ProviderServerSpec = {
      provider: 'claude',
      command: process.execPath,
      args: ['broker.js'],
      cwd: process.cwd(),
      shared: true,
    };
    const codexSpecA: ProviderServerSpec = {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace/a',
      env: { PROJECT: 'a' },
    };
    const codexSpecB: ProviderServerSpec = {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace/b',
      env: { PROJECT: 'b' },
    };

    const sharedLeaseA = await manager.acquireServer(sharedSpec);
    const sharedLeaseB = await manager.acquireServer(sharedSpec);
    const codexLeaseA = await manager.acquireServer(codexSpecA);
    const codexLeaseB = await manager.acquireServer(codexSpecB);

    expect(sharedLeaseA.generation).toBe(11);
    expect(sharedLeaseB.generation).toBe(11);
    expect(codexLeaseA.generation).toBe(22);
    expect(codexLeaseB.generation).toBe(33);
    expect(spawnProviderServer).toHaveBeenCalledTimes(3);

    sharedLeaseA.release();
    sharedLeaseB.release();
    codexLeaseA.release();
    codexLeaseB.release();
    await manager.shutdown();
  });

  it('borrows a live exclusive host only when the generation matches', async () => {
    const manager = new DefaultProviderHostManager();
    const server = createFakeProviderServerHandle({ generation: 41 });
    vi.spyOn(engineModule, 'spawnProviderServer').mockResolvedValue(server.handle);

    const spec: ProviderServerSpec = {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
    };

    const lease = await manager.acquireServer(spec);
    const borrowed = await manager.borrowLiveServer(spec, { serverGeneration: 41 });
    const mismatched = await manager.borrowLiveServer(spec, { serverGeneration: 99 });

    expect(borrowed).not.toBeNull();
    expect(mismatched).toBeNull();
    await expect(borrowed?.rpc('ping', { ok: true }) ?? Promise.reject(new Error('missing attachment'))).resolves.toEqual({});

    lease.release();
    await manager.shutdown();
  });

  it('uses shutdown capability metadata for graceful RPC shutdown before any signal fallback', async () => {
    const manager = new DefaultProviderHostManager();
    const server = createFakeProviderServerHandle({
      generation: 7,
      request: async (method) => {
        if (method === 'broker/shutdown') {
          server.resolveClosed();
        }
        return { ok: true };
      },
    });
    vi.spyOn(engineModule, 'spawnProviderServer').mockResolvedValue(server.handle);

    const spec: ProviderServerSpec = {
      provider: 'claude',
      command: process.execPath,
      args: ['broker.js'],
      cwd: process.cwd(),
      shared: true,
      shutdownCapability: {
        method: 'broker/shutdown',
        timeoutMs: 3_000,
      },
    };

    const lease = await manager.acquireServer(spec);
    lease.release();

    await manager.shutdown();

    expect(server.markExpectedCloseMock).toHaveBeenCalledTimes(1);
    expect(server.requestMock).toHaveBeenCalledWith('broker/shutdown', {});
    expect(server.closeMock).not.toHaveBeenCalled();
    const markOrder = server.markExpectedCloseMock.mock.invocationCallOrder.at(0);
    const rpcOrder = server.requestMock.mock.invocationCallOrder.at(0);
    expect(markOrder).toBeDefined();
    expect(rpcOrder).toBeDefined();
    expect(markOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(rpcOrder ?? Number.POSITIVE_INFINITY);
  });

  it('falls back to signal shutdown when no graceful shutdown capability is declared', async () => {
    const manager = new DefaultProviderHostManager();
    const server = createFakeProviderServerHandle({ generation: 9 });
    vi.spyOn(engineModule, 'spawnProviderServer').mockResolvedValue(server.handle);

    const spec: ProviderServerSpec = {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
    };

    const lease = await manager.acquireServer(spec);
    lease.release();

    await manager.shutdown();

    expect(server.markExpectedCloseMock).not.toHaveBeenCalled();
    expect(server.requestMock).not.toHaveBeenCalled();
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });

  it('starts Claude idle timeout from host/stats, cancels on activity and acquire, and shuts down after the TTL', async () => {
    vi.useFakeTimers();

    const manager = new DefaultProviderHostManager({ idleTimeoutMs: 25 });
    const server = createFakeProviderServerHandle({
      generation: 12,
      request: async (method) => {
        if (method === 'broker/shutdown') {
          server.resolveClosed();
        }
        return { ok: true };
      },
    });
    vi.spyOn(engineModule, 'spawnProviderServer').mockResolvedValue(server.handle);

    const spec: ProviderServerSpec = {
      provider: 'claude',
      command: process.execPath,
      args: ['broker.js'],
      cwd: process.cwd(),
      shared: true,
      shutdownCapability: {
        method: 'broker/shutdown',
        timeoutMs: 3_000,
      },
    };

    const lease = await manager.acquireServer(spec);
    lease.release();

    await vi.advanceTimersByTimeAsync(20);
    expect(server.requestMock).not.toHaveBeenCalled();

    server.emitNotification({
      method: 'host/stats',
      params: {
        liveControllers: 1,
        activeTurns: 1,
      },
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(server.requestMock).not.toHaveBeenCalled();

    server.emitNotification({
      method: 'host/stats',
      params: {
        liveControllers: 0,
        activeTurns: 0,
      },
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(server.requestMock).not.toHaveBeenCalled();

    const reacquired = await manager.acquireServer(spec);
    await vi.advanceTimersByTimeAsync(30);
    expect(server.requestMock).not.toHaveBeenCalled();

    reacquired.release();
    await vi.advanceTimersByTimeAsync(25);

    expect(server.requestMock).toHaveBeenCalledWith('broker/shutdown', {});
    expect(server.markExpectedCloseMock).toHaveBeenCalledTimes(1);
    expect(server.closeMock).not.toHaveBeenCalled();
  });

  it('uses CORAL_BROKER_IDLE_MS for Codex idle shutdown after the last lease is released', async () => {
    vi.useFakeTimers();
    vi.stubEnv('CORAL_BROKER_IDLE_MS', '15');

    const manager = new DefaultProviderHostManager();
    const server = createFakeProviderServerHandle({ generation: 13 });
    vi.spyOn(engineModule, 'spawnProviderServer').mockResolvedValue(server.handle);

    const spec: ProviderServerSpec = {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: '/workspace',
    };

    const firstLease = await manager.acquireServer(spec);
    const secondLeasePromise = manager.acquireServer(spec);

    firstLease.release();
    const secondLease = await secondLeasePromise;
    await vi.advanceTimersByTimeAsync(20);
    expect(server.closeMock).not.toHaveBeenCalled();

    secondLease.release();
    await vi.advanceTimersByTimeAsync(14);
    expect(server.closeMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(server.closeMock).toHaveBeenCalledTimes(1);
  });
});
