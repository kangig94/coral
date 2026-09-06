import type { ProcessLiveness } from '#src/infra/node-process.js';
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
import type {
  ProviderRecoveryAuthority,
  ProviderRecoveryAuthorityCapture,
  RecoveryCapableService,
} from '#src/jobs/reconcile/contracts.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { encodeProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import {
  readDurableCliContainmentStatus,
  writeDurableCliContainmentStatus,
  writeDurableCliProcessRuntimeMeta,
} from '#src/jobs/runtime-meta-store.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

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

function seedRunningDurableJob(
  progressStore: JobStore,
  options: { jobId: string; sessionId: string; pid: number },
): void {
  seedQueuedProviderJob(progressStore, { ...options, enqueueSequence: 1 });
  progressStore.appendRuntimeStarted(options.jobId, {
    transport: 'durable-cli',
    pid: options.pid,
    stdoutPath: '/tmp/coral-held-recovery.stdout',
    stderrPath: '/tmp/coral-held-recovery.stderr',
    startTime: '2026-04-27T00:00:01.000Z',
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
    finalizeInterruptedAppServerJob: vi.fn(async () => {}),
    finalizeInterruptedDurableJob: vi.fn(async () => {}),
    adoptRunningJob: vi.fn(async () => ({ adopted: true, cleanup: vi.fn() })),
    recoverQueuedJob: vi.fn(async () => 'recovered-job'),
    interruptAppServerJob: vi.fn(async () => ({ kind: 'acknowledged' as const })),
    completeRecoveredJob: vi.fn(),
    ...overrides,
  } as RecoveryCapableService;
}

async function createHeldRecoveryCoordinator(
  runtime: ReturnType<typeof createRealRuntime>,
  progressStore: JobStore,
  fakeService: RecoveryCapableService,
  instanceId: string,
) {
  const getRecoveryService = (): RecoveryCapableService => fakeService;
  const createInvocationContext = (projectRoot: string): InvocationContext => ({
    projectRoot: fixtureCanonicalWorkDir(projectRoot),
    pluginRoot: '/tmp/plugin',
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
  });
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
      durableWrapperBundleHash: 'test-durable-wrapper-bundle',
      flavor: 'prod',
      instanceId,
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
  return {
    recoveryCoordinator,
    runStartupRecovery: () => boundRecovery.run(recoveryCoordinator),
  };
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
        durableWrapperBundleHash: 'test-durable-wrapper-bundle',
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
    const baseRuntime = createRealRuntime('prod');
    const liveProcessGroupId = 70_001;
    const failedProbePid = 70_003;
    const observeLiveness = vi.fn((target: number): ProcessLiveness => {
      // The probe that cannot answer is now a value, not a throw — which is the whole point of the change.
      if (target === failedProbePid) return 'unknown';
      return target === process.pid || target === -liveProcessGroupId ? 'alive' : 'absent';
    });
    const kill = vi.fn(baseRuntime.process.kill);
    const runtime = { ...baseRuntime, process: { ...baseRuntime.process, observeLiveness, kill } };
    const progressStore = createProgressStore(runtime);
    const goneJobId = randomUUID();
    const liveJobId = randomUUID();
    const groupJobId = randomUUID();
    const zeroTargetJobId = randomUUID();
    const failedProbeJobId = randomUUID();
    seedQueuedProviderJob(progressStore, { jobId: goneJobId, sessionId: randomUUID(), enqueueSequence: 1 });
    seedQueuedProviderJob(progressStore, { jobId: liveJobId, sessionId: randomUUID(), enqueueSequence: 2 });
    seedQueuedProviderJob(progressStore, { jobId: groupJobId, sessionId: randomUUID(), enqueueSequence: 3 });
    seedQueuedProviderJob(progressStore, { jobId: zeroTargetJobId, sessionId: randomUUID(), enqueueSequence: 4 });
    seedQueuedProviderJob(progressStore, { jobId: failedProbeJobId, sessionId: randomUUID(), enqueueSequence: 5 });

    const seedSuperseded = (jobId: string, pid: number, processGroupId = pid, keyOverride?: string): string => {
      const fixture = providerOperationRecord('prepare-pending');
      const shipped = JSON.parse(encodeProviderOperationRecord(fixture)) as {
        locator: Record<string, Record<string, unknown>>;
        providerRoot?: Record<string, unknown>;
      };
      for (const part of ['proxy', 'guardian', 'reaper', 'containment']) {
        const entry = shipped.locator[part];
        if (entry === undefined) continue;
        delete entry.incarnation;
        entry.processStartedAtSeconds = 1_700_000_000;
        entry.pid = pid;
      }
      if (shipped.locator.containment !== undefined) shipped.locator.containment.processGroupId = processGroupId;
      if (shipped.providerRoot !== undefined) shipped.providerRoot.pid = pid;
      const key =
        keyOverride ??
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
    const groupKey = seedSuperseded(groupJobId, 70_002, liveProcessGroupId);
    const zeroTargetKey = seedSuperseded(zeroTargetJobId, 0, 0);
    const failedProbeKey = seedSuperseded(failedProbeJobId, failedProbePid);
    const noncanonicalGoneKey = seedSuperseded(
      goneJobId,
      0x7f_ff_ff_fe,
      0x7f_ff_ff_fe,
      'provider_operation_saga.v1:record:noncanonical-with-absent-targets',
    );

    // The third case, and the one that must never be confused with absence: a row whose pids cannot be read at
    // all. "No pids observed" is not "no processes alive" — retiring on it would settle a job whose processes
    // were never looked at.
    const unwalkableJobId = randomUUID();
    seedQueuedProviderJob(progressStore, { jobId: unwalkableJobId, sessionId: randomUUID(), enqueueSequence: 6 });
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
        durableWrapperBundleHash: 'test-durable-wrapper-bundle',
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

    const rowExists = (key: string): boolean =>
      progressStore.getDb().prepare<[string], { key: string }>('SELECT key FROM meta WHERE key = ?').all(key).length >
      0;

    // An indeterminate current-generation row contributes no fenced job id, preserving the permissive
    // behavior that predates startup admission holds.
    const unattributableKey = 'provider_operation_saga.v2:record:not-canonical';
    progressStore
      .getDb()
      .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(unattributableKey, JSON.stringify({ version: 1, locator: {} }));

    const beforeRetirement = recoveryCoordinator.snapshotProviderOperationStartupOwnership();
    const payloadJobId = providerOperationRecord('prepare-pending').operation.jobId;
    expect([...beforeRetirement.jobIds].sort()).toEqual(
      [goneJobId, liveJobId, groupJobId, zeroTargetJobId, failedProbeJobId, unwalkableJobId, payloadJobId].sort(),
    );
    expect([goneKey, liveKey, groupKey, zeroTargetKey, failedProbeKey, unwalkableKey].every(rowExists)).toBe(true);

    recoveryCoordinator.retireAbsentSupersededProviderOperations();
    const ownership = recoveryCoordinator.snapshotProviderOperationStartupOwnership();

    expect({
      fenced: [...ownership.jobIds].sort(),
      goneRowSurvives: rowExists(goneKey),
      noncanonicalGoneRowSurvives: rowExists(noncanonicalGoneKey),
      liveRowSurvives: rowExists(liveKey),
      groupRowSurvives: rowExists(groupKey),
      zeroTargetRowSurvives: rowExists(zeroTargetKey),
      failedProbeRowSurvives: rowExists(failedProbeKey),
      unwalkableRowSurvives: rowExists(unwalkableKey),
    }).toEqual({
      // Only the row with a non-empty, completely absent target set is unfenced. A live leader, a live group,
      // an empty usable target set, and an unwalkable row all remain unknown or present and keep their fence.
      fenced: [liveJobId, groupJobId, zeroTargetJobId, failedProbeJobId, unwalkableJobId, payloadJobId].sort(),
      goneRowSurvives: false,
      noncanonicalGoneRowSurvives: false,
      liveRowSurvives: true,
      groupRowSurvives: true,
      zeroTargetRowSurvives: true,
      failedProbeRowSurvives: true,
      unwalkableRowSurvives: true,
    });
    expect(observeLiveness).toHaveBeenCalledWith(-liveProcessGroupId);
    expect(observeLiveness).not.toHaveBeenCalledWith(0);
    expect(kill).not.toHaveBeenCalled();
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
        durableWrapperBundleHash: 'test-durable-wrapper-bundle',
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
          durableWrapperBundleHash: 'test-durable-wrapper-bundle',
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

describe('runStartupRecovery app-server aborts', () => {
  it('finalizes an acknowledged abort during authority capture as a user abort', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const proxyInstanceId = randomUUID();
    seedRunningAppServerJob(progressStore, { jobId, sessionId, provider: 'codex', proxyInstanceId });

    const captureStarted = deferred();
    let capturedLaunch!: JobLaunch;
    let resolveAuthority!: (capture: ProviderRecoveryAuthorityCapture) => void;
    const authorityCapture = new Promise<ProviderRecoveryAuthorityCapture>((resolve) => {
      resolveAuthority = resolve;
    });
    const interruptAppServerJob = vi.fn(async () => ({ kind: 'acknowledged' as const }));
    const finalizationStarted = deferred();
    const releaseFinalization = deferred();
    const finalizeInterruptedAppServerJob = vi.fn(async () => {
      finalizationStarted.resolve();
      await releaseFinalization.promise;
    });
    const fakeService = createFakeService({
      captureProviderRecoveryAuthority: vi.fn((launchRecord) => {
        capturedLaunch = launchRecord;
        captureStarted.resolve();
        return authorityCapture;
      }),
      interruptAppServerJob,
      finalizeInterruptedAppServerJob,
    });
    const { recoveryCoordinator, runStartupRecovery } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      fakeService,
      'app-server-abort-recovery-test',
    );

    const startup = runStartupRecovery();
    await captureStarted.promise;
    const recoveryRegistry = recoveryCoordinator.getRecoveryRegistry();
    expect(recoveryRegistry?.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      held: [
        {
          jobId,
          reason: 'waiting for recovery authority and provider acknowledgment of app-server interruption',
          nextStep:
            `Run coral-cli jobs detail ${jobId}; if interruption is refused, repair the reported condition, ` +
            'then use coral-cli backend recovery-quarantine list and run its exact retry command.',
        },
      ],
    });
    expect(recoveryRegistry?.has(jobId)).toBe(true);

    resolveAuthority({
      ok: true,
      authority: {
        launchRecord: capturedLaunch,
        session: { sessionId, providerContinuity: null, projectRoot: PROJECT_ROOT, version: 1 },
        boundProvider: { name: 'codex' },
      } as unknown as ProviderRecoveryAuthority,
    });
    await finalizationStarted.promise;

    expect(interruptAppServerJob).toHaveBeenCalledOnce();
    expect(recoveryRegistry?.has(jobId)).toBe(true);
    expect(recoveryRegistry?.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      held: [
        {
          jobId,
          reason: 'the provider acknowledged interruption; user-abort terminal finalization remains pending',
          nextStep:
            `Wait for startup recovery to finalize ${jobId}; if it remains held, use coral-cli ` +
            'backend recovery-quarantine list and run its exact retry command.',
        },
      ],
    });
    expect(finalizeInterruptedAppServerJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reason: 'user_abort' }),
    );

    releaseFinalization.resolve();
    await startup;
    expect(recoveryRegistry?.has(jobId)).toBe(false);
    await recoveryCoordinator.teardown();
  });

  it('retains an acknowledged abort when user-abort terminal finalization fails', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const proxyInstanceId = randomUUID();
    seedRunningAppServerJob(progressStore, { jobId, sessionId, provider: 'codex', proxyInstanceId });

    const captureStarted = deferred();
    let capturedLaunch!: JobLaunch;
    let resolveAuthority!: (capture: ProviderRecoveryAuthorityCapture) => void;
    const authorityCapture = new Promise<ProviderRecoveryAuthorityCapture>((resolve) => {
      resolveAuthority = resolve;
    });
    const fakeService = createFakeService({
      captureProviderRecoveryAuthority: vi.fn((launchRecord) => {
        capturedLaunch = launchRecord;
        captureStarted.resolve();
        return authorityCapture;
      }),
      interruptAppServerJob: vi.fn(async () => ({ kind: 'acknowledged' as const })),
      finalizeInterruptedAppServerJob: vi.fn(async () => {
        throw new Error('terminal commit unavailable');
      }),
    });
    const { recoveryCoordinator, runStartupRecovery } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      fakeService,
      'app-server-abort-finalization-failure-test',
    );

    const startup = runStartupRecovery();
    await captureStarted.promise;
    const recoveryRegistry = recoveryCoordinator.getRecoveryRegistry();
    recoveryRegistry?.abort([jobId]);
    resolveAuthority({
      ok: true,
      authority: {
        launchRecord: capturedLaunch,
        session: { sessionId, providerContinuity: null, projectRoot: PROJECT_ROOT, version: 1 },
        boundProvider: { name: 'codex' },
      } as unknown as ProviderRecoveryAuthority,
    });
    await startup;

    expect(recoveryRegistry?.has(jobId)).toBe(true);
    expect(recoveryRegistry?.getAbortDisposition(jobId)).toMatchObject({
      kind: 'finalization-pending',
      reason: 'the provider acknowledged interruption; user-abort terminal finalization remains pending',
    });
    expect(progressStore.readStatus(jobId)?.phase).toBe('running');
    await recoveryCoordinator.teardown();
  });
});

