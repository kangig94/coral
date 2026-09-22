import { currentCoralStoreFormat } from '#src/store-format.js';
// Transport is stubbed (no IPC bind, no HTTP listener) so the harness exercises the lifecycle/recovery contract
// end-to-end without process boundaries.
//
// Why a shared store: A single `Database` instance is reused across both cores — opening twice against the same
// SQLite file in one process is fragile; the journal is process-local already.

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { socketPathByteLimit } from '#src/infra/path/unix-socket.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import type {
  CoordinatorServerInfo,
  LifecycleShutdownDisposition,
  RunStartupRecoveryOrchestratorFn,
} from '#src/coordinator/lifecycle.js';
import type { ShutdownReason } from '#src/infra/shutdown-contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';
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
  cleanup(): Promise<LifecycleShutdownDisposition>;
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
  shutdown(reason: ShutdownReason): Promise<LifecycleShutdownDisposition>;
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
  /** Pins what booting cores observe about a recorded process. Startup retires a superseded record whose
   *  processes are all absent, so a test that boots with fixture pids is otherwise deciding its outcome
   *  from whatever the host happens to be running at those numbers. */
  observeLiveness?: Runtime['process']['observeLiveness'];
  /** Lengthens the home path until the tagged selector would relocate the coordinator socket, which is
   *  the only condition under which a published address differs from the derived one. */
  relocatedSocket?: boolean;
}

/** The tagged rule relocates when the run-dir socket reaches its byte limit, so the home has to carry the
 *  difference rather than a fixed pad that stops being enough when the temp root moves. */
function deepenPastTaggedSocketLimit(baseHomeDir: string): string {
  const suffixBytes = Buffer.byteLength(join('.coral', 'gen2', 'run', 'coordinator.sock'), 'utf8') + 1;
  const limit = socketPathByteLimit('linux');
  const shortfall = limit - (Buffer.byteLength(baseHomeDir, 'utf8') + suffixBytes);
  const deep = shortfall <= 0 ? baseHomeDir : join(baseHomeDir, 'd'.repeat(shortfall + 1));
  mkdirSync(deep, { recursive: true });
  return deep;
}

export function createHandoffCoresHarness(options: CreateHarnessOptions = {}): HandoffCoresHarness {
  const baseHomeDir = mkdtempSync(join(tmpdir(), 'coral-handoff-cores-'));
  const homeDir = options.relocatedSocket ? deepenPastTaggedSocketLimit(baseHomeDir) : baseHomeDir;
  const flavor = options.flavor ?? 'prod';
  const backendNamespace = 'handoff-cores';

  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const realRuntime = createRealRuntime(flavor);
  const runtime: Runtime =
    options.observeLiveness === undefined
      ? realRuntime
      : { ...realRuntime, process: { ...realRuntime.process, observeLiveness: options.observeLiveness } };
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  const db = openTestStoreDatabase({
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
        onFatalShutdownError: vi.fn(),
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
        settlePendingLaunchesFn: async () => ({ kind: 'all-pending-launches-settled' }),
        terminateRegisteredChildrenFn: async () => ({ kind: 'all-children-observed-absent' }),
        registerBuiltInProvidersFn: () => {},
        ...(opts.createExecutionService === undefined ? {} : { createExecutionService: opts.createExecutionService }),
        ...(opts.providerHostManager === undefined ? {} : { providerHostManager: opts.providerHostManager }),
        ...(opts.providerRegistry === undefined ? {} : { providerRegistry: opts.providerRegistry }),
        getConsumerStuck: () => [],
      },
      runStartupRecovery,
    );
    setStoreServicesForTest(core.storeServicesRef, storeServices);

    liveServers.push(core.server);

    const serverInfo = await core.lifecycleController.start();

    const booted: BootedCore = {
      core,
      serverInfo,
      shutdown: async (reason: ShutdownReason) => {
        if (core.runtimeState.getLifecycle() === 'stopped') return { disposition: 'finalized' };
        const disposition = await core.lifecycleController.shutdown(reason);
        if (disposition.disposition === 'held') return disposition;
        return core.lifecycleController.waitForShutdown();
      },
    };
    liveCores.push(booted);
    return booted;
  }

  async function cleanup(): Promise<LifecycleShutdownDisposition> {
    for (const booted of liveCores) {
      try {
        const disposition = await booted.shutdown('test-teardown');
        if (disposition.disposition === 'held') return disposition;
      } catch {
        // best-effort
      }
    }
    liveCores.splice(0);
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
    rmSync(baseHomeDir, { recursive: true, force: true });
    return { disposition: 'finalized' };
  }

  return { runtime, db, homeDir, bootCore, cleanup };
}
