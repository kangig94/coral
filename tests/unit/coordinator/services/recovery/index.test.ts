import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
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
import { quarantineUnreadableProviderOperations } from '#src/coordinator/services/recovery/retry-plans.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createUnreadableProviderOperationDiscardService } from '#src/coordinator/services/recovery/unreadable-provider-operation-discard.js';
import type {
  ProviderRecoveryAuthority,
  ProviderRecoveryAuthorityCapture,
  RecoveryCapableService,
} from '#src/jobs/reconcile/contracts.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import {
  deleteProviderOperation,
  insertProviderOperation,
  observeProviderOperationRecord,
  readProviderOperation,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { providerOperationRecord } from '../../../store/provider-operation-fixtures.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

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

function committedOperation(
  overrides: {
    jobId: string;
    operationId: string;
    proxyInstanceId: string;
  },
  phase: 'executing' | 'settlement-pending' = 'executing',
): ProviderOperationRecord {
  const fixture = providerOperationRecord(phase);
  if (!('activationAck' in fixture)) throw new Error(`Fixture phase '${phase}' carries no activation ack.`);
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
  const launchCoordinator = new LaunchCoordinator({ runtime });
  launchCoordinator.connectLaunchReclamationOracle('undecided-provider-operation', (permit) =>
    permit.holder.recordKeys.some((key) => observeProviderOperationRecord(progressStore.getDb(), key).kind !== 'absent')
      ? { kind: 'job-live' }
      : {
          kind: 'provider-operation-records-absent',
          recordKeys: permit.holder.recordKeys,
          jobEvidence: { kind: 'job-terminal', phase: 'completed' },
        },
  );
  let phaseChanged: ((event: unknown) => void) | null = null;
  const recoveryCoordinator = createRecoveryCoordinator(
    {
      progressStore,
      runtime,
      runtimeState: { setLaunchFenceActive: vi.fn() },
      eventBus: {
        on: vi.fn((event: string, listener: (input: unknown) => void) => {
          if (event === 'job:phase_changed') phaseChanged = listener;
        }),
        off: vi.fn(),
        emit: vi.fn(),
      } as never,
      getRecoveryService,
      createInvocationContext,
      log,
      startupOwnership: launchCoordinator,
    },
    boundRecovery.bound,
  );
  return {
    launchCoordinator,
    recoveryCoordinator,
    log,
    runStartupRecovery: () => boundRecovery.run(recoveryCoordinator),
    emitTerminalPhase: (jobId: string) => {
      phaseChanged?.({ jobId, previousPhase: 'running', phase: 'completed' });
    },
  };
}

