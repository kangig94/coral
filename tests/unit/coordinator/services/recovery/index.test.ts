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
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import type { RecoveryCapableService, ProviderRecoveryAuthority } from '#src/jobs/reconcile/contracts.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';

import { providerOperationRecord } from '../../../store/provider-operation-fixtures.js';

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
    },
  );
});
