import { currentCoralStoreFormat } from '#src/store-format.js';
// Transport is stubbed (no IPC bind, no HTTP listener) so the harness exercises the lifecycle/recovery contract
// end-to-end without process boundaries.
//
// Why a shared store: A single `Database` instance is reused across both cores — opening twice against the same
// SQLite file in one process is fragile; the journal is process-local already.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import type { CoordinatorServerInfo, RunStartupRecoveryOrchestratorFn } from '#src/coordinator/lifecycle.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { openStoreDatabase } from '#src/store/db.js';
import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';

export interface HandoffCoresHarness {
  readonly runtime: Runtime;
  readonly db: Database;
  readonly homeDir: string;
  bootCore(opts: BootCoreOptions): Promise<BootedCore>;
  cleanup(): Promise<void>;
}

export interface BootCoreOptions {
  instanceId: string;
  bundleHash?: string;
  backendNamespace?: string;
  createExecutionService?: CoordinatorCoreOptions['createExecutionService'];
  providerHostManager?: CoordinatorCoreOptions['providerHostManager'];
  providerRegistry?: CoordinatorCoreOptions['providerRegistry'];
  /**
   * Override the post-discuss-recovery startup phase. Called with the same
   * deps the production `runStartupRecoveryFn` receives; defaults to discuss
   * recovery only. Tests that need workflow or jobs recovery wire the extra
   * stages in here.
   */
  runStartupRecoveryFn?: RunStartupRecoveryOrchestratorFn;
}

export interface BootedCore {
  readonly core: CoordinatorCoreResult;
  readonly serverInfo: CoordinatorServerInfo;
  /** Drives the lifecycle to terminal `stopped`. `'replaced'` or `'sigterm'` ⇒ handoff mode. */
  shutdown(reason: string): Promise<void>;
}

function createHarnessStoreServices(runtime: Runtime, db: Database, namespace: string): CoordinatorStoreServices {
  return {
    storeDb: db,
    progressStore: new JobStore(namespace, runtime, createEventBodyCodec(), {
      db,
      reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
      providers: permissiveProviderLookupPort,
    }),
    consumerDriver: null,
  };
}

interface CreateHarnessOptions {
  flavor?: 'prod' | 'dev';
}

export function createHandoffCoresHarness(options: CreateHarnessOptions = {}): HandoffCoresHarness {
  const homeDir = mkdtempSync(join(tmpdir(), 'coral-handoff-cores-'));
  const flavor = options.flavor ?? 'prod';
  const backendNamespace = 'handoff-cores';

  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const runtime = createRealRuntime(flavor);
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: ':memory:',
    storage: runtime.storage,
  });

  const liveServers: Server[] = [];
  const liveCores: BootedCore[] = [];

  async function bootCore(opts: BootCoreOptions): Promise<BootedCore> {
    const coreNamespace = opts.backendNamespace ?? backendNamespace;
    const storeServices = createHarnessStoreServices(runtime, db, coreNamespace);
    const runStartupRecovery: RunStartupRecoveryOrchestratorFn =
      opts.runStartupRecoveryFn ??
      (async ({
        knownDiscussSources,
        getDiscussStoreForSource,
        getDiscussContext,
        createInvocationContext,
        signal,
        recoverPersistedDiscussFn,
      }) => {
        return recoverPersistedDiscussFn({
          knownDiscussSources,
          getDiscussStoreForSource,
          getDiscussContext,
          createInvocationContext,
          signal,
        });
      });

    const core = createCoordinatorCore(
      {
        storeFormat: currentCoralStoreFormat(),
        runtime,
        backendNamespace: coreNamespace,
        bootSnapshot: {
          // Strict-manifest shaped on purpose: startup now publishes an active-store selection, whose schema
          // pins SemVer, a UUID build set, and 16-hex bundle hashes. Production identity always satisfies that
          // (`resolveStrictBundleIdentity`), so a placeholder here would only be testing a shape production
          // never has.
          version: '1.0.0',
          buildSetId: '123e4567-e89b-42d3-a456-426614174000',
          bundleHash: opts.bundleHash ?? '0123456789abcdef',
          flavor,
          instanceId: opts.instanceId,
          token: `token-${opts.instanceId}`,
          now: () => Date.now(),
          log: () => {},
        },
        createStoreServicesFromDbFn: (openedDb) => {
          if (openedDb !== db) {
            openedDb.close();
          }
          return storeServices;
        },
        kbDaemonSupervisor: createMockKbDaemonSupervisor(),
        createServerFn: (handler) => createServer(handler),
        listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
        closeServerFn: async () => {},
        writeBackendInfoFn: () => {},
        removeBackendInfoIfOwnerFn: () => {},
        cleanupStaleJobsFn: () => {},
        markJobsAsErrorFn: () => {},
        terminateAllFn: () => {},
        registerBuiltInProvidersFn: () => {},
        ...(opts.createExecutionService === undefined ? {} : { createExecutionService: opts.createExecutionService }),
        ...(opts.providerHostManager === undefined ? {} : { providerHostManager: opts.providerHostManager }),
        ...(opts.providerRegistry === undefined ? {} : { providerRegistry: opts.providerRegistry }),
        getConsumerStuck: () => [],
      },
      runStartupRecovery,
    );
    setStoreServicesForTest(core.storeServicesRef, storeServices, { storeDbPath: ':memory:' });

    liveServers.push(core.server);

    const serverInfo = await core.lifecycleController.start();

    const booted: BootedCore = {
      core,
      serverInfo,
      shutdown: async (reason: string) => {
        if (core.runtimeState.getLifecycle() === 'stopped') return;
        await core.lifecycleController.shutdown(reason);
        await core.lifecycleController.waitForShutdown();
      },
    };
    liveCores.push(booted);
    return booted;
  }

  async function cleanup(): Promise<void> {
    for (const booted of liveCores.splice(0)) {
      try {
        await booted.shutdown('test-cleanup');
      } catch {
        // best-effort
      }
    }
    for (const server of liveServers.splice(0)) {
      try {
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } catch {
        // best-effort
      }
    }
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(homeDir, { recursive: true, force: true });
  }

  return { runtime, db, homeDir, bootCore, cleanup };
}
