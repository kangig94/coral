// Sequential dual-core handoff harness for cross-domain integration tests.
//
// Composes two `createCoordinatorCore` instances against a SHARED real-fs runtime
// and a single SQLite store database. Transport is stubbed (no IPC bind, no HTTP
// listener) so the harness exercises the lifecycle/recovery contract end-to-end
// without process boundaries.
//
// Used by:
//   - discuss-handoff.test.ts (Phase G cross-domain coverage)
//   - workflow-handoff.test.ts (planned follow-up)
//
// Why a shared store: handoff semantics are about journal continuity. Core A
// writes events, Core A shuts down with `mode=handoff`, Core B opens against the
// same journal and its production-default recovery rebuilds in-memory state.
// A single `Database` instance is reused across both cores — opening twice
// against the same SQLite file in one process is fragile; the journal is
// process-local already.

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import type { CoordinatorServerInfo } from '#src/coordinator/lifecycle.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { openStoreDatabase } from '#src/store/db.js';
import { JobStore } from '#src/jobs/store.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
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
  /** Compose, start, and return a coordinator core sharing the harness's runtime + store. */
  bootCore(opts: BootCoreOptions): Promise<BootedCore>;
  cleanup(): Promise<void>;
}

export interface BootCoreOptions {
  instanceId: string;
  bundleHash?: string;
  createExecutionService?: CoordinatorCoreOptions['createExecutionService'];
  /**
   * Override the post-discuss-recovery startup phase. Called with the same
   * deps the production `runStartupRecoveryFn` receives; defaults to discuss
   * recovery only. Tests that need workflow or jobs recovery wire the extra
   * stages in here.
   */
  runStartupRecoveryFn?: NonNullable<CoordinatorCoreOptions['runStartupRecoveryFn']>;
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
    progressStore: new JobStore(namespace, runtime, createDefaultUpcasterRegistry(), {
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
    path: ':memory:',
    storage: runtime.storage,
  });

  const liveServers: Server[] = [];
  const liveCores: BootedCore[] = [];

  async function bootCore(opts: BootCoreOptions): Promise<BootedCore> {
    const storeServices = createHarnessStoreServices(runtime, db, backendNamespace);

    const core = createCoordinatorCore({
      runtime,
      backendNamespace,
      bootSnapshot: {
        version: 'test-version',
        bundleHash: opts.bundleHash ?? 'test-bundle',
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
      // Production default `discussRecovery.runStartup` runs because we don't override
      // `recoverPersistedDiscussFn`. The startup recovery shim below forwards into it.
      runStartupRecoveryFn:
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
        }),
      getConsumerStuck: () => [],
    });
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
