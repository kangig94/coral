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
import type { CoordinatorCoreOptions, CoordinatorCoreResult } from '#src/coordinator/composition/types.js';
import type { CoordinatorServerInfo } from '#src/coordinator/lifecycle.js';
import { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/coordinator/expansion/state.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { Database } from '#src/store/db.js';
import { openStoreDatabase } from '#src/store/db.js';
import { ensureStoreSchemasDir } from '#src/store/schema-loader.js';

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

function createMemoryExpansionState(rows: readonly ExpansionStateRow[] = []): ExpansionStateStore {
  const map = new Map(rows.map((row) => [row.id, row]));
  return {
    insert: (row: ExpansionStateRow) => {
      map.set(row.id, row);
    },
    delete: (id: string) => {
      map.delete(id);
    },
    list: () => [...map.values()],
    get: (id: string) => map.get(id),
  } as ExpansionStateStore;
}

interface CreateHarnessOptions {
  flavor?: 'prod' | 'dev';
}

export function createHandoffCoresHarness(options: CreateHarnessOptions = {}): HandoffCoresHarness {
  const homeDir = mkdtempSync(join(tmpdir(), 'coral-handoff-cores-'));
  const flavor = options.flavor ?? 'prod';

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
    schemasDir: ensureStoreSchemasDir(runtime.storage),
  });

  const liveServers: Server[] = [];
  const liveCores: BootedCore[] = [];

  async function bootCore(opts: BootCoreOptions): Promise<BootedCore> {
    const expansionLifecycle = new ExpansionLifecycleService({
      makeHost: () => {
        throw new Error('expansion makeHost should not be invoked in the handoff harness');
      },
      state: createMemoryExpansionState(),
      bundledLoaders: {},
      manifest: [],
      now: () => new Date('2026-04-27T00:00:00.000Z').toISOString(),
    });

    const core = createCoordinatorCore({
      runtime,
      bootSnapshot: {
        version: 'test-version',
        bundleHash: opts.bundleHash ?? 'test-bundle',
        flavor,
        instanceId: opts.instanceId,
        token: `token-${opts.instanceId}`,
        now: () => Date.now(),
        log: () => {},
      },
      storeDb: db,
      expansionLifecycleService: expansionLifecycle,
      createKbSubsystemFn: async () => {
        throw new Error('handoff-cores harness runs without a KB subsystem');
      },
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
      writeBackendInfoFn: () => {},
      removeBackendInfoIfOwnerFn: () => {},
      cleanupStaleJobsFn: () => {},
      markJobsAsErrorFn: () => {},
      terminateAllFn: () => {},
      registerBuiltInProvidersFn: () => {},
      // Production default `discussRecovery.runStartup` runs because we don't override
      // `recoverPersistedDiscussFn`. The startup recovery shim below forwards into it.
      runStartupRecoveryFn:
        opts.runStartupRecoveryFn ??
        (async ({
          knownDiscussSources,
          getDiscussStoreForSource,
          getDiscussContext,
          createInvocationContext,
          assertStartupStillActive,
          recoverPersistedDiscussFn,
        }) => {
          return recoverPersistedDiscussFn({
            knownDiscussSources,
            getDiscussStoreForSource,
            getDiscussContext,
            createInvocationContext,
            assertStartupStillActive,
          });
        }),
      getConsumerStuck: () => [],
      getMutationBlocked: () => ({ blocked: false }),
    });

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
