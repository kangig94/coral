import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { createBoundJobsRecoveryHarness } from '#tests/helpers/bound-jobs-recovery.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { JobStore } from '#src/jobs/store.js';
import { writeProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import {
  NOTHING_TO_INHERIT_REASON,
  type ProviderProxySetInheritance,
} from '#src/coordinator/services/provider-proxy-set-inheritance.js';
import type { RecoveryCapableService, ProviderRecoveryAuthority } from '#src/jobs/reconcile/contracts.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { ProviderOperationRuntimeMeta } from '#src/jobs/runtime-meta.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';

import { providerOperationRecord } from '../../../store/provider-operation-fixtures.js';

/**
 * Finding 1's routing decision lives in `runRecoveryAdoption`'s inheritance pre-pass
 * (`coordinator/services/recovery/index.ts`): the instant a job's operation is inherited from a predecessor,
 * this coordinator must give `coral-cli abort` something real to reach for it — before the recovery-registry
 * entry that used to (falsely) report success is even retired. `RecoveryService.registerInheritedAppServerAbort`
 * itself is covered by `service.test.ts`; this file proves the *pre-pass* actually calls it, for the right
 * job, the moment inheritance succeeds — not later, and not never.
 */

const NAMESPACE = 'inherited-abort-tests';
const PROJECT_ROOT = '/tmp/coral-inherited-abort-project';
const BACKEND_NAMESPACE = NAMESPACE;

function createProgressStore(runtime: ReturnType<typeof createRealRuntime>): JobStore {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return new JobStore(NAMESPACE, runtime, createEventBodyCodec(), { db, providers: permissiveProviderLookupPort });
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

function committedLocator(overrides: {
  jobId: string;
  operationId: string;
  proxyInstanceId: string;
}): ProviderOperationRuntimeMeta {
  return {
    version: 1,
    jobId: overrides.jobId,
    operationId: overrides.operationId,
    buildSetId: randomUUID(),
    hostFingerprint: '0'.repeat(64),
    guardianInstanceId: randomUUID(),
    guardianPid: 100,
    guardianProcessStartedAtSeconds: 1,
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: overrides.proxyInstanceId,
    proxyPid: 200,
    reaperInstanceId: randomUUID(),
    reaperPid: 300,
    reaperProcessStartedAtSeconds: 2,
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'posix-group',
    proxyProcessStartedAtSeconds: 3,
    proxyProcessGroupId: 200,
    canonicalEndpoint: '/tmp/proxy.sock',
    reservation: randomUUID(),
    providerRootPid: 7_001,
    providerRootProcessStartedAtSeconds: 800,
    jointContainmentReceipt: 'joint-1',
    committedThroughProviderSeq: 0,
  };
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
    registerInheritedAppServerAbort: vi.fn(),
    ...overrides,
  } as RecoveryCapableService;
}

describe('runRecoveryAdoption inheritance pre-pass', () => {
  it('routes an inherited app-server job through registerInheritedAppServerAbort and retires its recovery-registry entry before the settle loop', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = 'inherited-app-server-session';
    const operationId = randomUUID();
    const proxyInstanceId = randomUUID();
    seedRunningAppServerJob(progressStore, { jobId, sessionId, provider: 'codex', proxyInstanceId });
    writeProviderOperationRuntimeMeta(progressStore.getDb(), committedLocator({ jobId, operationId, proxyInstanceId }));

    const fakeService = createFakeService();
    const createInvocationContext = (projectRoot: string): InvocationContext => ({
      projectRoot,
      pluginRoot: '/tmp/plugin',
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
    });
    const getRecoveryService = (): RecoveryCapableService => fakeService;

    const fakeSet = { proxyInstanceId: 'proxy-instance-1' } as never;
    const inheritProviderProxySet = vi.fn(async () => ({
      kind: 'inherited' as const,
      set: fakeSet,
      adoptedJobIds: new Set([jobId]),
    }));
    const providerProxyInheritance: ProviderProxySetInheritance = { inheritProviderProxySet };

    const log = vi.fn();
    const signal = new AbortController().signal;
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
        instanceId: 'inherited-abort-test',
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
        providerProxyInheritance,
        log,
      },
      boundRecovery.bound,
    );

    await boundRecovery.run(recoveryCoordinator);

    // The routing decision itself: inheritance succeeding must reach `registerInheritedAppServerAbort` for
    // this exact job, or `coral-cli abort` has nothing real to find once the recovery walk finishes.
    expect(fakeService.registerInheritedAppServerAbort).toHaveBeenCalledWith(jobId);
    // It must never fall through to the old broken path this finding exists to close.
    expect(fakeService.interruptAppServerJob).not.toHaveBeenCalled();
    expect(fakeService.finalizeInterruptedAppServerJob).not.toHaveBeenCalled();
    // The recovery-registry entry is gone by the time the whole walk settles — whether that happened in the
    // pre-pass (this fix) or only later in the settle loop's own cleanup is exactly the window this fix closes,
    // but either way nothing should still be holding the job hostage to the broken handler.
    expect(recoveryCoordinator.getRecoveryRegistry()?.has(jobId) ?? false).toBe(false);
  });
});

