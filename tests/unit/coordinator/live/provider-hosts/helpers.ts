import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { afterEach, vi } from 'vitest';
import { createDeferred } from '#tools/testing/deferred.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ProviderServerSpec } from '#src/providers/contract.js';
import {
  DefaultProviderHostManager as ProductionProviderHostManager,
  type ProviderHostEntry,
} from '#src/coordinator/live/provider-hosts/index.js';
import type {
  ContainedProviderServerHandle,
  ProviderServerHandle,
  SpawnProviderServerFn,
} from '#src/providers/app-server-transport.js';
import type { RecordedContainmentIdentity } from '#src/infra/process-containment.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { EventEmitter } from 'node:events';

export const runtime = createRealRuntime('prod');

export const noCarrierBlocksRetirement = (): boolean => false;

export class StubbedContainmentProviderHostManager extends ProductionProviderHostManager {
  constructor(options: ConstructorParameters<typeof ProductionProviderHostManager>[0]) {
    super({ reapContainment: async () => {}, ...options });
  }
}

type SharedProviderServerSpec = Extract<ProviderServerSpec, { leaseMode: 'shared' }>;
type ExclusiveProviderServerSpec = Extract<ProviderServerSpec, { leaseMode: 'job-exclusive' }>;

export function createSharedSpec(overrides: Partial<SharedProviderServerSpec> = {}): SharedProviderServerSpec {
  return {
    provider: 'claude',
    command: process.execPath,
    args: ['broker.js'],
    cwd: fixtureCanonicalWorkDir(process.cwd()),
    leaseMode: 'shared',
    idleRetirement: 'unleased-and-host-idle',
    ...overrides,
  };
}

export function createExclusiveSpec(overrides: Partial<ExclusiveProviderServerSpec> = {}): ExclusiveProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: fixtureCanonicalWorkDir('/workspace'),
    leaseMode: 'job-exclusive',
    ...overrides,
  };
}

export function createLaunch(
  spec: ProviderServerSpec,
): Parameters<StubbedContainmentProviderHostManager['openSession']>[0] {
  return spec;
}

export function createEntry(overrides: Partial<ProviderHostEntry> = {}): ProviderHostEntry {
  return {
    hostKey: 'host-key',
    identityKey: 'host-key',
    spec: createSharedSpec(),
    exactEnv: {},
    handle: null,
    containment: null,
    instanceId: null,
    spawnPromise: null,
    spawnCleanupHold: null,
    spawnCleanupDisposition: null,
    spawnCleanupAttempts: 0,
    pins: new Map(),
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
  containmentIdentity?: RecordedContainmentIdentity;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  close?: () => Promise<void>;
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
  const pid = options?.generation ?? 1;
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: null,
    stdout: null,
    stderr: null,
    kill: () => true,
  });
  const observeClosed = (): void => {
    if (isClosed) return;
    isClosed = true;
    child.exitCode = 0;
    child.emit('exit', child.exitCode, child.signalCode);
    child.emit('close', 0, null);
    closed.resolve();
  };
  const finalizeClose = async (): ReturnType<ContainedProviderServerHandle['close']> => {
    await options?.close?.();
    observeClosed();
    return { kind: 'observed-absent', evidence: { subject: { kind: 'process', pid } } };
  };
  const closeMock = vi.fn(finalizeClose);
  const finishCloseAfterReapMock = vi.fn(async () => {
    if (!isClosed) await closeMock();
  });

  return {
    handle: {
      pid,
      child,
      generation: options?.generation ?? 1,
      containmentIdentity:
        options?.containmentIdentity ??
        Object.freeze({ pid, incarnation: testIncarnation(`1700000000-${pid}`), processGroupId: pid }),
      finishCloseAfterReap: finishCloseAfterReapMock,
      rpc: {
        request: requestMock as unknown as ProviderServerHandle['rpc']['request'],
        notify: notifyMock,
      },
      onNotification: onNotificationMock as unknown as ProviderServerHandle['onNotification'],
      closePromise: closed.promise,
      isClosed: () => isClosed,
      inspectDiagnostics: () => ({
        hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
        completedObservations: [],
        factsTruncatedBeforeSeq: 0,
      }),
      markExpectedClose: markExpectedCloseMock,
      close: closeMock,
    } satisfies ContainedProviderServerHandle,
    requestMock,
    markExpectedCloseMock,
    closeMock,
    finishCloseAfterReapMock,
    emitNotification: (message: { method: string; params?: Record<string, unknown> }) => {
      for (const handler of handlers) {
        handler(message);
      }
    },
    resolveClosed: () => {
      observeClosed();
    },
  };
}

export function createSpawnProviderServerMock(...handles: ContainedProviderServerHandle[]) {
  const fallback = handles.at(-1);
  const spawnProviderServer = vi.fn(async (...args: Parameters<SpawnProviderServerFn>) => {
    if (!fallback) {
      throw new Error('No provider server handle configured');
    }
    const handle = await Promise.resolve(fallback);
    args[3]?.(handle.containmentIdentity);
    return handle;
  });
  for (const handle of handles) {
    spawnProviderServer.mockImplementationOnce(async (...args: Parameters<SpawnProviderServerFn>) => {
      args[3]?.(handle.containmentIdentity);
      return handle;
    });
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
