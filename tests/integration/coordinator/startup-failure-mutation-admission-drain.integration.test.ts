import type { ListenIpcServerResult } from '#src/transport/ipc/server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { createLifecycle, createRuntimeState } from '#src/coordinator/lifecycle.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { providerOperationMutationAdmission } from '#src/store/provider-operation-journal.js';

const NAMESPACE = 'startup-failure-mutation-admission-drain';
const PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'coral-startup-failure-mutation-admission-drain-'));

afterAll(() => {
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

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

describe('coordinator lifecycle startup-failure cleanup — provider operation mutation admission', () => {
  it('reaches socket close and discovery withdrawal when a provider operation mutation never settles', async () => {
    const runtime = createRealRuntime('prod', { baseDir: join(PROJECT_ROOT, '.coral') });
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const progressStore = new JobStore(NAMESPACE, runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    });

    const storeServicesRef = createStoreServicesRef();
    const storeServices = { storeDb: db, progressStore, consumerDriver: null };
    storeServicesRef.set(storeServices);
    const components = {
      register: vi.fn(),
      initAll: vi.fn(),
      disposeAll: vi.fn(async () => {}),
      list: vi.fn(() => []),
      status: vi.fn(() => null),
    };
    const runtimeState = createRuntimeState(0, components as never);
    const server = createServer();
    const instanceId = 'startup-failure-mutation-admission-drain';
    const closeServerFn = vi.fn(async () => {});
    const closeIpcServerFn = vi.fn(async () => {});
    const removeBackendInfoIfOwnerFn = vi.fn(() => {});
    const launchCoordinator = new LaunchCoordinator({ runtime });

    // Fires once discovery publication is attempted — after the admission has been acquired by startup
    // (`state.providerOperationMutationAdmission`) but before startup returns. It admits a mutation on that
    // same admission (keyed on `db`, the identical object startup acquired against) whose inner promise never
    // settles, then fails discovery publication so the catch block's cleanup runs with that mutation still
    // outstanding.
    const writeBackendInfoFn = vi.fn(() => {
      const admission = providerOperationMutationAdmission(db);
      void admission.run('test-outstanding-mutation', () => new Promise<void>(() => {}));
      return false;
    });

    const lifecycle = createLifecycle(
      {
        storeFormat: currentCoralStoreFormat(),
        identity: {
          pluginRoot: '/tmp/plugin',
          namespace: NAMESPACE,
          version: '1.0.0',
          buildSetId: '00000000-0000-4000-8000-000000000000',
          bundleHash: '0123456789abcdef',
          cliBundleHash: '0123456789abcdef',
          claudeAppserverBundleHash: '0123456789abcdef',
          durableWrapperBundleHash: '0123456789abcdef',
          flavor: 'prod',
          instanceId,
          token: 'test-token',
          bootToken: 'test-boot-token',
          shutdownToken: 'test-shutdown-token',
          now: () => runtime.time.now(),
          log: () => {},
        },
        runtime,
        backendPid: process.pid,
        runtimeState,
        idleTimer: {
          inflightRequests: 0,
          isDraining: false,
          beginRequest: vi.fn(),
          endRequest: vi.fn(),
          requestDrain: vi.fn(),
          startWatching: vi.fn(),
          stopWatching: vi.fn(),
        } as never,
        storeServicesRef,
        createStoreServicesFromDbFn: () => storeServices,
        streamResponses: new Set(),
        discussStores: new Map(),
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
        launchCoordinator,
        providerRegistry: {} as never,
        server,
        getExecutionService: vi.fn() as never,
        getRecoveryService: (() => {
          throw new Error('startup-failure-mutation-admission-drain test unexpectedly used recovery service');
        }) as never,
        listExecutionServices: () => [],
        getDiscussStoreForSource: vi.fn() as never,
        knownDiscussSources: () => new Set(),
        getDiscussContext: vi.fn() as never,
        writeBackendInfoFn,
        removeBackendInfoIfOwnerFn,
        cleanupStaleJobsFn: vi.fn(),
        markJobsAsErrorFn: vi.fn(),
        settlePendingLaunchesFn: vi.fn(async () => ({ kind: 'all-pending-launches-settled' }) as const),
        terminateRegisteredChildrenFn: vi.fn(async () => ({ kind: 'all-children-observed-absent' }) as const),
        providerHostManager: { drainForHandoff: vi.fn(), shutdown: vi.fn(async () => {}) } as never,
        handoffQuiescePorts: () => [],
        createKbHealthComponentFn: (() => {
          throw new Error('startup-failure-mutation-admission-drain test unexpectedly created a KB health component');
        }) as never,
        registerBuiltInProvidersFn: vi.fn(),
        recoverPersistedDiscussFn: vi.fn(async () => []),
        hooks: {
          onShutdown: vi.fn(async () => {}),
          onIdleCheck: () => false,
          onRecoveryComplete: vi.fn(async () => {
            throw new Error('startup-failure-mutation-admission-drain test unexpectedly reached recovery completion');
          }),
        },
        closeServerFn,
        listenFn: vi.fn(async () => ({ port: 0, host: '127.0.0.1' })),
        ipcServer: {} as never,
        closeIpcServerFn,
        listenIpcFn: vi.fn(
          async (): Promise<ListenIpcServerResult> => ({
            kind: 'bound',
            socketPath: runtime.paths.coral.coordinator.socketPath,
          }),
        ),
      },
      async () => {
        throw new Error('startup-failure-mutation-admission-drain test unexpectedly ran jobs startup');
      },
    );

    const errorSpy = vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    try {
      const outcome = await raceAgainstTimeout(lifecycle.start(), 5_000);

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') {
        throw new Error('startup-failure cleanup hung on the provider operation mutation admission drain');
      }
      expect(String(outcome.error)).toContain('Coordinator discovery publication failed');

      // The cleanup this drain used to block still runs even though the mutation never settled.
      expect(closeServerFn).toHaveBeenCalledTimes(1);
      expect(closeIpcServerFn).toHaveBeenCalledTimes(1);
      expect(removeBackendInfoIfOwnerFn).toHaveBeenCalledWith(instanceId);

      // What was not confirmed drained stays visible rather than being swallowed.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Provider operation mutation admission did not confirm drained during startup-failure cleanup',
        ),
      );
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test-outstanding-mutation'));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
