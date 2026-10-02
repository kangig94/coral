import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createExecutionServices } from '#src/coordinator/composition/execution-services.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import { attemptProviderProxySetInheritance } from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import { createProviderProxySetContainmentProver } from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { createProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationsDue,
} from '#src/store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import type { StoragePort, TimePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ProcessPort, Runtime } from '#src/runtime/ports.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { decodeBody } from '#src/store/body-codec.js';
import type { EventsRow } from '#src/store/schema.js';
import { jobProgressBodySchema } from '#src/jobs/event-bodies.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { JobStore } from '#src/jobs/store.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createProviderOperationStartupOwnership } from '#src/coordinator/services/recovery/provider-operation-startup-ownership.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';
const FIXTURE_PROCESS_LONG_GONE_INCARNATION = testIncarnation(9_000);
async function drainMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}
function createDb(records: readonly ProviderOperationRecord[]): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  for (const record of records) insertProviderOperation(db, record);
  return db;
}

function noCapsuleStorage(base: StoragePort): StoragePort {
  return Object.assign(base, { readdirSync: (() => []) as StoragePort['readdirSync'] });
}

function sandboxedRuntime(time: TimePort): Runtime {
  const base = createRealRuntime('prod');
  return {
    ...base,
    time,
    storage: noCapsuleStorage(new InMemoryStorage(time)),
    process: absentProcessPort(base.process),
  } satisfies Runtime;
}

function absentProcessPort(base: ProcessPort): ProcessPort {
  return {
    ...base,
    observeLiveness: () => 'absent' as const,
    kill: () => false,
    readProcessIncarnation: () => FIXTURE_PROCESS_LONG_GONE_INCARNATION,
  };
}

function composeProductionStartup(
  record: ProviderOperationRecord,
  inheritance: unknown,
  runtime: Runtime,
  createProgressStore: (db: Database) => JobStore,
) {
  const db = createDb([record]);
  const { time } = runtime;
  const fatals = vi.fn();
  const lifecycleRef = new ProviderProxySetLifecycleRef();
  const progressStore = createProgressStore(db);
  const launchCoordinator = new LaunchCoordinator({ runtime });
  const startupOwnership = createProviderOperationStartupOwnership({
    runtime,
    progressStore,
    binding: launchCoordinator,
    log: () => undefined,
  });
  const world = {
    identity: { instanceId: randomUUID(), buildSetId: FIXTURE_BUILD_SET_ID },
    storeServicesRef: { tryGet: () => ({ progressStore }) },
    operationRegistry: new LocalOperationRegistry(),
    providerProxyClaims: new ProviderProxySetClaimMirror(),
    providerProxyLifecycleRef: lifecycleRef,
    providerProxyInheritance: inheritance,
    providerProxySetContainmentProver: createProviderProxySetContainmentProver(runtime),
    reapRecordedContainment: () => {
      throw new Error('provider proxy startup fixture unexpectedly requested recorded containment reaping');
    },
    providerHostManager: {},
    launchCoordinator,
  } as never;
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: 'provider-proxy-startup-integration',
    backendNamespace: 'provider-proxy-startup-integration',
    settlementRefusalRecorder: { record: () => true },
    onProviderProxyLifecycleFatal: fatals,
    createExecutionService: (() => {
      throw new Error('production startup fixture unexpectedly created an execution service');
    }) as never,
  });
  return {
    db,
    time,
    fatals,
    lifecycleRef,
    services,
    startupOwnership: startupOwnership.hydrate(startupOwnership.snapshot()),
    ownershipService: startupOwnership,
    launchCoordinator,
  };
}