describe('runStartupRecovery adopted durable aborts', () => {
  it('defers absence finalization until the active abort settlement records cancellation', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const pid = 70_100;
    const incarnation = testIncarnation('pending-adopted-abort');
    seedRunningDurableJob(progressStore, { jobId, sessionId, pid });
    writeDurableCliProcessRuntimeMeta(progressStore.getDb(), {
      jobId,
      pid,
      incarnation,
      processGroupId: pid,
      childRoot: { pid: pid + 1, incarnation },
    });

    let containmentAbsent = false;
    vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation(() => (containmentAbsent ? 'absent' : 'alive'));
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation(() =>
      containmentAbsent ? null : incarnation,
    );
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(runtime.time, 'setInterval').mockImplementation((callback) => {
      intervalCallbacks.push(callback);
      return { unref: vi.fn() };
    });
    vi.spyOn(runtime.time, 'clearInterval').mockImplementation(() => undefined);
    const finalizeInterruptedDurableJob = vi.fn(async () => {});
    const fakeService = createFakeService({ finalizeInterruptedDurableJob });
    const { recoveryCoordinator, runStartupRecovery } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      fakeService,
      'pending-adopted-abort-recovery-test',
    );

    await runStartupRecovery();
    const recoveryRegistry = recoveryCoordinator.getRecoveryRegistry();
    let acceptAbort!: (value: { kind: 'accepted' }) => void;
    const settlement = new Promise<{ kind: 'accepted' }>((resolve) => {
      acceptAbort = resolve;
    });
    recoveryRegistry?.setAbortHandler(jobId, () => ({
      kind: 'held',
      reason: 'recorded containment absence confirmation is pending',
      nextStep: 'Wait for absence confirmation.',
      settlement,
    }));
    recoveryRegistry?.abort([jobId]);

    containmentAbsent = true;
    const poll = intervalCallbacks[0];
    if (poll === undefined) throw new Error('Expected adopted durable recovery poller');
    poll();
    await Promise.resolve();
    expect(finalizeInterruptedDurableJob).not.toHaveBeenCalled();
    expect(recoveryRegistry?.has(jobId)).toBe(true);

    acceptAbort({ kind: 'accepted' });
    await settlement;
    await Promise.resolve();
    poll();
    await vi.waitFor(() => expect(finalizeInterruptedDurableJob).toHaveBeenCalledOnce());
    expect(finalizeInterruptedDurableJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cancelled: true }),
      expect.anything(),
    );
    await vi.waitFor(() => expect(recoveryRegistry?.has(jobId)).toBe(false));
    await recoveryCoordinator.teardown();
  });
});

