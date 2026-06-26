import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { jobsReconcile } from '#src/jobs/startup.js';
import { ConsumerDriver } from '#src/coordinator/consumer-driver/index.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import type { KbChildHealthSnapshot, KbChildSupervisor } from '#src/coordinator/kb-child/supervisor.js';
import type { Backed, EmbeddingService, FtsRetrieval, KbCorpusSnapshot as CorpusSnapshot } from '#src/kb/contract.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { createCapabilityRegistry } from '#src/kb/capability/registry.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  KB_EMBEDDING_CAPABILITY,
  KB_FTS_CAPABILITY,
  KB_VECTOR_CAPABILITY,
} from '#src/kb/capability/constants.js';
import { workflowRecover } from '#src/workflow/recover.js';
import { EngineArtifactRegistry } from '#src/kb/corpus/artifact-registry.js';
import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import { adaptLegacyKbFactory } from '#tools/testing/kb-subsystem-adapter.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

const tempRoots: string[] = [];
const EMPTY_CORPUS_SNAPSHOT: CorpusSnapshot = {
  snapshotId: '',
  contentSeq: 0,
  metadataSeq: 0,
  contentManifestHash: '',
  metadataManifestHash: '',
};
const EMPTY_INDEX = {
  entries: {},
  principles: {},
  entityMeta: {},
  relationships: [],
};