describe('runStartupRecovery provider-operation ownership', () => {
  it('acquires startup recovery ownership for an executing provider operation', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const phases = ['executing'] as const;

    const records = phases.map((phase, index) => {
      const jobId = randomUUID();
      const sessionId = randomUUID();
      const fixture = providerOperationRecord(phase, { job: index + 100 });
      const record = providerOperationRecord(phase, {
        operation: { ...fixture.operation, jobId, operationId: randomUUID() },
      });
      seedRunningAppServerJob(progressStore, {
        jobId,
        sessionId,
        provider: 'codex',
        proxyInstanceId: record.operation.proxyInstanceId,
      });
      insertProviderOperation(progressStore.getDb(), record);
      return record;
    });
    const { recoveryCoordinator } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      createFakeService(),
      'readable-phase-matrix',
    );

    const ownership = recoveryCoordinator.hydrateProviderOperationStartupOwnership(
      recoveryCoordinator.snapshotProviderOperationStartupOwnership(),
    );
    expect(ownership.completion).toEqual({ kind: 'complete' });
    expect(ownership.records).toHaveLength(1);
    expect(ownership.records[0]).toMatchObject({
      restoredPermit: expect.objectContaining({ holder: { kind: 'recovery' } }),
      bindingDisposition: { kind: 'prepared' },
    });
    expect(ownership.jobIds).toEqual(expect.arrayContaining(records.map((record) => record.operation.jobId)));
    await recoveryCoordinator.teardown();
  });

  it('quarantines an unreadable startup row and keeps recovery held', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    seedQueuedProviderJob(progressStore, { jobId, sessionId: randomUUID(), enqueueSequence: 1 });
    const unreadableKey =
      `provider_operation_saga.v1:record:${jobId}:${randomUUID()}:` + `${randomUUID()}:${randomUUID()}`;
    progressStore
      .getDb()
      .prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(unreadableKey, 'not json at all');
    const observation = observeProviderOperationRecord(progressStore.getDb(), unreadableKey);
    if (observation.kind !== 'unreadable') throw new Error('expected unreadable provider-operation row');
    const quarantine = new RecoveryQuarantineStore(progressStore.getDb(), runtime.time);
    await expect(quarantineUnreadableProviderOperations(quarantine, [observation.attribution])).resolves.toMatchObject({
      materialized: 1,
      retained: 0,
      failed: [],
    });
    const { recoveryCoordinator, runStartupRecovery } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      createFakeService(),
      'unreadable-startup-hold-command',
    );

    const disposition = await runStartupRecovery();

    expect(disposition).toMatchObject({
      kind: 'held',
      providerOperationHolds: expect.arrayContaining([
        expect.objectContaining({
          remedy: {
            kind: 'recovery-quarantine-discard',
            command: expect.objectContaining({
              kind: 'discard-provider-operation',
              key: unreadableKey,
              allowReadable: false,
            }),
          },
        }),
      ]),
    });
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, unreadableKey)).not.toBeNull();
    expect(observeProviderOperationRecord(progressStore.getDb(), unreadableKey).kind).toBe('unreadable');
    await recoveryCoordinator.teardown();
  });

  it('retains ambiguous readable ownership on terminal events until every recorded row is absent', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = randomUUID();
    const first = committedOperation({ jobId, operationId: randomUUID(), proxyInstanceId: randomUUID() });
    const second = committedOperation(
      { jobId, operationId: randomUUID(), proxyInstanceId: randomUUID() },
      'settlement-pending',
    );
    seedRunningAppServerJob(progressStore, {
      jobId,
      sessionId,
      provider: 'codex',
      proxyInstanceId: first.operation.proxyInstanceId,
    });
    insertProviderOperation(progressStore.getDb(), first);
    insertProviderOperation(progressStore.getDb(), second);
    const { launchCoordinator, recoveryCoordinator, emitTerminalPhase } = await createHeldRecoveryCoordinator(
      runtime,
      progressStore,
      createFakeService(),
      'ambiguous-terminal-release',
    );

    const ownership = recoveryCoordinator.hydrateProviderOperationStartupOwnership(
      recoveryCoordinator.snapshotProviderOperationStartupOwnership(),
    );
    const heldPermit = ownership.records[0]?.restoredPermit;
    if (heldPermit?.holder.kind !== 'undecided-provider-operation') {
      throw new Error('expected undecided provider-operation permit');
    }
    expect(heldPermit.holder.recordKeys).toHaveLength(2);
    for (const record of ownership.records) {
      expect(heldPermit.holder.recordKeys.some((key) => key.includes(record.operation.operationId))).toBe(true);
    }

    emitTerminalPhase(jobId);
    expect(launchCoordinator.reservationFor(jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'undecided-provider-operation' },
    });

    const quarantine = new RecoveryQuarantineStore(progressStore.getDb(), runtime.time);
    const discard = createUnreadableProviderOperationDiscardService({
      instanceId: 'ambiguous-terminal-release',
      ids: runtime.ids,
      db: progressStore.getDb(),
      time: runtime.time,
    });
    const coordinates = quarantine.list().filter((entry) => entry.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY);
    expect(coordinates).toHaveLength(1);
    const fenced = coordinates[0];
    if (fenced?.subject.revision.kind !== 'fingerprint') throw new Error('expected fingerprint coordinate');
    expect(fenced.subject.key).toContain(first.operation.operationId);
    expect(
      discard.discard({
        key: fenced.subject.key,
        revision: fenced.subject.revision.value,
        allowReadable: true,
      }),
    ).toMatchObject({ kind: 'discarded' });
    emitTerminalPhase(jobId);
    expect(launchCoordinator.reservationFor(jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'undecided-provider-operation' },
    });

    const settling = readProviderOperation(progressStore.getDb(), second.operation);
    if (settling === null) throw new Error('expected the settlement-pending row to survive the operator discard');
    expect(deleteProviderOperation(progressStore.getDb(), settling)).toMatchObject({ kind: 'deleted' });
    emitTerminalPhase(jobId);
    expect(launchCoordinator.reservationFor(jobId)).toBeNull();

    expect(launchCoordinator.active).toBe(0);
    expect(launchCoordinator.launchReclamationDiagnostics()).toEqual([
      expect.objectContaining({
        reservationId: heldPermit.reservationId,
        holder: heldPermit.holder,
        evidence: {
          kind: 'provider-operation-records-absent',
          recordKeys: heldPermit.holder.recordKeys,
          jobEvidence: { kind: 'job-terminal', phase: 'completed' },
        },
      }),
    ]);
    await recoveryCoordinator.teardown();
  });

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
    const targetStarted = deferred();
    const sentinelAcceptance = deferred();
    const sentinelStarted = deferred();
    const sentinelRecovered = deferred();
    const recoverTargetQueuedJob = async () => {
      targetStarted.resolve();
      await targetAcceptance.promise;
      return targetJobId;
    };
    const recoverQueuedJob = async (authority: ProviderRecoveryAuthority) => {
      const jobId = authority.launchRecord.jobId;
      if (jobId === sentinelJobId) {
        sentinelStarted.resolve();
        await sentinelAcceptance.promise;
        sentinelRecovered.resolve();
        return sentinelJobId;
      }
      if (jobId !== targetJobId) throw new Error(`unexpected recovery job ${jobId}`);
      return recoverTargetQueuedJob();
    };
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
    const startupOwnership = new LaunchCoordinator({ runtime });
    const recoveryCoordinator = createRecoveryCoordinator(
      {
        progressStore,
        runtime,
        runtimeState: { setLaunchFenceActive: vi.fn() },
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
        getRecoveryService,
        createInvocationContext,
        log,
        startupOwnership,
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
      binding: startupOwnership,
      releaseStartupOwnership: (operation) => recoveryCoordinator.releaseProviderOperationStartupOwnership(operation),
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

    const startupSnapshot = recoveryCoordinator.snapshotProviderOperationStartupOwnership();
    await reconciler.reconcileAtStartup(
      recoveryCoordinator.hydrateProviderOperationStartupOwnership(startupSnapshot),
      signal,
    );
    expect(readProviderOperation(progressStore.getDb(), saga.operation)?.phase).toBe('prestart-cleanup-pending');

    let startupSettled = false;
    const startupRecovery = boundRecovery.run(recoveryCoordinator).finally(() => {
      startupSettled = true;
    });
    await sentinelStarted.promise;

    const staleSaga = readProviderOperation(progressStore.getDb(), saga.operation);
    if (staleSaga?.phase !== 'prestart-cleanup-pending') throw new Error('expected stale prestart cleanup saga');
    const postSnapshotReconciliation = reconciler.reconcile(staleSaga, undefined, signal);
    await targetStarted.promise;
    expect(readProviderOperation(progressStore.getDb(), saga.operation)?.phase).toBe('local-recovery-pending');

    sentinelAcceptance.resolve();
    await sentinelRecovered.promise;
    await flushMicrotasks();
    expect(startupSettled).toBe(false);
    expect(readProviderOperation(progressStore.getDb(), saga.operation)?.phase).toBe('local-recovery-pending');

    targetAcceptance.resolve();
    await postSnapshotReconciliation;
    await expect(startupRecovery).resolves.toMatchObject({ kind: 'complete' });
    expect(readProviderOperation(progressStore.getDb(), saga.operation)).toBeNull();
    await recoveryCoordinator.teardown();
  });
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
        eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as never,
        getRecoveryService: () => createFakeService(),
        createInvocationContext: (projectRoot: string): InvocationContext => ({
          projectRoot: fixtureCanonicalWorkDir(projectRoot),
          pluginRoot: '/tmp/plugin',
          coralEnv: {},
          principal: testProjectPrincipal(projectRoot),
        }),
        startupOwnership: new LaunchCoordinator({ runtime }),
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
