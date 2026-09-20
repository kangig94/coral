import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CoordinatorCompositionModule from '#src/coordinator/composition/index.js';
import type { CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import type { LifecycleShutdownDisposition } from '#src/coordinator/lifecycle.js';

vi.mock('#src/coordinator/composition/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CoordinatorCompositionModule>();
  return { ...actual, createCoordinatorCore: vi.fn() };
});

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { createCoordinatorServer, type CoordinatorServerOptions } from '#src/coordinator/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const roots: string[] = [];

afterEach(() => {
  vi.mocked(createCoordinatorCore).mockReset();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

/**
 * Stands in for `createCoordinatorCore`'s real composition: only the members
 * `coordinator/index.ts`'s `shutdown`/`waitForShutdown` wrapper reads.
 */
function fakeCoordinatorCore(shutdownDisposition: () => Promise<LifecycleShutdownDisposition>): CoordinatorCoreResult {
  return {
    server: createServer(),
    lifecycleController: {
      start: vi.fn(),
      shutdown: vi.fn(shutdownDisposition),
      waitForShutdown: vi.fn(shutdownDisposition),
      requestShutdownRetry: vi.fn(),
      getRecoveryRegistry: vi.fn(() => null),
    },
    idleTimer: { stopWatching: vi.fn() },
    runtimeState: { getLifecycle: vi.fn(() => 'stopped') },
    storeServicesRef: { tryGet: () => null },
  } as unknown as CoordinatorCoreResult;
}

function buildServerOptions(disposeLifecycleReactor: () => Promise<void>): CoordinatorServerOptions {
  const home = mkdtempSync(join(tmpdir(), 'coral-shutdown-disposal-home-'));
  const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-shutdown-disposal-plugin-'));
  roots.push(home, pluginRoot);
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: 'shutdown-disposal', flavor: 'prod' }) + '\n',
    'utf-8',
  );
  vi.stubEnv('HOME', home);
  return {
    runtime: createRealRuntime('prod'),
    pluginRoot,
    kbDaemonSupervisor: createMockKbDaemonSupervisor(),
    recoverPersistedDiscussFn: async () => [],
    createServerFn: (handler) => createServer(handler),
    listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
    closeServerFn: async () => {},
    disposeLifecycleReactor,
  };
}

type RaceOutcome<T> = Readonly<{ kind: 'resolved'; value: T }> | Readonly<{ kind: 'timed-out' }>;

function raceAgainstTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
  return Promise.race([
    promise.then((value): RaceOutcome<T> => ({ kind: 'resolved', value })),
    new Promise<RaceOutcome<T>>((resolve) => setTimeout(() => resolve({ kind: 'timed-out' }), ms)),
  ]);
}

describe('coordinator controller lifecycle reactor disposal', () => {
  it('settles shutdown() promptly when lifecycle reactor disposal never settles', async () => {
    const disposeLifecycleReactor = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(createCoordinatorCore).mockReturnValue(fakeCoordinatorCore(async () => ({ disposition: 'finalized' })));

    const controller = createCoordinatorServer(buildServerOptions(disposeLifecycleReactor));
    const outcome = await raceAgainstTimeout(controller.shutdown('test-teardown'), 500);

    expect(outcome).toEqual({ kind: 'resolved', value: { disposition: 'finalized' } });
    // The abort/kickoff must still fire (it is the only trigger when the settlement ledger itself
    // never started this obligation), even though the controller does not wait on it.
    expect(disposeLifecycleReactor).toHaveBeenCalledTimes(1);
  });

  it('settles waitForShutdown() promptly when lifecycle reactor disposal never settles', async () => {
    const disposeLifecycleReactor = vi.fn(() => new Promise<void>(() => {}));
    vi.mocked(createCoordinatorCore).mockReturnValue(
      fakeCoordinatorCore(async () => ({ disposition: 'finalized-with-losses', undischarged: [] })),
    );

    const controller = createCoordinatorServer(buildServerOptions(disposeLifecycleReactor));
    const outcome = await raceAgainstTimeout(controller.waitForShutdown(), 500);

    expect(outcome).toEqual({
      kind: 'resolved',
      value: { disposition: 'finalized-with-losses', undischarged: [] },
    });
    expect(disposeLifecycleReactor).toHaveBeenCalledTimes(1);
  });
});
