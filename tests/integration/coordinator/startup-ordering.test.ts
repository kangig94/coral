import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import * as jobsStartup from '#src/jobs/startup.js';
import type { JobsStartupContext } from '#src/jobs/startup.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import { workflowRecover } from '#src/workflow/recover.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { sessionContinuationLeaseRecordedEvent } from '#src/sessions/continuation-lease-events.js';
import { providerSessionSchema } from '#src/sessions/entry.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';

import { LifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { RecoveryService } from '#src/coordinator/services/recovery/service.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { buildWorkflowPlan } from '#src/workflow/plan.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import * as storeEpochSweep from '#src/coordinator/composition/store-epoch-sweep-scheduler.js';
import * as storageRetention from '#src/coordinator/composition/storage-retention-scheduler.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';

const tempRoots: string[] = [];
const stopStoreWork: (() => Promise<void>)[] = [];

beforeEach(() => {
  const createSweep = storeEpochSweep.createStoreEpochSweepScheduler;
  vi.spyOn(storeEpochSweep, 'createStoreEpochSweepScheduler').mockImplementation((input) => {
    const scheduler = createSweep(input);
    stopStoreWork.push(scheduler.stop);
    return scheduler;
  });
  const createRetention = storageRetention.createStorageRetentionScheduler;
  vi.spyOn(storageRetention, 'createStorageRetentionScheduler').mockImplementation((input) => {
    const scheduler = createRetention(input);
    stopStoreWork.push(scheduler.stop);
    return scheduler;
  });
});

afterEach(async () => {
  for (const stop of stopStoreWork.splice(0)) await stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('coordinator pending workflow replacement recovery', () => {
  it.each([false, true])('recovers a queued workflow child with transferred=%s', async (transferred) => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-queued-workflow-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-queued-workflow-plugin-'));
    tempRoots.push(home, pluginRoot);
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
      'utf-8',
    );
    vi.stubEnv('HOME', home);
    const runtime = createRealRuntime('prod', { baseDir: home });
    const projectRoot = canonicalizeWorkDir(home, home);
    const workflowId = 'workflow-queued-child';
    const childId = '00000000-0000-4000-8000-000000000002';
    const sessionId = 'queued-workflow-session';
    let startupOptions: JobsStartupContext | undefined;
    const createJobsStartupRunner = jobsStartup.createJobsStartupRunner;
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockImplementation((runRecovery) => {
      const runStartup = createJobsStartupRunner(runRecovery);
      return async (options) => {
        startupOptions = options;
        const plan = buildWorkflowPlan(workflowId, parseExpression('architect -> critic'), {
          defaultProvider: 'codex',
        });
        options.coordinatorCommit((c) => {
          c.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_CODEX_SCOPE));
          return undefined;
        });
        const createdAt = new Date(runtime.time.now()).toISOString();
        options.progressStore.appendLaunchRequested(workflowId, {
          jobId: workflowId,
          owner: { kind: 'workflow', id: workflowId },
          sessionId: null,
          provider: null,
          projectRoot,
          backendNamespace: options.namespace,
          jobKind: 'workflow',
          pool: 'default',
          enqueueSequence: options.progressStore.nextEnqueueSequence(),
          request: { prompt: '', cwd: projectRoot, bypassPermissions: false, coralEnv: {} },
          createdAt,
        });
        options.coordinatorCommit((c) => {
          c.append({
            type: 'job.runtime.started',
            stream: { kind: 'job', id: workflowId },
            namespace: options.namespace,
            project: projectRoot,
            refs: { jobId: workflowId, workflowId },
            body: { transport: 'workflow', startedAt: createdAt },
          });
          return undefined;
        });
        seedTestSessionProjection(options.progressStore.getDb(), {
          sessionId,
          provider: 'codex',
          projectRoot,
          backendNamespace: options.namespace,
          activeJobId: childId,
        });
        options.progressStore.appendLaunchRequested(childId, {
          jobId: childId,
          owner: { kind: 'workflow', id: workflowId },
          sessionId,
          provider: 'codex',
          projectRoot,
          backendNamespace: options.namespace,
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: options.progressStore.nextEnqueueSequence(),
          providerAction: 'exec',
          parentWorkflowJobId: workflowId,
          workflowSlotId: plan.slots[0].slotId,
          workflowSlotGeneration: 0,
          request: { prompt: '', cwd: projectRoot, bypassPermissions: false, coralEnv: {} },
          createdAt,
        });
        options.coordinatorCommit((c) => {
          c.append({
            type: 'job.queue.queued',
            stream: { kind: 'job', id: childId },
            namespace: options.namespace,
            project: projectRoot,
            refs: { jobId: childId, sessionId },
            body: { queuePosition: 1, runningJobIds: [] },
          });
          return undefined;
        });
        expect(options.progressStore.readStatus(childId)?.phase).toBe('queued');
        const result = await runStartup({
          ...options,
          ...(transferred ? { transferredJobIds: new Set([childId]) } : {}),
        });
        expect(options.progressStore.readStatus(childId)).toMatchObject(
          transferred
            ? { phase: 'queued' }
            : {
                phase: 'error',
                result: { outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } } },
              },
        );
        const row = options.progressStore
          .getDb()
          .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
          .get(sessionId);
        expect(providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null')).activeJobId).toBe(
          transferred ? childId : undefined,
        );
        return result;
      };
    });
    const restoreQueued = vi.spyOn(LaunchCoordinator.prototype, 'restoreQueuedLaunch');
    const recoverQueued = vi.spyOn(RecoveryService.prototype, 'recoverQueuedJob');
    const executeQueued = vi.spyOn(LaunchOrchestrator.prototype, 'runRecoveredQueuedJob');
    const activate = vi.spyOn(OperationSupervisor.prototype, 'activate');
    const coordinator = createCoordinatorServer({
      onFatalShutdownError: vi.fn(),
      runtime,
      pluginRoot,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      recoverPersistedDiscussFn: async () => {},
      writeBackendInfoFn: () => true,
      removeBackendInfoIfOwnerFn: () => {},
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });

    try {
      await coordinator.start();
      if (startupOptions === undefined) throw new Error('Expected jobs startup recovery.');
      expect(startupOptions.progressStore.readStatus(workflowId)?.phase).toBe('error');
      const row = startupOptions.progressStore
        .getDb()
        .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
        .get(sessionId);
      expect(providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null')).activeJobId).toBe(
        transferred ? childId : undefined,
      );
      expect(restoreQueued).not.toHaveBeenCalled();
      expect(recoverQueued).not.toHaveBeenCalled();
      expect(executeQueued).not.toHaveBeenCalled();
      expect(activate).not.toHaveBeenCalled();
    } finally {
      await coordinator.shutdown('test-teardown');
      await coordinator.waitForShutdown();
    }
  });

  it('passes a journal-written pending replacement lease to workflow recovery', async () => {
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

    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const runStartup = vi.fn(async (options: JobsStartupContext) => {
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
      return { kind: 'complete', progressStore: options.progressStore } as const;
    });
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockReturnValue(runStartup);
    const recoverAll = vi.spyOn(workflowRecover, 'recoverAll').mockImplementation(async (options) => {
      const row = options.db
        .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
        .get('pending-replacement-session');
      const entry = providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null'));
      expect(entry.continuationLease).toMatchObject({
        status: 'pending',
        workflowId: 'workflow-pending',
        replacementGeneration: 1,
      });
      return [];
    });
    const kbDaemonSupervisor = createMockKbDaemonSupervisor();
    const coordinator = createCoordinatorServer({
      onFatalShutdownError: vi.fn(),
      runtime,
      pluginRoot,
      kbDaemonSupervisor,
      recoverPersistedDiscussFn: async () => {},
      writeBackendInfoFn: () => true,
      removeBackendInfoIfOwnerFn: () => {},
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });

    try {
      await coordinator.start();
      expect(recoverAll).toHaveBeenCalledOnce();
    } finally {
      recoverAll.mockRestore();
      await coordinator.shutdown('test-teardown');
      await coordinator.waitForShutdown();
    }
  });

  it('clears pending replacements without launching before the lifecycle reactor scans', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-startup-no-workflow-resume-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-startup-no-workflow-resume-plugin-'));
    tempRoots.push(home, pluginRoot);
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }) + '\n',
      'utf-8',
    );
    vi.stubEnv('HOME', home);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const projectRoot = canonicalizeWorkDir(home, home);
    const workflowId = 'workflow-pending';
    const childId = '00000000-0000-4000-8000-000000000001';
    const sessionId = 'pending-replacement-session';
    let startupOptions: JobsStartupContext | undefined;
    const order: string[] = [];
    vi.spyOn(jobsStartup, 'createJobsStartupRunner').mockReturnValue(async (options) => {
      startupOptions = options;
      const plan = buildWorkflowPlan(workflowId, parseExpression('architect'), { defaultProvider: 'codex' });
      options.coordinatorCommit((c) => {
        c.append(workflowPlanDeclaredEvent(workflowId, plan, TEST_CODEX_SCOPE));
        return undefined;
      });
      options.progressStore.appendLaunchRequested(workflowId, {
        jobId: workflowId,
        owner: { kind: 'workflow', id: workflowId },
        sessionId: null,
        provider: null,
        projectRoot,
        backendNamespace: options.namespace,
        jobKind: 'workflow',
        pool: 'default',
        enqueueSequence: options.progressStore.nextEnqueueSequence(),
        request: { prompt: '', cwd: projectRoot, bypassPermissions: false, coralEnv: {} },
        createdAt: new Date(runtime.time.now()).toISOString(),
      });
      options.coordinatorCommit((c) => {
        c.append({
          type: 'job.runtime.started',
          stream: { kind: 'job', id: workflowId },
          namespace: options.namespace,
          project: projectRoot,
          refs: { jobId: workflowId, workflowId },
          body: { transport: 'workflow', startedAt: new Date(runtime.time.now()).toISOString() },
        });
        return undefined;
      });
      seedTestSessionProjection(options.progressStore.getDb(), {
        sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: options.namespace,
        activeJobId: childId,
      });
      options.progressStore.appendLaunchRequested(childId, {
        jobId: childId,
        owner: { kind: 'workflow', id: workflowId },
        sessionId,
        provider: 'codex',
        projectRoot,
        backendNamespace: options.namespace,
        jobKind: 'provider',
        pool: 'default',
        enqueueSequence: options.progressStore.nextEnqueueSequence(),
        providerAction: 'exec',
        parentWorkflowJobId: workflowId,
        workflowSlotId: plan.slots[0].slotId,
        workflowSlotGeneration: 0,
        request: { prompt: '', cwd: projectRoot, bypassPermissions: false, coralEnv: {} },
        createdAt: new Date(runtime.time.now()).toISOString(),
      });
      commitJobTerminal(options.progressStore, childId, sessionId, {
        content: '',
        outcome: { kind: 'job_fault', fault: { kind: 'ghost_launch' } },
        durationMs: 0,
      });
      const row = options.progressStore
        .getDb()
        .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
        .get(sessionId);
      const entry = providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null'));
      const lease = {
        status: 'pending' as const,
        staleJobId: childId,
        workflowId,
        workflowSlotId: plan.slots[0].slotId,
        replacementGeneration: 1,
        reason: 'stale_recovery' as const,
        expiresAt: new Date(runtime.time.now() + 60_000).toISOString(),
        recordedAt: new Date(runtime.time.now()).toISOString(),
      };
      options.coordinatorCommit((c) => {
        c.append(
          sessionContinuationLeaseRecordedEvent(
            { ...entry, continuationLease: lease, version: entry.version + 1 },
            lease,
          ),
        );
        return undefined;
      });
      order.push('jobs-recovered');
      return { kind: 'complete', progressStore: options.progressStore } as const;
    });
    const scanStartup = LifecycleReactor.prototype.scanStartup;
    const scan = vi.spyOn(LifecycleReactor.prototype, 'scanStartup').mockImplementation(async function (
      this: LifecycleReactor,
      signal,
    ) {
      if (startupOptions === undefined) throw new Error('Expected jobs startup before lifecycle scan.');
      const row = startupOptions.progressStore
        .getDb()
        .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
        .get(sessionId);
      const entry = providerSessionSchema.parse(JSON.parse(row?.entry ?? 'null'));
      expect(entry.continuationLease).toMatchObject({ status: 'cleared', outcome: 'explicit_clear' });
      expect(startupOptions.progressStore.readStatus(workflowId)?.phase).toBe('error');
      order.push('lifecycle-scan');
      await scanStartup.call(this, signal);
    });
    const dispatch = vi.spyOn(ExecutionService.prototype, 'coralDispatch');
    const resume = vi.spyOn(ExecutionService.prototype, 'resume');
    const coordinator = createCoordinatorServer({
      onFatalShutdownError: vi.fn(),
      runtime,
      pluginRoot,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      recoverPersistedDiscussFn: async () => {},
      writeBackendInfoFn: () => true,
      removeBackendInfoIfOwnerFn: () => {},
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });
    try {
      await coordinator.start();
      expect(scan).toHaveBeenCalledOnce();
      expect(order).toEqual(['jobs-recovered', 'lifecycle-scan']);
      expect(dispatch).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await coordinator.shutdown('test-teardown');
      await coordinator.waitForShutdown();
    }
  });
});