async function productionStartupOutcome(harness: ReturnType<typeof composeProductionStartup>) {
  return harness.services
    .reconcileProviderOperationsAtStartup(harness.startupOwnership, new AbortController().signal)
    .then(
      (report) => ({ kind: 'fulfilled' as const, report }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
}

describe('orphaned provider operation retries after double startup hydration', () => {
  it.each(['cross-build', 'same-build'] as const)(
    '%s orphan settles once after double hydration without restart',
    async (build) => {
      const record = providerOperationRecord('executing');
      const time = new VirtualTime();
      const scheduled = vi.spyOn(time, 'setTimeout');
      const base = sandboxedRuntime(time);
      let observation: 'alive' | 'unknown' | 'absent' = 'alive';
      const kills = vi.fn(() => false);
      const runtime: Runtime = {
        ...base,
        process: {
          ...base.process,
          kill: kills,
          observeLiveness: () => observation,
          observeRecordedProcessAsync: async () => observation,
          readProcessIncarnation: (pid) =>
            observation === 'alive'
              ? pid === record.locator.guardian.pid
                ? record.locator.guardian.incarnation
                : pid === record.locator.reaper.pid
                  ? record.locator.reaper.incarnation
                  : pid === record.locator.proxy.pid
                    ? record.locator.proxy.incarnation
                    : testIncarnation(1_003)
              : observation === 'unknown'
                ? null
                : FIXTURE_PROCESS_LONG_GONE_INCARNATION,
        },
      };
      const prover = createProviderProxySetContainmentProver(runtime);
      const reap = vi.fn(createProviderProxySetRecordedContainmentReaper(runtime));
      const inherit = vi.fn((locator: ProviderOperationRecord, db: Database, signal: AbortSignal) =>
        attemptProviderProxySetInheritance(
          locator,
          db,
          {
            runtime,
            baseDir: dirname(runtime.paths.coral.generation.root),
            coordinatorIdentity: {
              instanceId: randomUUID(),
              pid: process.pid,
              incarnation: testIncarnation(1),
              generation: 'gen2',
              flavor: 'prod',
              buildSetId: build === 'same-build' ? record.operation.buildSetId : randomUUID(),
            },
            operationRegistry: new LocalOperationRegistry(),
            collectContainmentProof: prover.collectContainmentProof,
            reapRecordedContainment: reap,
          },
          signal,
        ),
      );
      let progressStore!: JobStore;
      const harness = composeProductionStartup(
        record,
        {
          inheritProviderProxySet: inherit,
          redeemDiscoveredCapsule: async () => {
            throw new Error('orphan has no capsule');
          },
        },
        runtime,
        (db) => {
          progressStore = new JobStore('provider-proxy-startup-integration', runtime, createEventBodyCodec(), {
            db,
            providers: permissiveProviderLookupPort,
          });
          const jobId = record.operation.jobId;
          seedTestSessionProjection(db, {
            sessionId: jobId,
            provider: 'codex',
            projectRoot: process.cwd(),
            backendNamespace: 'provider-proxy-startup-integration',
            activeJobId: jobId,
          });
          progressStore.appendLaunchRequested(jobId, {
            jobId,
            owner: { kind: 'provider-session', id: jobId },
            sessionId: jobId,
            provider: 'codex',
            projectRoot: process.cwd(),
            backendNamespace: 'provider-proxy-startup-integration',
            pool: 'default',
            enqueueSequence: 1,
            createdAt: '2026-08-09T12:34:55.000Z',
            jobKind: 'provider',
            providerAction: 'exec',
            request: {
              prompt: 'orphan fixture',
              cwd: fixtureCanonicalWorkDir(process.cwd()),
              bypassPermissions: false,
              coralEnv: {},
            },
          });
          progressStore.appendRuntimeStarted(jobId, {
            transport: 'app-server',
            startTime: '2026-08-09T12:34:56.000Z',
            providerMeta: {
              provider: 'codex',
              leaseState: 'acquired',
              hostRef: {
                provider: 'codex',
                fingerprint: record.locator.hostFingerprint,
                instanceId: record.operation.proxyInstanceId,
                leaseMode: 'shared',
              },
            },
          });
          return progressStore;
        },
      );
      harness.services.connectProviderOperationRecovery({
        releaseProviderOperationStartupOwnership: harness.ownershipService.release,
      } as never);
      const restore = vi.spyOn(harness.launchCoordinator, 'restoreActiveLaunch');
      try {
        expect((await productionStartupOutcome(harness)).kind).toBe('fulfilled');
        const retry = readProviderOperation(harness.db, record.operation);
        expect(retry?.retryNotBeforeMs).toBeGreaterThan(time.now());
        expect(retry?.retryNotBeforeMs).toBeLessThan(time.now() + 60_001);
        const second = harness.ownershipService.hydrate(harness.ownershipService.snapshot());
        expect(second.completion.kind).toBe('complete');
        expect(second.records[0].restoredPermit).toBe(harness.startupOwnership.records[0].restoredPermit);
        expect(restore).not.toHaveBeenCalled();
        expect(harness.launchCoordinator.getActiveJobIds('default')).toEqual([record.operation.jobId]);
        const afterHydration = readProviderOperation(harness.db, record.operation);
        expect(afterHydration?.retryNotBeforeMs).toBe(retry?.retryNotBeforeMs);

        observation = 'unknown';
        harness.services.startProviderOperationReconciler();
        time.tick(25);
        await vi.waitFor(() => expect(scheduled.mock.calls.at(-1)?.[1]).toBe(2_000));
        time.tick(2_000);
        await vi.waitFor(() => expect(inherit.mock.calls.length).toBeGreaterThan(1));
        await vi.waitFor(() =>
          expect(readProviderOperation(harness.db, record.operation)?.lastError?.observedAtMs).toBe(time.now()),
        );
        const unknown = readProviderOperation(harness.db, record.operation);
        expect(unknown?.retryNotBeforeMs).toBeGreaterThan(time.now());
        expect(unknown?.retryNotBeforeMs).toBeLessThan(time.now() + 60_001);
        expect(progressStore.readStatus(record.operation.jobId)?.phase).toBe('running');
        expect(
          progressStore.readJobEvents(record.operation.jobId).filter((event) => event.type === 'terminal'),
        ).toHaveLength(0);
        expect(harness.launchCoordinator.getActiveJobIds('default')).toEqual([record.operation.jobId]);

        await vi.waitFor(() => expect(scheduled.mock.calls.at(-1)?.[1]).toBe(2_000));
        const attemptsBeforeAbsence = inherit.mock.calls.length;
        observation = 'absent';
        time.tick(2_000);
        await vi.waitFor(() => expect(inherit.mock.calls.length).toBeGreaterThan(attemptsBeforeAbsence));
        await drainMicrotasks(200);
        await vi.waitFor(() => expect(readProviderOperation(harness.db, record.operation)).toBeNull(), {
          timeout: 5_000,
        });
        time.tick(2_000);
        await drainMicrotasks(100);
        expect(
          progressStore.readJobEvents(record.operation.jobId).filter((event) => event.type === 'terminal'),
        ).toEqual([
          expect.objectContaining({
            result: expect.objectContaining({ outcome: expect.objectContaining({ kind: 'failed' }) }),
          }),
        ]);
        const terminal = progressStore.readJobEvents(record.operation.jobId).find((event) => event.type === 'terminal');
        if (terminal?.result.outcome.kind !== 'failed') throw new Error('expected a failed orphan terminal');
        const cause = harness.db
          .prepare<[number], EventsRow>('SELECT * FROM events WHERE seq = ?')
          .get(terminal.result.outcome.causeRef.seq);
        if (cause === undefined) throw new Error('missing orphan terminal cause');
        expect(decodeBody(cause, jobProgressBodySchema, progressStore)).toMatchObject({
          kind: 'domain',
          stage: 'provider_operation_failed',
          detail: { code: 'provider_lost' },
        });
        expect(progressStore.readStatus(record.operation.jobId)?.phase).toBe('error');
        expect(readProviderOperationsDue(harness.db, Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
        expect(harness.launchCoordinator.reservationFor(record.operation.jobId)).toBeNull();
        expect(harness.launchCoordinator.settleProviderOperationBinding(record.operation)).toEqual({
          kind: 'settled-unbound',
        });
        expect(harness.ownershipService.release(record.operation)).toEqual({ kind: 'not-owned' });
        expect(reap).toHaveBeenCalledOnce();
        expect(kills).not.toHaveBeenCalled();
        expect(harness.fatals).not.toHaveBeenCalled();
      } finally {
        harness.services.stopProviderOperationReconciler();
        harness.ownershipService.releaseAll();
        harness.db.close();
      }
    },
    5_000,
  );
});
