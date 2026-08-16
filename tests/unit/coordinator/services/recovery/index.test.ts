import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { createBoundJobsRecoveryHarness } from '#tests/helpers/bound-jobs-recovery.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { JobStore } from '#src/jobs/store.js';
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import type { RecoveryCapableService, ProviderRecoveryAuthority } from '#src/jobs/reconcile/contracts.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { encodeProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';

import { providerOperationRecord } from '../../../store/provider-operation-fixtures.js';

const NAMESPACE = 'inherited-abort-tests';
const PROJECT_ROOT = '/tmp/coral-inherited-abort-project';
const BACKEND_NAMESPACE = NAMESPACE;

function createProgressStore(runtime: ReturnType<typeof createRealRuntime>): JobStore {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return new JobStore(NAMESPACE, runtime, createEventBodyCodec(), { db, providers: permissiveProviderLookupPort });
}

function seedQueuedProviderJob(
  progressStore: JobStore,
  options: { jobId: string; sessionId: string; enqueueSequence: number },
): void {
  seedTestSessionProjection(progressStore.getDb(), {
    sessionId: options.sessionId,
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    backendNamespace: BACKEND_NAMESPACE,
    activeJobId: options.jobId,
  });
  const launchRecord: JobLaunch = {
    jobId: options.jobId,
    owner: { kind: 'provider-session', id: options.sessionId },
    sessionId: options.sessionId,
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    backendNamespace: BACKEND_NAMESPACE,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: options.enqueueSequence,
    providerAction: 'exec',
    request: { prompt: '', cwd: PROJECT_ROOT, bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-04-27T00:00:00.000Z',
  };
  progressStore.appendLaunchRequested(options.jobId, launchRecord);
  progressStore.commit((commit) => {
    commit.append({
      type: 'job.queue.queued',
      stream: { kind: 'job', id: options.jobId },
      namespace: BACKEND_NAMESPACE,
      project: PROJECT_ROOT,
      refs: { jobId: options.jobId, sessionId: options.sessionId },
      body: { queuePosition: options.enqueueSequence, runningJobIds: [] },
    });
    return undefined;
  });
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function seedRunningAppServerJob(
  progressStore: JobStore,
  options: { jobId: string; sessionId: string; provider: string; proxyInstanceId: string },
): void {
  seedTestSessionProjection(progressStore.getDb(), {
    sessionId: options.sessionId,
    provider: options.provider,
    projectRoot: PROJECT_ROOT,
    backendNamespace: BACKEND_NAMESPACE,
    activeJobId: options.jobId,
  });
  const launchRecord: JobLaunch = {
    jobId: options.jobId,
    owner: { kind: 'provider-session', id: options.sessionId },
    sessionId: options.sessionId,
    provider: options.provider,
    projectRoot: PROJECT_ROOT,
    backendNamespace: BACKEND_NAMESPACE,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: { prompt: '', cwd: PROJECT_ROOT, bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-04-27T00:00:00.000Z',
  };
  progressStore.appendLaunchRequested(options.jobId, launchRecord);
  progressStore.appendRuntimeStarted(options.jobId, {
    transport: 'app-server',
    startTime: '2026-04-27T00:00:00.000Z',
    providerMeta: {
      provider: options.provider,
      leaseState: 'acquired',
      hostRef: {
        provider: 'test',
        fingerprint: '0'.repeat(64),
        instanceId: options.proxyInstanceId,
        leaseMode: 'shared',
      },
    },
  });
}

function committedOperation(overrides: {
  jobId: string;
  operationId: string;
  proxyInstanceId: string;
}): ProviderOperationRecord {
  const fixture = providerOperationRecord('executing');
  if (fixture.phase !== 'executing') throw new Error('executing fixture failed validation');
  return providerOperationRecordSchema.parse({
    ...fixture,
    operation: {
      jobId: overrides.jobId,
      operationId: overrides.operationId,
      proxyInstanceId: overrides.proxyInstanceId,
      buildSetId: randomUUID(),
    },
    locator: {
      ...fixture.locator,
      proxy: { ...fixture.locator.proxy, instanceId: overrides.proxyInstanceId },
    },
    activationAck: {
      ...fixture.activationAck,
      hostRef: { ...fixture.activationAck.hostRef, ownerJobId: overrides.jobId },
    },
  });
}

function createFakeService(overrides: Partial<RecoveryCapableService> = {}): RecoveryCapableService {
  return {
    captureProviderRecoveryAuthority: vi.fn(async (launchRecord: JobLaunch) => ({
      ok: true,
      authority: {
        launchRecord,
        session: { sessionId: launchRecord.sessionId, providerContinuity: null, projectRoot: PROJECT_ROOT, version: 1 },
        boundProvider: { name: launchRecord.provider },
      } as unknown as ProviderRecoveryAuthority,
    })),
    finalizeProviderRecoveryBindingFailure: vi.fn(),
    finalizeInterruptedAppServerJob: vi.fn(async () => {}),
    finalizeInterruptedDurableJob: vi.fn(async () => {}),
    adoptRunningJob: vi.fn(async () => ({ adopted: true, cleanup: vi.fn() })),
    recoverQueuedJob: vi.fn(async () => 'recovered-job'),
    interruptAppServerJob: vi.fn(async () => {}),
    completeRecoveredJob: vi.fn(),
    ...overrides,
  } as RecoveryCapableService;
}

describe('runStartupRecovery provider-operation ownership', () => {
  it('hands a post-snapshot local fallback to exact generic recovery before deleting the saga', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const targetJobId = randomUUID();
    const targetSessionId = randomUUID();
    const sentinelJobId = randomUUID();
    const sentinelSessionId = randomUUID();
    seedQueuedProviderJob(progressStore, {
      jobId: sentinelJobId,
      sessionId: sentinelSessionId,
      enqueueSequence: 1,
    });
    seedQueuedProviderJob(progressStore, {
      jobId: targetJobId,
      sessionId: targetSessionId,
      enqueueSequence: 2,
    });

    const fixture = providerOperationRecord('prestart-cleanup-pending');
    const saga = providerOperationRecordSchema.parse({
      ...fixture,
      operation: { ...fixture.operation, jobId: targetJobId },
    });
    if (saga.phase !== 'prestart-cleanup-pending') throw new Error('expected prestart cleanup saga');
    insertProviderOperation(progressStore.getDb(), saga);

    const targetAcceptance = deferred();
    const sentinelAcceptance = deferred();
    const sentinelStarted = deferred();
    let recoveredLaunchCount = 0;
    const recoverTargetQueuedJob = vi.fn(async () => {
      await targetAcceptance.promise;
      recoveredLaunchCount += 1;
      return targetJobId;
    });
    const recoverQueuedJob = vi.fn(async (authority: ProviderRecoveryAuthority) => {
      const jobId = authority.launchRecord.jobId;
      if (jobId === sentinelJobId) {
        sentinelStarted.resolve();
        await sentinelAcceptance.promise;
        return sentinelJobId;
      }
      if (jobId !== targetJobId) throw new Error(`unexpected recovery job ${jobId}`);
      return recoverTargetQueuedJob();
    });
    const fakeService = createFakeService({ recoverQueuedJob });
    const createInvocationContext = (projectRoot: string): InvocationContext => ({
      projectRoot: fixtureCanonicalWorkDir(projectRoot),
      pluginRoot: '/tmp/plugin',
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
    });
    const getRecoveryService = (): RecoveryCapableService => fakeService;
    const signal = new AbortController().signal;
    const log = vi.fn();
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => progressStore.commit(cb);
    const boundRecovery = await createBoundJobsRecoveryHarness({
      identity: {
        pluginRoot: '/tmp/plugin',
        namespace: NAMESPACE,
        version: 'test-version',
        buildSetId: '00000000-0000-4000-8000-000000000000',
        bundleHash: 'test-bundle',
        cliBundleHash: 'test-cli-bundle',
        claudeAppserverBundleHash: 'test-claude-bundle',
        flavor: 'prod',
        instanceId: 'provider-operation-race-test',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        now: () => runtime.time.now(),
        log,
      },
      runtime,
      progressStore,
      providerRegistry: {} as never,
      getRecoveryService,
      createInvocationContext,
      signal,
      coordinatorCommit,
    });
    const recoveryCoordinator = createRecoveryCoordinator(
      {
        progressStore,
        runtime,
        runtimeState: { setLaunchFenceActive: vi.fn() },
        eventBus: { emit: vi.fn() } as never,
        getRecoveryService,
        createInvocationContext,
        log,
      },
      boundRecovery.bound,
    );

    const cancelOperation = vi
      .fn<DurableProviderProxyOperationAuthority['cancelOperation']>()
      .mockRejectedValueOnce(new Error('startup proxy control unavailable'))
      .mockImplementation(async (operation, prepareAttemptNumber, prepareAttemptKey) => ({
        state: 'released-never-started',
        operation,
        prepareAttemptNumber,
        prepareAttemptKey,
      }));
    const authorityFor = vi.fn(
      () =>
        ({
          proxyInstanceId: saga.operation.proxyInstanceId,
          setIdentity: providerProxySetIdentityFromRecord(saga),
          cancelOperation,
        }) as unknown as DurableProviderProxyOperationAuthority,
    );
    const reconciler = new ProviderOperationReconciler({
      getProgressStore: () => progressStore,
      authorityFor,
      startupSetRecovery: {
        recoverSetAtStartup: async () => {
          const authority = authorityFor();
          return { kind: 'authority', authority };
        },
      },
      registry: { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() },
      materializePrepare: () => {
        throw new Error('race test unexpectedly materialized a prepare');
      },
      recoverLocalJob: (record, recoverySignal) =>
        recoveryCoordinator.recoverProviderOperationJob(record, recoverySignal),
      completeLocalRecovery: (jobId) => recoveryCoordinator.completeProviderOperationJobRecovery(jobId),
      terminalization: {
        terminalize: () => {
          throw new Error('race test unexpectedly terminalized the provider operation');
        },
      },
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({}),
      backendNamespace: BACKEND_NAMESPACE,
      onFatal: (error) => {
        throw error;
      },
      time: {
        now: () => 100,
        setTimeout: () => ({ unref: () => undefined }),
        clearTimeout: () => undefined,
      },
    });

    await reconciler.reconcileAtStartup(signal);
    expect(readProviderOperation(progressStore.getDb(), saga.operation)?.phase).toBe('prestart-cleanup-pending');

    const startupRecovery = boundRecovery.run(recoveryCoordinator);
    await sentinelStarted.promise;

    const staleSaga = readProviderOperation(progressStore.getDb(), saga.operation);
    if (staleSaga?.phase !== 'prestart-cleanup-pending') throw new Error('expected stale prestart cleanup saga');
    const postSnapshotReconciliation = reconciler.reconcile(staleSaga, undefined, signal);
    await vi.waitFor(() => expect(cancelOperation).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect
      .soft(readProviderOperation(progressStore.getDb(), saga.operation)?.phase ?? null)
      .toBe('local-recovery-pending');
    expect.soft(recoverTargetQueuedJob, 'recoverQueuedJob').toHaveBeenCalledTimes(1);
    expect.soft(recoveredLaunchCount).toBe(0);

    targetAcceptance.resolve();
    await postSnapshotReconciliation;
    expect.soft(readProviderOperation(progressStore.getDb(), saga.operation)).toBeNull();
    expect.soft(recoveredLaunchCount).toBe(1);

    sentinelAcceptance.resolve();
    await startupRecovery;
    expect.soft(recoverTargetQueuedJob, 'recoverQueuedJob').toHaveBeenCalledTimes(1);
    expect.soft(recoveredLaunchCount).toBe(1);
    await recoveryCoordinator.teardown();
  });

  // The fence's other half. A row this build cannot read keeps its job away from generic recovery so the boot
  // survives — but nothing decodes the row, so nothing settles the job either, and it stays live in `jobs` and
  // unending under `wait` forever. Absence of every recorded process is provable without decoding anything,
  // and once the row is gone the job reaches ordinary recovery like any other.
  it('retires a superseded saga row whose processes are all absent, and keeps one that is not', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const goneJobId = randomUUID();
    const liveJobId = randomUUID();
    seedQueuedProviderJob(progressStore, { jobId: goneJobId, sessionId: randomUUID(), enqueueSequence: 1 });
    seedQueuedProviderJob(progressStore, { jobId: liveJobId, sessionId: randomUUID(), enqueueSequence: 2 });

    // `process.pid` is this very process, so the "live" row is alive by construction rather than by a mock —
    // and the absent pids are the ones the OS reserves and never assigns.
    const seedSuperseded = (jobId: string, pid: number): string => {
      const fixture = providerOperationRecord('prepare-pending');
      const shipped = JSON.parse(encodeProviderOperationRecord(fixture)) as {
        locator: Record<string, Record<string, unknown>>;
      };
      for (const part of ['proxy', 'guardian', 'reaper', 'containment']) {
        const entry = shipped.locator[part];
        if (entry === undefined) continue;
        delete entry.incarnation;
        entry.processStartedAtSeconds = 1_700_000_000;
        entry.pid = pid;
      }
      const key =
        `provider_operation_saga.v1:record:${jobId}:${fixture.operation.operationId}:` +
        `${fixture.operation.proxyInstanceId}:${fixture.operation.buildSetId}`;
      progressStore
        .getDb()
        .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run(key, JSON.stringify(shipped));
      return key;
    };
    const goneKey = seedSuperseded(goneJobId, 0x7f_ff_ff_ff);
    const liveKey = seedSuperseded(liveJobId, process.pid);

    // The third case, and the one that must never be confused with absence: a row whose pids cannot be read at
    // all. "No pids observed" is not "no processes alive" — retiring on it would settle a job whose processes
    // were never looked at.
    const unwalkableJobId = randomUUID();
    seedQueuedProviderJob(progressStore, { jobId: unwalkableJobId, sessionId: randomUUID(), enqueueSequence: 3 });
    const unwalkableKey = `provider_operation_saga.v1:record:${unwalkableJobId}:${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    progressStore
      .getDb()
      .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(unwalkableKey, 'not json at all');

    const fakeService = createFakeService({ recoverQueuedJob: vi.fn(async () => goneJobId) });
    const getRecoveryService = (): RecoveryCapableService => fakeService;
    const createInvocationContext = (projectRoot: string): InvocationContext => ({
      projectRoot: fixtureCanonicalWorkDir(projectRoot),
      pluginRoot: '/tmp/plugin',
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
    });
    const signal = new AbortController().signal;
    const log = vi.fn();
    const boundRecovery = await createBoundJobsRecoveryHarness({
      identity: {
        pluginRoot: '/tmp/plugin',
        namespace: NAMESPACE,
        version: 'test-version',
        buildSetId: '00000000-0000-4000-8000-000000000000',
        bundleHash: 'test-bundle',
        cliBundleHash: 'test-cli-bundle',
        claudeAppserverBundleHash: 'test-claude-bundle',
        flavor: 'prod',
        instanceId: 'superseded-retirement-test',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        now: () => runtime.time.now(),
        log,
      },
      runtime,
      progressStore,
      providerRegistry: {} as never,
      getRecoveryService,
      createInvocationContext,
      signal,
      coordinatorCommit: (cb: Parameters<JobStore['commit']>[0]) => progressStore.commit(cb),
    });
    const recoveryCoordinator = createRecoveryCoordinator(
      {
        progressStore,
        runtime,
        runtimeState: { setLaunchFenceActive: vi.fn() },
        eventBus: { emit: vi.fn() } as never,
        getRecoveryService,
        createInvocationContext,
        log,
      },
      boundRecovery.bound,
    );

    const ownership = recoveryCoordinator.snapshotProviderOperationStartupOwnership();
    const rowExists = (key: string): boolean =>
      progressStore.getDb().prepare<[string], { key: string }>('SELECT key FROM meta WHERE key = ?').all(key).length >
      0;

    expect({
      fenced: [...ownership.jobIds].sort(),
      goneRowSurvives: rowExists(goneKey),
      liveRowSurvives: rowExists(liveKey),
      unwalkableRowSurvives: rowExists(unwalkableKey),
    }).toEqual({
      // The job whose processes are still around, and the one nothing could be observed about. Only the job
      // proven gone is unfenced, and ordinary recovery owns it from here.
      fenced: [liveJobId, unwalkableJobId].sort(),
      goneRowSurvives: false,
      liveRowSurvives: true,
      unwalkableRowSurvives: true,
    });
  });

  it('deduplicates a startup local-recovery handoff until the saga confirms deletion', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = randomUUID();
    seedQueuedProviderJob(progressStore, { jobId, sessionId, enqueueSequence: 1 });
    const fixture = providerOperationRecord('local-recovery-pending');
    const record = providerOperationRecordSchema.parse({
      ...fixture,
      operation: { ...fixture.operation, jobId },
    });
    if (record.phase !== 'local-recovery-pending') throw new Error('expected local recovery saga');
    insertProviderOperation(progressStore.getDb(), record);

    const recoverQueuedJob = vi.fn(async () => jobId);
    const fakeService = createFakeService({ recoverQueuedJob });
    const createInvocationContext = (projectRoot: string): InvocationContext => ({
      projectRoot: fixtureCanonicalWorkDir(projectRoot),
      pluginRoot: '/tmp/plugin',
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
    });
    const getRecoveryService = (): RecoveryCapableService => fakeService;
    const signal = new AbortController().signal;
    const log = vi.fn();
    const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => progressStore.commit(cb);
    const boundRecovery = await createBoundJobsRecoveryHarness({
      identity: {
        pluginRoot: '/tmp/plugin',
        namespace: NAMESPACE,
        version: 'test-version',
        buildSetId: '00000000-0000-4000-8000-000000000000',
        bundleHash: 'test-bundle',
        cliBundleHash: 'test-cli-bundle',
        claudeAppserverBundleHash: 'test-claude-bundle',
        flavor: 'prod',
        instanceId: 'provider-operation-startup-dedup-test',
        token: 'test-token',
        bootToken: 'test-boot-token',
        shutdownToken: 'test-shutdown-token',
        now: () => runtime.time.now(),
        log,
      },
      runtime,
      progressStore,
      providerRegistry: {} as never,
      getRecoveryService,
      createInvocationContext,
      signal,
      coordinatorCommit,
    });
    const recoveryCoordinator = createRecoveryCoordinator(
      {
        progressStore,
        runtime,
        runtimeState: { setLaunchFenceActive: vi.fn() },
        eventBus: { emit: vi.fn() } as never,
        getRecoveryService,
        createInvocationContext,
        log,
      },
      boundRecovery.bound,
    );

    const startupOwnership = recoveryCoordinator.snapshotProviderOperationStartupOwnership();
    expect(startupOwnership).toEqual({ jobIds: [jobId] });
    expect(Object.isFrozen(startupOwnership)).toBe(true);
    expect(Object.isFrozen(startupOwnership.jobIds)).toBe(true);

    await boundRecovery.run(recoveryCoordinator);
    expect(recoverQueuedJob).toHaveBeenCalledTimes(1);

    await expect(recoveryCoordinator.recoverProviderOperationJob(record, signal)).resolves.toEqual({
      state: 'accepted',
      jobId,
      owner: 'recovery-coordinator',
    });
    expect(recoverQueuedJob).toHaveBeenCalledTimes(1);
    recoveryCoordinator.completeProviderOperationJobRecovery(jobId);
    await recoveryCoordinator.teardown();
  });

  it.each(['proxy-activation-pending', 'executing'] as const)(
    'does not let generic recovery decide a job still owned by a %s saga row',
    async (phase) => {
      const runtime = createRealRuntime('prod');
      const progressStore = createProgressStore(runtime);
      const jobId = randomUUID();
      const sessionId = 'pending-saga-session';
      const proxyInstanceId = randomUUID();
      seedRunningAppServerJob(progressStore, { jobId, sessionId, provider: 'codex', proxyInstanceId });
      const operationId = randomUUID();
      const record =
        phase === 'executing'
          ? committedOperation({ jobId, operationId, proxyInstanceId })
          : (() => {
              const fixture = providerOperationRecord(phase);
              return providerOperationRecordSchema.parse({
                ...fixture,
                operation: { ...fixture.operation, jobId, operationId, proxyInstanceId },
                locator: {
                  ...fixture.locator,
                  proxy: { ...fixture.locator.proxy, instanceId: proxyInstanceId },
                },
              });
            })();
      insertProviderOperation(progressStore.getDb(), record);

      const fakeService = createFakeService();
      const createInvocationContext = (projectRoot: string): InvocationContext => ({
        projectRoot: fixtureCanonicalWorkDir(projectRoot),
        pluginRoot: '/tmp/plugin',
        coralEnv: {},
        principal: testProjectPrincipal(projectRoot),
      });
      const getRecoveryService = (): RecoveryCapableService => fakeService;
      const signal = new AbortController().signal;
      const log = vi.fn();
      const coordinatorCommit = (cb: Parameters<JobStore['commit']>[0]) => progressStore.commit(cb);
      const boundRecovery = await createBoundJobsRecoveryHarness({
        identity: {
          pluginRoot: '/tmp/plugin',
          namespace: NAMESPACE,
          version: 'test-version',
          buildSetId: '00000000-0000-4000-8000-000000000000',
          bundleHash: 'test-bundle',
          cliBundleHash: 'test-cli-bundle',
          claudeAppserverBundleHash: 'test-claude-bundle',
          flavor: 'prod',
          instanceId: 'pending-saga-recovery-test',
          token: 'test-token',
          bootToken: 'test-boot-token',
          shutdownToken: 'test-shutdown-token',
          now: () => runtime.time.now(),
          log,
        },
        runtime,
        progressStore,
        providerRegistry: {} as never,
        getRecoveryService,
        createInvocationContext,
        signal,
        coordinatorCommit,
      });
      const recoveryCoordinator = createRecoveryCoordinator(
        {
          progressStore,
          runtime,
          runtimeState: { setLaunchFenceActive: vi.fn() },
          eventBus: { emit: vi.fn() } as never,
          getRecoveryService,
          createInvocationContext,
          log,
        },
        boundRecovery.bound,
      );

      await boundRecovery.run(recoveryCoordinator);

      expect(fakeService.captureProviderRecoveryAuthority).not.toHaveBeenCalled();
      expect(fakeService.finalizeInterruptedAppServerJob).not.toHaveBeenCalled();
      expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    },
  );
});
