import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { RecoveryCapableService, ProviderRecoveryAuthority } from '#src/jobs/reconcile/contracts.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { createLifecycle, createRuntimeState } from '#src/coordinator/lifecycle.js';
import { KB_COMPONENT_ID } from '#src/coordinator/runtime-components/contract.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { providerOperationRecord } from '../../unit/store/provider-operation-fixtures.js';

const NAMESPACE = 'provider-operation-recovery-integration';
const PROJECT_ROOT = mkdtempSync(join(tmpdir(), 'coral-provider-operation-recovery-integration-'));

afterAll(() => {
  rmSync(PROJECT_ROOT, { recursive: true, force: true });
});

function seedQueuedProviderJob(progressStore: JobStore, jobId: string, sessionId: string): void {
  seedTestSessionProjection(progressStore.getDb(), {
    sessionId,
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    backendNamespace: NAMESPACE,
    activeJobId: jobId,
  });
  const launchRecord: JobLaunch = {
    jobId,
    owner: { kind: 'provider-session', id: sessionId },
    sessionId,
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    backendNamespace: NAMESPACE,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    providerAction: 'exec',
    request: { prompt: '', cwd: PROJECT_ROOT, bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-08-10T00:00:00.000Z',
  };
  progressStore.appendLaunchRequested(jobId, launchRecord);
  progressStore.commit((commit) => {
    commit.append({
      type: 'job.queue.queued',
      stream: { kind: 'job', id: jobId },
      namespace: NAMESPACE,
      project: PROJECT_ROOT,
      refs: { jobId, sessionId },
      body: { queuePosition: 1, runningJobIds: [] },
    });
    return undefined;
  });
}

describe('provider-operation startup recovery ownership', () => {
  it('computes admission after provider reconciliation and then runs generic recovery exactly once', async () => {
    const runtime = createRealRuntime('prod');
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const progressStore = new JobStore(NAMESPACE, runtime, createEventBodyCodec(), {
      db,
      providers: permissiveProviderLookupPort,
    });
    const jobId = randomUUID();
    const sessionId = randomUUID();
    seedQueuedProviderJob(progressStore, jobId, sessionId);

    const fixture = providerOperationRecord('prestart-cleanup-pending');
    const saga = providerOperationRecordSchema.parse({
      ...fixture,
      operation: { ...fixture.operation, jobId },
      afterRelease: { kind: 'local-authorized', reason: 'The remote operation never started.' },
    });
    if (saga.phase !== 'prestart-cleanup-pending') throw new Error('expected prestart cleanup saga');
    insertProviderOperation(db, saga);

    const recoverQueuedJob = vi.fn(async () => jobId);
    const recoveryService = {
      captureProviderRecoveryAuthority: vi.fn(async (launchRecord: JobLaunch) => ({
        ok: true,
        authority: {
          launchRecord,
          session: {
            sessionId: launchRecord.sessionId,
            providerContinuity: null,
            projectRoot: PROJECT_ROOT,
            version: 1,
          },
          boundProvider: { name: launchRecord.provider },
        } as unknown as ProviderRecoveryAuthority,
      })),
      finalizeInterruptedAppServerJob: vi.fn(async () => {}),
      finalizeInterruptedDurableJob: vi.fn(async () => {}),
      adoptRunningJob: vi.fn(async () => ({ adopted: true, cleanup: vi.fn() })),
      recoverQueuedJob,
      interruptAppServerJob: vi.fn(async () => {}),
      completeRecoveredJob: vi.fn(),
    } as RecoveryCapableService;
    const cancelOperation: DurableProviderProxyOperationAuthority['cancelOperation'] = async (
      operation,
      prepareAttemptNumber,
      prepareAttemptKey,
    ) => ({
      state: 'released-never-started',
      operation,
      prepareAttemptNumber,
      prepareAttemptKey,
    });
    const authority = {
      proxyInstanceId: saga.operation.proxyInstanceId,
      setIdentity: {
        buildSetId: saga.operation.buildSetId,
        hostFingerprint: saga.locator.hostFingerprint,
      },
      cancelOperation,
    } as unknown as DurableProviderProxyOperationAuthority;
    const reconciler = new ProviderOperationReconciler({
      getProgressStore: () => progressStore,
      authorityFor: () => authority,
      startupSetRecovery: { recoverSetAtStartup: async () => ({ kind: 'authority', authority }) },
      registry: { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() },
      materializePrepare: () => {
        throw new Error('startup ownership test unexpectedly materialized a prepare');
      },
      recoverLocalJob: async (record) => ({
        state: 'accepted',
        jobId: record.operation.jobId,
        owner: 'recovery-coordinator',
      }),
      completeLocalRecovery: vi.fn(),
      terminalization: {
        terminalize: () => {
          throw new Error('startup ownership test unexpectedly terminalized the saga');
        },
      },
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({}),
      backendNamespace: NAMESPACE,
      onFatal: (error) => {
        throw error;
      },
      time: runtime.time,
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
          flavor: 'prod',
          instanceId: 'provider-operation-recovery-integration',
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
        launchCoordinator: { active: 0, queueDepth: () => 0, terminateAll: vi.fn() } as never,
        providerRegistry: {} as never,
        server,
        getExecutionService: vi.fn() as never,
        getRecoveryService: () => recoveryService,
        listExecutionServices: () => [],
        connectProviderOperationRecovery: vi.fn(),
        reconcileProviderOperationsAtStartup: (signal) => reconciler.reconcileAtStartup(signal),
        startProviderOperationReconciler: vi.fn(),
        stopProviderOperationReconciler: vi.fn(),
        getDiscussStoreForSource: vi.fn() as never,
        knownDiscussSources: () => new Set(),
        getDiscussContext: vi.fn() as never,
        writeBackendInfoFn: vi.fn(),
        removeBackendInfoIfOwnerFn: vi.fn(),
        cleanupStaleJobsFn: vi.fn(),
        markJobsAsErrorFn: vi.fn(),
        terminateAllFn: vi.fn(),
        providerHostManager: { drainForHandoff: vi.fn(), shutdown: vi.fn(async () => {}) } as never,
        handoffQuiescePorts: () => [],
        createKbHealthComponentFn: () => ({
          id: KB_COMPONENT_ID,
          status: { id: KB_COMPONENT_ID, phase: 'initializing', attempt: 0 },
          init: async () => {},
          dispose: async () => {},
        }),
        registerBuiltInProvidersFn: vi.fn(),
        recoverPersistedDiscussFn: vi.fn(async () => []),
        hooks: {
          onShutdown: vi.fn(async () => {}),
          onIdleCheck: () => false,
          onRecoveryComplete: vi.fn(async () => {}),
        },
        closeServerFn: vi.fn(async () => {}),
        listenFn: vi.fn(async () => ({ port: 0, host: '127.0.0.1' })),
        ipcServer: {} as never,
        closeIpcServerFn: vi.fn(async () => {}),
        listenIpcFn: vi.fn(async () => ({ socketPath: runtime.paths.coral.coordinator.socketPath })),
      },
      async (inputs, runJobsStartup) => {
        await runJobsStartup({
          namespace: inputs.identity.namespace,
          bundleHash: inputs.identity.bundleHash,
          runtime: inputs.runtime,
          progressStore: inputs.progressStore,
          providerRegistry: inputs.providerRegistry,
          getRecoveryService: inputs.getRecoveryService,
          createInvocationContext: inputs.createInvocationContext,
          signal: inputs.signal,
          log: inputs.identity.log,
          coordinatorCommit: (callback) => inputs.progressStore.commit(callback),
          providerOperationStartupAdmission: inputs.providerOperationStartupAdmission,
        });
        return [];
      },
    );

    try {
      await lifecycle.start();

      expect({
        sagaPhase: readProviderOperation(db, saga.operation)?.phase ?? null,
        acceptedRecoveryAttempts: recoverQueuedJob.mock.calls.length,
      }).toEqual({ sagaPhase: null, acceptedRecoveryAttempts: 1 });
    } finally {
      await lifecycle.shutdown('test-complete');
    }
  });
});
