import { afterEach, vi } from 'vitest';
import { createDeferred } from '#tools/testing/deferred.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ProviderServerSpec } from '#src/providers/contract.js';
import type { DefaultProviderHostManager, ProviderHostEntry } from '#src/coordinator/live/provider-hosts/index.js';
import type { ProviderServerHandle, SpawnProviderServerFn } from '#src/coordinator/live/provider-server-transport.js';

export const runtime = createRealRuntime('prod');

type SharedProviderServerSpec = Extract<ProviderServerSpec, { leaseMode: 'shared' }>;
type ExclusiveProviderServerSpec = Extract<ProviderServerSpec, { leaseMode: 'job-exclusive' }>;

export function createSharedSpec(overrides: Partial<SharedProviderServerSpec> = {}): SharedProviderServerSpec {
  return {
    provider: 'claude',
    command: process.execPath,
    args: ['broker.js'],
    cwd: process.cwd(),
    leaseMode: 'shared',
    idlePolicy: 'host-stats',
    ...overrides,
  };
}

export function createExclusiveSpec(overrides: Partial<ExclusiveProviderServerSpec> = {}): ExclusiveProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: '/workspace',
    leaseMode: 'job-exclusive',
    ...overrides,
  };
}

export function createLaunch(spec: ProviderServerSpec): Parameters<DefaultProviderHostManager['openSession']>[0] {
  return spec;
}

export function createEntry(overrides: Partial<ProviderHostEntry> = {}): ProviderHostEntry {
  return {
    hostKey: 'host-key',
    identityKey: 'host-key',
    spec: createSharedSpec(),
    exactEnv: {},
    handle: null,
    instanceId: null,
    spawnPromise: null,
    pinCount: 0,
    closingError: null,
    closePromise: null,
    hostStats: { liveControllers: 0, activeTurns: 0 },
    idleTimer: null,
    disposeHostNotifications: null,
    ...overrides,
  };
}

export function createFakeProviderServerHandle(options?: {
  generation?: number;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  let isClosed = false;
  const handlers = new Set<(message: { method: string; params?: Record<string, unknown> }) => void>();
  const closed = createDeferred<Error | void>();
  const request =
    options?.request ??
    (async (_method: string, _params: Record<string, unknown>) => {
      return {};
    });
  const requestMock = vi.fn((method: string, params: Record<string, unknown> = {}) => request(method, params));
  const notifyMock = vi.fn();
  const onNotificationMock = vi.fn(
    (handler: (message: { method: string; params?: Record<string, unknown> }) => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  );
  const markExpectedCloseMock = vi.fn();
  const closeMock = vi.fn(async () => {
    isClosed = true;
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
      isClosed: () => isClosed,
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
      isClosed = true;
      closed.resolve();
    },
  };
}

export function createSpawnProviderServerMock(...handles: ProviderServerHandle[]) {
  const fallback = handles.at(-1);
  const spawnProviderServer = vi.fn(async (_options: Parameters<SpawnProviderServerFn>[0]) => {
    if (!fallback) {
      throw new Error('No provider server handle configured');
    }
    return fallback;
  });
  for (const handle of handles) {
    spawnProviderServer.mockResolvedValueOnce(handle);
  }
  return spawnProviderServer;
}

export function randomSequence(seed: number, maxLength = 50): number[] {
  let state = seed >>> 0;
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state;
  };
  const length = (next() % maxLength) + 1;
  return Array.from({ length }, () => next());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
