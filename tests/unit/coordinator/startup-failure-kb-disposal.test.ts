import { describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { createLifecycle } from '#src/coordinator/lifecycle.js';
import type { KbDaemonDisposalSettlement } from '#src/coordinator/live/kb-daemon-supervisor.js';
import type { BackendInfoRemovalResult } from '#src/infra/backend-discovery.js';

type RaceOutcome<T> =
  | Readonly<{ kind: 'resolved'; value: T }>
  | Readonly<{ kind: 'rejected'; error: unknown }>
  | Readonly<{ kind: 'timed-out' }>;

function raceAgainstTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
  return Promise.race([
    promise.then(
      (value): RaceOutcome<T> => ({ kind: 'resolved', value }),
      (error: unknown): RaceOutcome<T> => ({ kind: 'rejected', error }),
    ),
    new Promise<RaceOutcome<T>>((resolve) => setTimeout(() => resolve({ kind: 'timed-out' }), ms)),
  ]);
}

/**
 * Builds just enough `createLifecycle` deps to reach `runLifecycleStartup`'s failure-cleanup path through a
 * deterministic, synchronous throw — a pre-injected store whose backing db reports a filesystem location,
 * which the startup guard rejects before any socket, IPC, or KB-daemon work begins. The cleanup that runs
 * after that throw is what this suite exercises, not the throw's own cause.
 */
function buildStartupFailureHarness(dispose: () => Promise<KbDaemonDisposalSettlement>) {
  let lifecycle: 'starting' | 'stopped' = 'starting';
  const closeServerFn = vi.fn(async () => {});
  const closeIpcServerFn = vi.fn(async () => {});
  const removeBackendInfoIfOwnerFn = vi.fn((): void | BackendInfoRemovalResult => {});
  const kbDaemonSupervisor = { dispose: vi.fn(dispose) };

  const deps = {
    identity: {
      pluginRoot: '/plugin',
      instanceId: 'startup-failure-kb-disposal',
      namespace: 'ns',
      version: '0.0.0-test',
      buildSetId: 'build-set',
      bundleHash: 'bundle',
      cliBundleHash: 'cli-bundle',
      claudeAppserverBundleHash: 'appserver-bundle',
      durableWrapperBundleHash: 'wrapper-bundle',
      flavor: 'prod',
      log: () => {},
      now: () => 0,
    },
    runtime: {
      paths: { coral: { coordinator: { socketPath: '/state/coordinator.sock' } } },
    },
    storeFormat: { fingerprint: 'fp' },
    backendPid: 4_242,
    runtimeState: {
      getLifecycle: () => lifecycle,
      setLifecycle: (next: typeof lifecycle) => {
        lifecycle = next;
      },
    },
    idleTimer: { stopWatching: () => {} },
    // A pre-injected, filesystem-backed store services ref is the earliest synchronous throw
    // `runLifecycleStartup` offers — reaching it needs nothing about the socket, IPC, or KB daemon.
    storeServicesRef: {
      tryGet: () => ({ storeDb: { location: () => '/fake/store.db' } }),
    },
    providerRegistry: {},
    registerBuiltInProvidersFn: () => {},
    server: {},
    closeServerFn,
    listenFn: async () => ({ host: '127.0.0.1', port: 0 }),
    // Truthy `ipcServer` with no `listenIpcFn` skips the handoff-bind path on the way in, while still
    // reaching the `ipcServer && closeIpcServerFn` cleanup branch on the way out through the catch block.
    ipcServer: {},
    closeIpcServerFn,
    kbDaemonSupervisor,
    removeBackendInfoIfOwnerFn,
    getDiscussStoreForSource: () => {
      throw new Error('unexpected discuss store lookup');
    },
    knownDiscussSources: () => new Set(),
    getDiscussContext: () => {
      throw new Error('unexpected discuss context lookup');
    },
    recoverPersistedDiscussFn: async () => [],
    hooks: {},
  } as never;

  const controller = createLifecycle(deps, async () => []);
  return { controller, closeServerFn, closeIpcServerFn, removeBackendInfoIfOwnerFn, kbDaemonSupervisor };
}