describe('runStartupRecovery durable containment holds', () => {
  it('retries identity-safe reaping until absence without adopting held work', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const pid = 70_101;
    const incarnation = testIncarnation('held-recovery');
    const record = {
      jobId,
      pid,
      incarnation,
      processGroupId: pid,
      childRoot: { pid: pid + 1, incarnation },
    };
    seedRunningDurableJob(progressStore, { jobId, sessionId, pid });
    writeDurableCliProcessRuntimeMeta(progressStore.getDb(), record);
    writeDurableCliContainmentStatus(progressStore.getDb(), {
      jobId,
      evidence: { kind: 'current', record },
      disposition: {
        kind: 'held',
        reason: 'the process ignored termination before restart',
        retryIntervalMs: 500,
        abandonment: 'abort-job',
      },
    });

    let monotonicMs = 0n;
    vi.spyOn(runtime.time, 'monotonicNow').mockImplementation(() => {
      monotonicMs += 25n;
      return monotonicMs;
    });
    vi.spyOn(runtime.time, 'sleep').mockResolvedValue();
    let containmentAbsent = false;
    vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation(() => (containmentAbsent ? 'absent' : 'alive'));
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation(() =>
      containmentAbsent ? null : incarnation,
    );
    vi.spyOn(runtime.process, 'observeRecordedProcessAsync').mockImplementation(async () =>
      containmentAbsent ? 'absent' : 'alive',
    );
    vi.spyOn(runtime.process, 'observeProcessIdentities').mockImplementation(async (owners) =>
      owners.map((owner) =>
        containmentAbsent
          ? { owner, evidence: { kind: 'pid-absent' as const } }
          : { owner, evidence: { kind: 'incarnation' as const, incarnation } },
      ),
    );
    let termAttempts = 0;
    const kill = vi.spyOn(runtime.process, 'kill').mockImplementation((target, signalName) => {
      if (target === -pid && signalName === 'SIGTERM') {
        termAttempts += 1;
        if (termAttempts === 2) containmentAbsent = true;
      }
      return true;
    });
    const intervalCallbacks: Array<{ callback: () => void; milliseconds: number }> = [];
    const retryHandle = { unref: vi.fn() };
    const setInterval = vi.spyOn(runtime.time, 'setInterval').mockImplementation((callback, milliseconds) => {
      intervalCallbacks.push({ callback, milliseconds });
      return retryHandle;
    });
    const clearInterval = vi.spyOn(runtime.time, 'clearInterval').mockImplementation(() => undefined);

    const fakeService = createFakeService();
    const { recoveryCoordinator, runStartupRecovery } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      fakeService,
      'held-durable-recovery-test',
    );

    await runStartupRecovery();

    expect(fakeService.captureProviderRecoveryAuthority).toHaveBeenCalledOnce();
    expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(pid + 1, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(pid + 1, 'SIGKILL');
    expect(readDurableCliContainmentStatus(progressStore.getDb(), jobId)).toMatchObject({
      kind: 'valid',
      status: { disposition: { kind: 'held' } },
    });
    const recoveryRegistry = recoveryCoordinator.getRecoveryRegistry();
    expect(recoveryRegistry?.has(jobId)).toBe(true);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(retryHandle.unref).toHaveBeenCalledOnce();
    const retryHeldCleanup = intervalCallbacks.find(({ milliseconds }) => milliseconds === 500)?.callback;
    if (retryHeldCleanup === undefined) throw new Error('Expected held recovery retry callback');
    retryHeldCleanup();
    await vi.waitFor(() => expect(fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledOnce());
    expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    expect(termAttempts).toBe(2);
    expect(clearInterval).toHaveBeenCalledWith(retryHandle);
    await vi.waitFor(() => expect(recoveryRegistry?.has(jobId)).toBe(false));
    await recoveryCoordinator.teardown();
  });

  it('revokes an in-flight reap before operator abandonment can be followed by SIGKILL', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const pid = 70_102;
    const incarnation = testIncarnation('abandoned-held-recovery');
    const record = {
      jobId,
      pid,
      incarnation,
      processGroupId: pid,
      childRoot: { pid: pid + 1, incarnation },
    };
    seedRunningDurableJob(progressStore, { jobId, sessionId, pid });
    writeDurableCliProcessRuntimeMeta(progressStore.getDb(), record);
    writeDurableCliContainmentStatus(progressStore.getDb(), {
      jobId,
      evidence: { kind: 'current', record },
      disposition: {
        kind: 'held',
        reason: 'the process ignored termination before restart',
        retryIntervalMs: 500,
        abandonment: 'abort-job',
      },
    });

    let monotonicMs = 0n;
    vi.spyOn(runtime.time, 'monotonicNow').mockImplementation(() => {
      monotonicMs += 25n;
      return monotonicMs;
    });
    const sigtermDelivered = deferred();
    const releaseGrace = deferred();
    let termSent = false;
    let graceBlocked = false;
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async () => {
      if (!termSent) return;
      if (graceBlocked) return;
      graceBlocked = true;
      await releaseGrace.promise;
    });
    vi.spyOn(runtime.env, 'platform').mockReturnValue('linux');
    vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue('alive');
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockReturnValue(incarnation);
    vi.spyOn(runtime.process, 'observeRecordedProcessAsync').mockResolvedValue('alive');
    vi.spyOn(runtime.process, 'observeProcessIdentities').mockImplementation(async (owners) =>
      owners.map((owner) => ({ owner, evidence: { kind: 'incarnation' as const, incarnation } })),
    );
    const kill = vi.spyOn(runtime.process, 'kill').mockImplementation((_target, signalName) => {
      if (signalName === 'SIGTERM') {
        termSent = true;
        sigtermDelivered.resolve();
      }
      return true;
    });
    const setInterval = vi.spyOn(runtime.time, 'setInterval').mockReturnValue({ unref: vi.fn() });

    const fakeService = createFakeService();
    const { recoveryCoordinator, runStartupRecovery } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      fakeService,
      'abandoned-held-durable-recovery-test',
    );

    const startup = runStartupRecovery();
    await sigtermDelivered.promise;
    const recoveryRegistry = recoveryCoordinator.getRecoveryRegistry();
    expect(recoveryRegistry?.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      abandoned: [
        {
          jobId,
          reason: 'recovery ownership was released without proof of recorded containment absence',
          nextStep:
            `Run coral-cli jobs detail ${jobId}; the recorded containment may still be live and is no longer ` +
            'owned by recovery.',
        },
      ],
    });
    await vi.waitFor(() => expect(fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledOnce());
    releaseGrace.resolve();
    await startup;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(kill).toHaveBeenCalledWith(-pid, 'SIGTERM');
    expect(kill.mock.calls.every(([, signalName]) => signalName === 'SIGTERM')).toBe(true);
    expect(setInterval).not.toHaveBeenCalled();
    expect(fakeService.adoptRunningJob).not.toHaveBeenCalled();
    expect(fakeService.finalizeInterruptedDurableJob).toHaveBeenCalledOnce();
    expect(readDurableCliContainmentStatus(progressStore.getDb(), jobId)).toMatchObject({
      kind: 'valid',
      status: { disposition: { kind: 'operator-abandoned', processAbsenceProven: false } },
    });
    await recoveryCoordinator.teardown();
  });
});

describe('recovery coordinator teardown', () => {
  it('returns the in-flight teardown settlement to concurrent callers', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const runtimeState = { setLaunchFenceActive: vi.fn() };
    const recoveryCoordinator = createRecoveryCoordinator(
      {
        progressStore,
        runtime,
        runtimeState,
        eventBus: { emit: vi.fn() } as never,
        getRecoveryService: () => createFakeService(),
        createInvocationContext: (projectRoot: string): InvocationContext => ({
          projectRoot: fixtureCanonicalWorkDir(projectRoot),
          pluginRoot: '/tmp/plugin',
          coralEnv: {},
          principal: testProjectPrincipal(projectRoot),
        }),
        log: vi.fn(),
      },
      null,
    );

    const firstSettlement = recoveryCoordinator.teardown();
    const joinedSettlement = recoveryCoordinator.teardown();

    expect(joinedSettlement).toBe(firstSettlement);
    await firstSettlement;
    expect(runtimeState.setLaunchFenceActive).toHaveBeenCalledOnce();
  });
});