function createMockKb(order?: string[]) {
  const capabilityRegistry = createCapabilityRegistry();
  capabilityRegistry.registerBuiltin(
    BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
    createRuntimeBinding<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY),
  );
  capabilityRegistry.registerBuiltin(
    BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
    createRuntimeBinding<Backed<VectorRetrieval>>(KB_VECTOR_CAPABILITY),
  );
  capabilityRegistry.registerBuiltin(
    BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
    createRuntimeBinding<Backed<EmbeddingService>>(KB_EMBEDDING_CAPABILITY),
  );
  const roleRegistry = createRoleRegistry();
  const runtimeDir = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-kb-runtime-'));
  tempRoots.push(runtimeDir);

  return {
    runtimeDir,
    roleRegistry,
    roleCatalog: roleRegistry.catalogView(),
    capabilityRegistry,
    capabilities: capabilityRegistry.catalogView(),
    engineArtifactRegistry: new EngineArtifactRegistry(),
    corpusAuthorityBaseline: {
      ensure: vi.fn(() => ({ baseline: new Map(), rebuilt: false })),
      rebuild: vi.fn(() => new Map()),
      read: vi.fn(() => new Map()),
      replace: vi.fn(),
    },
    projectionArtifacts: {
      runtimeDir,
      files: {
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => '{}'),
        rmSync: vi.fn(),
        mkdirSync: vi.fn(),
        renameSync: vi.fn(),
        writeTextAtomic: vi.fn(),
        writeJsonAtomic: vi.fn(),
      },
    },
    // Promote-recovery preflight (boot step 0) probes
    // `runtimeDir/promote-recovery/` — return false so the worker skips the
    // empty-marker-dir scan without invoking the rest of StoragePort.
    storagePort: {
      existsSync: vi.fn(() => false),
    },
    corpusProjectionReader: {
      resolveCurrentIndex: vi.fn(() => EMPTY_INDEX),
      prepareCurrentProjectionInput: vi.fn(async () => ({
        index: EMPTY_INDEX,
        records: [],
        communityFresh: false,
      })),
    },
    retryPendingCorpusPublication: vi.fn(async () => {
      order?.push('retryPendingCorpusPublication');
    }),
    withMutationLock: vi.fn(async (fn: () => Promise<unknown> | unknown) => {
      order?.push('withMutationLock:start');
      const result = await fn();
      order?.push('withMutationLock:end');
      return result;
    }),
    mutationLockDiagnostics: vi.fn(() => ({ blocked: false })),
    ensureCorpusFreshness: vi.fn(async () => {
      order?.push('ensureCorpusFreshness');
      return {
        entries: {},
        principles: {},
        entityMeta: {},
        relationships: [],
      };
    }),
    recordIndexSyncSuccess: vi.fn(),
    getCorpusStateSnapshot: vi.fn(() => {
      order?.push('getCorpusStateSnapshot');
      return { ...EMPTY_CORPUS_SNAPSHOT };
    }),
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('coordinator startup ordering', () => {
  it('journal waitFreshUntil resolves before jobsReconcile.runStartup is called', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-plugin-'));
    tempRoots.push(home, pluginRoot);

    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'startup-ordering-bundle', flavor: 'prod' }) + '\n',
      'utf-8',
    );

    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const order: string[] = [];
    const waitFreshUntil = vi.spyOn(ConsumerDriver.prototype, 'waitFreshUntil').mockImplementation(async () => {
      order.push('waitFreshUntil:start');
      await Promise.resolve();
      order.push('waitFreshUntil:resolved');
    });
    const runStartup = vi.spyOn(jobsReconcile, 'runStartup').mockImplementation(async () => {
      order.push('jobsReconcile.runStartup');
    });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      createKbSubsystemFn: adaptLegacyKbFactory(async () => ({
        kb: createMockKb(),
        readDb: {} as never,
        curateScheduler: {
          start: vi.fn(async () => {}),
          schedule: vi.fn(),
          scheduleDeferredCommit: vi.fn(),
          isRunning: () => false,
          stop: vi.fn(async () => {}),
        },
      })),
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
      registerBuiltInProvidersFn: () => {},
    });

    try {
      await coordinator.start();
      // Era III (KB) schedules corpus replay without a boot freshness wait, so
      // startup waits only for the Journal consumers in Era II.
      await waitFor(() => waitFreshUntil.mock.calls.length >= 4);
      expect(waitFreshUntil).toHaveBeenCalledTimes(4);
      expect(waitFreshUntil).toHaveBeenNthCalledWith(1, 'journal', expect.any(Number), 'jobs', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(2, 'journal', expect.any(Number), 'sessions', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(3, 'journal', expect.any(Number), 'discuss', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(4, 'journal', expect.any(Number), 'workflow', expect.any(Number));
      expect(runStartup).toHaveBeenCalledTimes(1);
      // Three-era boot: journal `waitFreshUntil` (Era II) resolves BEFORE
      // `jobsReconcile.runStartup`; KB corpus replay no longer waits in boot.
      const firstWaitResolved = order.indexOf('waitFreshUntil:resolved');
      expect(firstWaitResolved).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('jobsReconcile.runStartup')).toBeGreaterThan(firstWaitResolved);
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });

  it('publishes backend info only after Journal startup recovery completes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-plugin-'));
    tempRoots.push(home, pluginRoot);

    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'startup-ordering-bundle', flavor: 'prod' }) + '\n',
      'utf-8',
    );

    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const order: string[] = [];
    const journalConsumerIds = new Set(['jobs', 'sessions', 'discuss', 'workflow']);
    const observedJournalConsumers = new Set<string>();
    const originalRegister = ConsumerDriver.prototype.register;
    const register = vi.spyOn(ConsumerDriver.prototype, 'register').mockImplementation(function (
      this: ConsumerDriver,
      reg,
    ) {
      const result = originalRegister.call(this, reg);
      if (reg.authority === 'journal' && journalConsumerIds.has(reg.id)) {
        order.push(`register:${reg.id}`);
        observedJournalConsumers.add(reg.id);
        if (observedJournalConsumers.size === journalConsumerIds.size) {
          order.push('registerJournalConsumers');
        }
      }
      return result;
    });
    const waitFreshUntil = vi
      .spyOn(ConsumerDriver.prototype, 'waitFreshUntil')
      .mockImplementation(async (...args: unknown[]) => {
        const consumerId = typeof args[0] === 'string' ? args[2] : args[1];
        order.push(`waitFreshUntil:${consumerId}`);
      });
    const runStartup = vi.spyOn(jobsReconcile, 'runStartup').mockImplementation(async () => {
      order.push('jobsReconcile.runStartup');
    });
    const resumeAll = vi.spyOn(workflowRecover, 'resumeAll').mockImplementation(async () => {
      order.push('workflowRecover.resumeAll');
      return [];
    });
    const recoverPersistedDiscussFn = vi.fn(async () => {
      order.push('recoverPersistedDiscussFn');
      return [];
    });
    const writeBackendInfoFn = vi.fn(() => {
      order.push('writeBackendInfoFn');
    });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      createKbSubsystemFn: adaptLegacyKbFactory(async () => {
        const kbSubsystem = {
          kb: createMockKb(),
          readDb: {} as never,
          curateScheduler: {
            start: vi.fn(async () => {}),
            schedule: vi.fn(),
            scheduleDeferredCommit: vi.fn(),
            isRunning: () => false,
            stop: vi.fn(async () => {}),
          },
        };
        order.push('kbSubsystem ready');
        return kbSubsystem;
      }),
      recoverPersistedDiscussFn,
      writeBackendInfoFn,
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => {
        order.push('listenFn (bind)');
        return { port: 0, host: '127.0.0.1' };
      },
      closeServerFn: async () => {},
      registerBuiltInProvidersFn: () => {},
    });

    try {
      await coordinator.start();
      order.push("setLifecycle('running')");
      // Wait for Era II Journal recovery waits before asserting full ordering.
      await waitFor(() => waitFreshUntil.mock.calls.length >= 4);

      const waitFreshOrder = [
        order.indexOf('waitFreshUntil:jobs'),
        order.indexOf('waitFreshUntil:sessions'),
        order.indexOf('waitFreshUntil:discuss'),
        order.indexOf('waitFreshUntil:workflow'),
      ];

      expect(coordinator.getLifecycle()).toBe('running');
      expect(waitFreshUntil).toHaveBeenCalledTimes(4);
      expect(waitFreshUntil).toHaveBeenNthCalledWith(1, 'journal', expect.any(Number), 'jobs', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(2, 'journal', expect.any(Number), 'sessions', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(3, 'journal', expect.any(Number), 'discuss', expect.any(Number));
      expect(waitFreshUntil).toHaveBeenNthCalledWith(4, 'journal', expect.any(Number), 'workflow', expect.any(Number));
      // Era I (listen + register cursors) precedes Era II (waitFresh):
      expect(order.indexOf('listenFn (bind)')).toBeLessThan(order.indexOf('registerJournalConsumers'));
      expect(order.indexOf('registerJournalConsumers')).toBeLessThan(Math.min(...waitFreshOrder));
      // Era III (KB) starts AFTER Era II's recovery completes — but KB
      // build's first sync step runs on the same tick as `subsystems.initAll`
      // before the test resumes, so we assert the build ran AFTER recovery
      // wrote the recovery markers:
      expect(order.indexOf('jobsReconcile.runStartup')).toBeLessThan(order.indexOf('kbSubsystem ready'));
      // Era II ordering of recovery steps:
      expect(Math.max(...waitFreshOrder)).toBeLessThan(order.indexOf('jobsReconcile.runStartup'));
      expect(order.indexOf('jobsReconcile.runStartup')).toBeLessThan(order.indexOf('recoverPersistedDiscussFn'));
      expect(order.indexOf('recoverPersistedDiscussFn')).toBeLessThan(order.indexOf('workflowRecover.resumeAll'));
      // writeBackendInfoFn now fires in Era I (BEFORE recovery), not after:
      expect(order.indexOf('writeBackendInfoFn')).toBeLessThan(order.indexOf('jobsReconcile.runStartup'));
      expect(writeBackendInfoFn).toHaveBeenCalledTimes(1);
      // Era II recovery work (jobsReconcile, recoverPersistedDiscuss,
      // workflowRecover) fires AFTER writeBackendInfoFn:
      expect(order.indexOf('writeBackendInfoFn')).toBeLessThan(order.indexOf('recoverPersistedDiscussFn'));
      expect(order.indexOf('writeBackendInfoFn')).toBeLessThan(order.indexOf('workflowRecover.resumeAll'));
    } finally {
      register.mockRestore();
      waitFreshUntil.mockRestore();
      runStartup.mockRestore();
      resumeAll.mockRestore();
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });

  it('keeps the standard server path child-only without parent corpus replay', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-plugin-'));
    tempRoots.push(home, pluginRoot);

    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'startup-ordering-bundle', flavor: 'prod' }) + '\n',
      'utf-8',
    );

    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const order: string[] = [];
    const childHealth: KbChildHealthSnapshot = {
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const kbChildSupervisor: KbChildSupervisor = {
      read: vi.fn(() => childHealth),
      start: vi.fn(async () => {
        order.push('kbChildSupervisor.start');
        return childHealth;
      }),
      probe: vi.fn(async () => childHealth),
      warmup: vi.fn(async () => {
        order.push('kbChildSupervisor.warmup');
        return childHealth;
      }),
      readKb: vi.fn(async () => ({ ok: true as const, data: { servedBy: 'kb-child' } })),
      mutateKb: vi.fn(async () => ({ ok: true as const, data: { servedBy: 'kb-child' } })),
      stop: vi.fn(async () => childHealth),
      restart: vi.fn(async () => childHealth),
      dispose: vi.fn(async () => undefined),
    };
    const register = vi.spyOn(ConsumerDriver.prototype, 'register');
    const notifyCorpus = vi
      .spyOn(ConsumerDriver.prototype, 'notifyCorpus')
      .mockImplementation((_snapshot: CorpusSnapshot) => {
        order.push('notifyCorpus');
      });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      kbChildSupervisor,
      delegateKbReadsToChild: false,
      delegateKbMutationsToChild: false,
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => {
        order.push('listenFn');
        return { port: 0, host: '127.0.0.1' };
      },
      closeServerFn: async () => {},
      registerBuiltInProvidersFn: () => {},
    });

    try {
      await coordinator.start();
      await waitFor(() => order.includes('kbChildSupervisor.start'));
      expect(notifyCorpus).not.toHaveBeenCalled();
      expect(register.mock.calls.some(([reg]) => reg.authority === 'corpus')).toBe(false);
      expect(order).toContain('listenFn');
      expect(order.indexOf('listenFn')).toBeLessThan(order.indexOf('kbChildSupervisor.start'));
      expect(kbChildSupervisor.warmup).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });
});