const HOLDING_DISPOSAL: Extract<KbDaemonDisposalSettlement, { kind: 'holding' }> = {
  kind: 'holding',
  snapshot: { enabled: true, phase: 'stopping', generation: 1, pid: 999, startedAt: 0, readyAt: null },
  reason: 'KB daemon process 999 has not been observed absent',
  exit: 'kb-daemon-process-close',
  // Never resolves: stands in for a `close` event a grandchild holding the daemon's stdio pipes open
  // can prevent from ever firing. The old code awaited this directly and hung forever.
  retryAfter: new Promise<void>(() => {}),
  retry: vi.fn(async (): Promise<KbDaemonDisposalSettlement> => {
    throw new Error('must not retry: startup-failure cleanup must attempt disposal exactly once');
  }),
};

describe('coordinator lifecycle startup-failure cleanup', () => {
  it('reaches socket close and discovery withdrawal when KB daemon disposal never confirms absence', async () => {
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    try {
      const harness = buildStartupFailureHarness(async () => HOLDING_DISPOSAL);

      const outcome = await raceAgainstTimeout(harness.controller.start(), 500);

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') throw new Error('startup-failure cleanup hung on the KB daemon disposal');
      expect(String(outcome.error)).toContain('Pre-injected lifecycle store must be non-filesystem-backed');

      // No retry loop: `dispose` is called exactly once, and its own `retry` is never reached.
      expect(harness.kbDaemonSupervisor.dispose).toHaveBeenCalledTimes(1);
      expect(HOLDING_DISPOSAL.retry).not.toHaveBeenCalled();

      // The cleanup this loop used to block still runs: the HTTP server, the IPC listener, and the
      // discovery record are all released even though the KB daemon never confirmed absence.
      expect(harness.closeServerFn).toHaveBeenCalledTimes(1);
      expect(harness.closeIpcServerFn).toHaveBeenCalledTimes(1);
      expect(harness.removeBackendInfoIfOwnerFn).toHaveBeenCalledWith('startup-failure-kb-disposal');

      // What was not confirmed stays visible rather than being swallowed.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('KB daemon disposal did not confirm absence during startup-failure cleanup'),
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(HOLDING_DISPOSAL.reason));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('still reaches cleanup when KB daemon disposal itself rejects', async () => {
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    try {
      const harness = buildStartupFailureHarness(async () => {
        throw new Error('daemon control channel closed');
      });

      const outcome = await raceAgainstTimeout(harness.controller.start(), 500);

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') throw new Error('startup-failure cleanup hung on the KB daemon disposal');
      expect(String(outcome.error)).toContain('Pre-injected lifecycle store must be non-filesystem-backed');

      expect(harness.closeServerFn).toHaveBeenCalledTimes(1);
      expect(harness.closeIpcServerFn).toHaveBeenCalledTimes(1);
      expect(harness.removeBackendInfoIfOwnerFn).toHaveBeenCalledWith('startup-failure-kb-disposal');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('KB daemon disposal during startup-failure cleanup failed'),
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('daemon control channel closed'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs a refused discovery withdrawal instead of discarding it', async () => {
    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    try {
      const harness = buildStartupFailureHarness(async () => HOLDING_DISPOSAL);
      harness.removeBackendInfoIfOwnerFn.mockReturnValue({
        kind: 'refused',
        detail: 'unlink failed: EACCES',
        error: { kind: 'error', name: 'Error', message: 'unlink failed: EACCES' },
      });

      const outcome = await raceAgainstTimeout(harness.controller.start(), 500);

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') throw new Error('startup-failure cleanup hung on the KB daemon disposal');

      expect(harness.removeBackendInfoIfOwnerFn).toHaveBeenCalledWith('startup-failure-kb-disposal');
      // A refused withdrawal must not vanish silently: the process exits leaving a discovery record naming a
      // dead instance, and this is the only place that says so.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('backend discovery withdrawal refused during startup-failure cleanup'),
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unlink failed: EACCES'));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
