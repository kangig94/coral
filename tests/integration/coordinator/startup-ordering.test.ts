import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import * as jobsStartup from '#src/jobs/startup.js';
import type { JobsStartupContext } from '#src/jobs/startup.js';
import { ConsumerDriver } from '#src/projection-consumers/index.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import type { KbCorpusSnapshot as CorpusSnapshot } from '#src/kb/contract.js';
import { workflowRecover } from '#src/workflow/recover.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { LifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import { sessionContinuationLeaseRecordedEvent } from '#src/sessions/continuation-lease-events.js';
import { providerSessionSchema } from '#src/sessions/entry.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import type { Database } from '#src/store/db.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('coordinator startup ordering', () => {
  it('reconciles provider-operation sagas before generic jobs startup recovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-plugin-'));
    tempRoots.push(home, pluginRoot);

    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
      'utf-8',
    );

    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const order: string[] = [];
    const reconcileProviderOperations = vi
      .spyOn(ProviderOperationReconciler.prototype, 'reconcileAtStartup')
      .mockImplementation(async () => {
        order.push('providerOperationReconciler.reconcileAtStartup');
        return { setsVisited: 0, operationsVisited: 0, incidents: [] };
      });
    const startProviderOperationReconciler = vi
      .spyOn(ProviderOperationReconciler.prototype, 'start')
      .mockImplementation(() => {
        order.push('providerOperationReconciler.start');
      });
    const waitFreshUntil = vi.spyOn(ConsumerDriver.prototype, 'waitFreshUntil').mockImplementation(async () => {
      order.push('waitFreshUntil:start');
      await Promise.resolve();
      order.push('waitFreshUntil:resolved');
    });
    const runStartup = vi.fn(async (options: JobsStartupContext) => {
      order.push('jobsReconcile.runStartup');
      return options.progressStore;
    });
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockReturnValue(runStartup);
    const kbDaemonSupervisor = createMockKbDaemonSupervisor();

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      kbDaemonSupervisor,
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
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
      expect(reconcileProviderOperations).toHaveBeenCalledTimes(1);
      expect(startProviderOperationReconciler).toHaveBeenCalledTimes(1);
      // Three-era boot: journal `waitFreshUntil` (Era II) resolves BEFORE
      // `jobsReconcile.runStartup`.
      const firstWaitResolved = order.indexOf('waitFreshUntil:resolved');
      expect(firstWaitResolved).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('jobsReconcile.runStartup')).toBeGreaterThan(firstWaitResolved);
      expect(order.indexOf('providerOperationReconciler.reconcileAtStartup')).toBeLessThan(
        order.indexOf('jobsReconcile.runStartup'),
      );
      expect(order.indexOf('jobsReconcile.runStartup')).toBeLessThan(
        order.indexOf('providerOperationReconciler.start'),
      );
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
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
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
    const runStartup = vi.fn(async (options: JobsStartupContext) => {
      order.push('jobsReconcile.runStartup');
      return options.progressStore;
    });
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockReturnValue(runStartup);
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
    const kbDaemonSupervisor = createMockKbDaemonSupervisor({
      start: vi.fn(async () => {
        order.push('kbDaemonSupervisor.start');
        return kbDaemonSupervisor.read();
      }),
    });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      kbDaemonSupervisor,
      recoverPersistedDiscussFn,
      writeBackendInfoFn,
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => {
        order.push('listenFn (bind)');
        return { port: 0, host: '127.0.0.1' };
      },
      closeServerFn: async () => {},
    });

    try {
      await coordinator.start();
      order.push("setLifecycle('running')");
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
      await waitFor(() => order.includes('kbDaemonSupervisor.start'));
      // The KB daemon starts only after Era II recovery has completed and the
      // coordinator reaches running.
      expect(order.indexOf('jobsReconcile.runStartup')).toBeLessThan(order.indexOf('kbDaemonSupervisor.start'));
      // Era II ordering of recovery steps:
      expect(Math.max(...waitFreshOrder)).toBeLessThan(order.indexOf('jobsReconcile.runStartup'));
      expect(order.indexOf('jobsReconcile.runStartup')).toBeLessThan(order.indexOf('recoverPersistedDiscussFn'));
      expect(order.indexOf('recoverPersistedDiscussFn')).toBeLessThan(order.indexOf('workflowRecover.resumeAll'));
      // writeBackendInfoFn fires in Era I (BEFORE recovery):
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

  it('recovers a journal-written pending workflow replacement intent before lease expiry scanning', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-replacement-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-replacement-plugin-'));
    tempRoots.push(home, pluginRoot);
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
      'utf-8',
    );
    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const order: string[] = [];
    let startupDb: Database | null = null;
    let recoveryObservedPending = false;
    const runStartup = vi.fn(async (options: JobsStartupContext) => {
      order.push('jobsReconcile.runStartup');
      startupDb = options.progressStore.getDb();
      const opened = providerSessionSchema.parse({
        sessionId: 'pending-replacement-session',
        binding: TEST_CODEX_BINDING,
        name: 'pending-replacement-session',
        state: 'pending',
        retention: 'retain',
        artifactHandles: [],
        retentionDiscard: { attempts: [] },
        cwd: home,
        projectRoot: home,
        backendNamespace: 'startup-ordering',
        providerContinuity: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        lastUsedAt: '2026-07-22T00:00:00.000Z',
        version: 1,
      });
      options.coordinatorCommit((c) => {
        c.append({
          type: 'session.opened',
          stream: { kind: 'session', id: opened.sessionId },
          refs: { sessionId: opened.sessionId },
          body: { entry: opened, controller: 'default', scope_key: 'startup-ordering' },
        });
        return undefined;
      });
      const lease = {
        status: 'pending' as const,
        staleJobId: 'workflow-pending:0:0',
        workflowId: 'workflow-pending',
        workflowSlotId: 'workflow-pending:0:0',
        replacementGeneration: 1,
        reason: 'stale_recovery' as const,
        expiresAt: new Date(runtime.time.now() + 60_000).toISOString(),
        recordedAt: new Date(runtime.time.now()).toISOString(),
      };
      const pending = providerSessionSchema.parse({
        ...opened,
        continuationLease: lease,
        lastUsedAt: lease.recordedAt,
        version: 2,
      });
      options.coordinatorCommit((c) => {
        c.append(sessionContinuationLeaseRecordedEvent(pending, lease));
        return undefined;
      });
      return options.progressStore;
    });
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockReturnValue(runStartup);
    const resumeAll = vi.spyOn(workflowRecover, 'resumeAll').mockImplementation(async (options) => {
      order.push('workflowRecover.resumeAll');
      const row = options.db
        .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
        .get('pending-replacement-session');
      const entry = providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null'));
      expect(entry.continuationLease).toMatchObject({
        status: 'pending',
        workflowId: 'workflow-pending',
        replacementGeneration: 1,
      });
      recoveryObservedPending = true;
      return [];
    });
    const scanStartup = vi.spyOn(LifecycleReactor.prototype, 'scanStartup').mockImplementation(async () => {
      order.push('lifecycleReactor.scanStartup');
      expect(recoveryObservedPending).toBe(true);
      const row = startupDb
        ?.prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
        .get('pending-replacement-session');
      expect(providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null')).continuationLease?.status).toBe('pending');
    });
    const kbDaemonSupervisor = createMockKbDaemonSupervisor();
    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      kbDaemonSupervisor,
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });

    try {
      await coordinator.start();
      expect(order).toEqual(['jobsReconcile.runStartup', 'workflowRecover.resumeAll', 'lifecycleReactor.scanStartup']);
    } finally {
      runStartup.mockRestore();
      resumeAll.mockRestore();
      scanStartup.mockRestore();
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });

  it('starts the KB daemon without coordinator-side corpus replay', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-ordering-plugin-'));
    tempRoots.push(home, pluginRoot);

    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
      'utf-8',
    );

    vi.stubEnv('HOME', home);

    const runtime = createRealRuntime('prod');
    const order: string[] = [];
    const kbDaemonSupervisor = createMockKbDaemonSupervisor({
      start: vi.fn(async () => {
        order.push('kbDaemonSupervisor.start');
        return kbDaemonSupervisor.read();
      }),
      warmup: vi.fn(async () => {
        order.push('kbDaemonSupervisor.warmup');
        return kbDaemonSupervisor.read();
      }),
    });
    const register = vi.spyOn(ConsumerDriver.prototype, 'register');
    const notifyCorpus = vi
      .spyOn(ConsumerDriver.prototype, 'notifyCorpus')
      .mockImplementation((_snapshot: CorpusSnapshot) => {
        order.push('notifyCorpus');
      });

    const coordinator = createCoordinatorServer({
      runtime,
      pluginRoot,
      kbDaemonSupervisor,
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => {
        order.push('listenFn');
        return { port: 0, host: '127.0.0.1' };
      },
      closeServerFn: async () => {},
    });

    try {
      await coordinator.start();
      await waitFor(() => order.includes('kbDaemonSupervisor.start'));
      expect(notifyCorpus).not.toHaveBeenCalled();
      expect(register.mock.calls.some(([reg]) => reg.authority === 'corpus')).toBe(false);
      expect(order).toContain('listenFn');
      expect(order.indexOf('listenFn')).toBeLessThan(order.indexOf('kbDaemonSupervisor.start'));
      expect(kbDaemonSupervisor.warmup).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator.shutdown('test-cleanup');
      await coordinator.waitForShutdown();
    }
  });
});