describe('runStartupRecovery provider-operation ownership', () => {
  it('does not let generic recovery decide a job still owned by a pending saga row', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);
    const jobId = randomUUID();
    const sessionId = 'pending-saga-session';
    const proxyInstanceId = randomUUID();
    seedRunningAppServerJob(progressStore, { jobId, sessionId, provider: 'codex', proxyInstanceId });
    const fixture = providerOperationRecord('proxy-activation-pending');
    const pending = providerOperationRecordSchema.parse({
      ...fixture,
      operation: {
        ...fixture.operation,
        jobId,
        operationId: randomUUID(),
        proxyInstanceId,
      },
      locator: {
        ...fixture.locator,
        proxy: { ...fixture.locator.proxy, instanceId: proxyInstanceId },
      },
    });
    insertProviderOperation(progressStore.getDb(), pending);

    const fakeService = createFakeService();
    const createInvocationContext = (projectRoot: string): InvocationContext => ({
      projectRoot,
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
  });
});

/**
 * Finding 1: `readProviderOperationRuntimeMetaForJob` fails loud on a corrupt `provider_operation.v1` row by
 * design (its own doc — a silent `null` would misroute back through the probe/openReplacement path adoption
 * exists to close off). But "loud" must stay scoped to the one job whose row is corrupt; before this fix, the
 * pre-pass let that throw escape the whole `for (const job of runningJobs)` loop, which propagates out of
 * `runRecoveryAdoption` uncaught and aborts the entire coordinator boot — bricking startup for every other
 * running job the pre-pass exists to recover, not just the corrupt one.
 */
describe('runRecoveryAdoption inheritance pre-pass — corrupt locator resilience', () => {
  it('does not abort recovery when one running job has a corrupt provider_operation.v1 row, and the healthy job still recovers', async () => {
    const runtime = createRealRuntime('prod');
    const progressStore = createProgressStore(runtime);

    const healthyJobId = randomUUID();
    const corruptJobId = randomUUID();
    seedRunningAppServerJob(progressStore, {
      jobId: healthyJobId,
      sessionId: 'healthy-app-server-session',
      provider: 'codex',
      proxyInstanceId: randomUUID(),
    });
    writeProviderOperationRuntimeMeta(
      progressStore.getDb(),
      committedLocator({ jobId: healthyJobId, operationId: randomUUID(), proxyInstanceId: randomUUID() }),
    );
    seedRunningAppServerJob(progressStore, {
      jobId: corruptJobId,
      sessionId: 'corrupt-app-server-session',
      provider: 'codex',
      proxyInstanceId: randomUUID(),
    });
    // Written directly rather than through `writeProviderOperationRuntimeMeta`, which only ever produces
    // bytes the codec can decode — this reproduces on-disk corruption of a coordinator-only-written row.
    progressStore
      .getDb()
      .prepare<[string, string]>('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(`provider_operation.v1:${corruptJobId}:${randomUUID()}`, 'not valid json');

    const fakeService = createFakeService();
    const createInvocationContext = (projectRoot: string): InvocationContext => ({
      projectRoot,
      pluginRoot: '/tmp/plugin',
      coralEnv: {},
      principal: testProjectPrincipal(projectRoot),
    });
    const getRecoveryService = (): RecoveryCapableService => fakeService;

    // Nothing is actually redeemed in this test — the point is that the corrupt read for `corruptJobId` does
    // not stop the pre-pass from reaching (or skipping past) `healthyJobId` in the same loop.
    const inheritProviderProxySet = vi.fn(async () => ({
      kind: 'not-bequeathed' as const,
      reason: NOTHING_TO_INHERIT_REASON,
    }));
    const providerProxyInheritance: ProviderProxySetInheritance = { inheritProviderProxySet };

    const log = vi.fn();
    const signal = new AbortController().signal;
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
        instanceId: 'corrupt-locator-test',
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
        providerProxyInheritance,
        log,
      },
      boundRecovery.bound,
    );

    // The corrupt row must not reject the whole recovery walk.
    await expect(boundRecovery.run(recoveryCoordinator)).resolves.toBeUndefined();

    // Both jobs reached ordinary carrier-detached finalization: the corrupt locator neither crashed the walk
    // (which would have stopped `healthyJobId` from ever settling) nor silently vanished `corruptJobId`
    // itself — it falls through to the same settle path any other non-bequeathed job takes.
    expect(fakeService.finalizeInterruptedAppServerJob).toHaveBeenCalledTimes(2);
    const finalizedJobIds = vi
      .mocked(fakeService.finalizeInterruptedAppServerJob)
      .mock.calls.map(([authority]) => authority.launchRecord.jobId)
      .sort();
    expect(finalizedJobIds).toEqual([corruptJobId, healthyJobId].sort());
  });
});
