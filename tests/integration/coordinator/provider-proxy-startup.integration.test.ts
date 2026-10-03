import { randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import {
  durableProviderProxySetOperatorDispositionRecord,
  ProviderProxySetOperatorDispositionStore,
} from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import { describe, expect, it, vi } from 'vitest';
import { createExecutionServices } from '#src/coordinator/composition/execution-services.js';
import {
  PROVIDER_OPERATION_STARTUP_BOUND_MS,
  StartupSetRecoveryProducer,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import { attemptProviderProxySetInheritance } from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import {
  createProviderProxySetContainmentProver,
  releaseProviderProxySetContainmentProofFence,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { createProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  insertProviderOperation,
  compareAndSwapProviderOperation,
  readProviderOperation,
  readProviderOperationsDue,
  providerOperationMutationAdmission,
  ProviderOperationMutationSetClosedError,
  ProviderOperationMutationAdmission,
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
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
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
  record: ProviderOperationRecord | null,
  inheritance: unknown,
  runtime: Runtime,
  createProgressStore: (db: Database) => JobStore,
  additionalRecords: readonly ProviderOperationRecord[] = [],
) {
  const db = createDb(record === null ? additionalRecords : [record, ...additionalRecords]);
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
  const containmentProver = createProviderProxySetContainmentProver(runtime);
  const reapRecordedContainment = vi.fn<ReturnType<typeof createProviderProxySetRecordedContainmentReaper>>(() => {
    throw new Error('provider proxy startup fixture unexpectedly requested recorded containment reaping');
  });
  const world = {
    identity: { instanceId: randomUUID(), buildSetId: FIXTURE_BUILD_SET_ID },
    storeServicesRef: { tryGet: () => ({ progressStore }) },
    operationRegistry: new LocalOperationRegistry(),
    providerProxyClaims: new ProviderProxySetClaimMirror(),
    providerProxyLifecycleRef: lifecycleRef,
    providerProxyInheritance: inheritance,
    providerProxySetContainmentProver: containmentProver,
    reapRecordedContainment,
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
    containmentProver,
    reapRecordedContainment,
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

describe('startup reconciliation deadline succession', () => {
  it('applies inherited control socket events and transferred fence writes after detachment', async () => {
    const record = providerOperationRecord('settlement-pending');
    const time = new VirtualTime();
    const runtime = sandboxedRuntime(time);
    const directory = mkdtempSync(join(tmpdir(), 'coral-detached-socket-'));
    const endpoint = join(directory, 'control.sock');
    let peer!: Socket;
    const server = createServer((socket) => {
      peer = socket;
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let client: Awaited<ReturnType<typeof connectControlClient>> | undefined;
    let fence: ReturnType<ProviderOperationMutationAdmission['closeSet']> | undefined;
    let recoverySignal: AbortSignal | undefined;
    const recover = vi
      .spyOn(StartupSetRecoveryProducer.prototype, 'recoverSetAtStartup')
      .mockImplementationOnce(async (work, signal) => {
        recoverySignal = signal;
        const admission = providerOperationMutationAdmission(harness.db);
        client = await connectControlClient(endpoint, runtime.time, 5_000, (request) =>
          admission.runSync(
            'inherited-provider-event',
            () => {
              const current = readProviderOperation(harness.db, record.operation);
              if (current === null) throw new Error('missing socket event record');
              expect(
                compareAndSwapProviderOperation(harness.db, current, { ...current, revision: current.revision + 1 }),
              ).toMatchObject({ kind: 'updated' });
              return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
            },
            work.identity,
          ),
        );
        fence = admission.closeSet(work.identity);
        await wait;
        fence.release();
        return { kind: 'retry-scheduled', reason: 'fixture recovery settled', nextAttemptAtMs: time.now() + 10_000 };
      });
    const harness = composeProductionStartup(
      record,
      undefined,
      runtime,
      (db) =>
        new JobStore('provider-proxy-startup-integration', runtime, createEventBodyCodec(), {
          db,
          providers: permissiveProviderLookupPort,
        }),
    );
    let finishWriter!: () => void;
    const writerWait = new Promise<void>((resolve) => {
      finishWriter = resolve;
    });
    let writer: Promise<void> | undefined;
    try {
      const startup = productionStartupOutcome(harness);
      await vi.waitFor(() => expect(fence).toBeDefined());
      // The fence is transferred to a caller outside the startup recovery context.
      writer = fence?.run('transferred-fence-writer', async () => {
        await writerWait;
        const current = readProviderOperation(harness.db, record.operation);
        if (current === null) throw new Error('missing transferred writer record');
        expect(
          compareAndSwapProviderOperation(harness.db, current, { ...current, revision: current.revision + 1 }),
        ).toMatchObject({ kind: 'updated' });
      });
      time.tick(PROVIDER_OPERATION_STARTUP_BOUND_MS);
      expect(await startup).toMatchObject({ kind: 'fulfilled' });
      expect(fence?.isHeld()).toBe(true);
      // Negative control: callers outside the admitted recovery cannot bypass its set fence.
      const sendEvent = () =>
        new Promise<unknown>((resolve) => {
          peer.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').split('\n')[0])));
          peer.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 7,
              method: 'provider.event.v1',
              params: {
                operation: record.operation,
                providerSeq: 1,
                event: { kind: 'progress', message: 'after bound' },
              },
            }) + '\n',
          );
        });
      expect(() =>
        providerOperationMutationAdmission(harness.db).runSync('external-write', () => undefined, record.operation),
      ).toThrow(ProviderOperationMutationSetClosedError);
      finishWriter();
      await writer;
      expect(readProviderOperation(harness.db, record.operation)?.revision).toBe(record.revision + 1);
      expect(fence?.isHeld()).toBe(true);
      fence?.release();
      await expect(sendEvent()).resolves.toMatchObject({ result: { kind: 'ack', committedThroughProviderSeq: 1 } });
      expect(readProviderOperation(harness.db, record.operation)?.revision).toBe(record.revision + 2);
      expect(recoverySignal?.aborted).toBe(false);
      expect(recover).toHaveBeenCalledOnce();
      release();
      await drainMicrotasks(100);
      expect(harness.services.providerOperationStartupStatus()).toBeNull();
      expect(readProviderOperation(harness.db, record.operation)?.retryCount).toBe(1);
      await expect(sendEvent()).resolves.toMatchObject({ result: { kind: 'ack', committedThroughProviderSeq: 1 } });
    } finally {
      finishWriter();
      await writer;
      release();
      await drainMicrotasks(100);
      client?.close();
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
      harness.services.stopProviderOperationReconciler();
      harness.ownershipService.releaseAll();
      harness.db.close();
      vi.restoreAllMocks();
    }
  });

  it.each([1, 2])('initialization-only dispositions converge after detachment (%s stale sets)', async (setCount) => {
    const record = providerOperationRecord('settlement-pending');
    const time = new VirtualTime();
    const schedule = time.setTimeout.bind(time);
    // Preserve the scheduling context just as a real Node timer does.
    vi.spyOn(time, 'setTimeout').mockImplementation((callback, delay) => schedule(AsyncResource.bind(callback), delay));
    const runtime = sandboxedRuntime(time);
    const store = new ProviderProxySetOperatorDispositionStore(runtime.storage, runtime.paths.coral.coordinator.runDir);
    const stale = Array.from({ length: setCount }, (_, index) =>
      durableProviderProxySetOperatorDispositionRecord({
        writerIncarnation: 'previous-coordinator',
        setIdentity: {
          ...providerProxySetIdentityFromRecord(record),
          proxyInstanceId: index === 0 ? record.operation.proxyInstanceId : randomUUID(),
        },
        subjectKey: 'proxy',
        disposition: { disposition: 'held', incidentReason: 'control loss', waitingFor: 'control-reattachment' },
        status: { kind: 'stale', markedByIncarnation: 'previous-coordinator', markedAtMs: 1 },
      }),
    );
    expect(store.replace(stale).kind).toBe('recorded');
    const harness = composeProductionStartup(
      null,
      undefined,
      runtime,
      (db) =>
        new JobStore('provider-proxy-startup-integration', runtime, createEventBodyCodec(), {
          db,
          providers: permissiveProviderLookupPort,
        }),
    );
    harness.reapRecordedContainment.mockResolvedValue({
      kind: 'containment-absent',
      disappearanceReceipt: 'fixture-dispositions-absent',
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCollect = harness.containmentProver.collectContainmentProof;
    let initializationSignal: AbortSignal | undefined;
    const collect = vi
      .spyOn(harness.containmentProver, 'collectContainmentProof')
      .mockImplementationOnce(async (authorization, db, signal) => {
        initializationSignal = signal;
        await wait;
        // Force the first attempt to retry, so the actual lifecycle timer must remain usable.
        const proof = await originalCollect(authorization, db, signal);
        releaseProviderProxySetContainmentProofFence(proof);
        throw new Error('fixture temporary disposition observation failure');
      });
    try {
      const startup = productionStartupOutcome(harness);
      await vi.waitFor(() => expect(collect).toHaveBeenCalledOnce());
      expect(harness.services.providerOperationStartupStatus()).toMatchObject({
        sets: [],
        initialization: { state: 'recovering', pendingMutations: [] },
      });
      time.tick(PROVIDER_OPERATION_STARTUP_BOUND_MS);
      expect(await startup).toMatchObject({
        kind: 'fulfilled',
        report: { setsVisited: 0, incidents: [{ kind: 'startup-initialization-detached' }] },
      });
      expect(harness.services.providerOperationStartupStatus()).toMatchObject({
        phase: 'detached',
        sets: [],
        initialization: { state: 'detached', incident: 'startup-initialization-detached' },
      });
      time.tick(60_000);
      await drainMicrotasks();
      expect(store.read().records).toHaveLength(setCount);
      release();
      await drainMicrotasks(100);
      // Retry timers created by the detached initialization execute in its original context.
      time.tick(60_000);
      await drainMicrotasks(100);
      expect(store.read().records).toEqual([]);
      expect(initializationSignal?.aborted).toBe(false);
      expect(collect.mock.calls.length).toBeGreaterThan(setCount);
      expect(harness.services.providerOperationStartupStatus()).toBeNull();
      expect(harness.fatals).not.toHaveBeenCalled();
    } finally {
      release();
      await drainMicrotasks(100);
      harness.services.stopProviderOperationReconciler();
      harness.ownershipService.releaseAll();
      harness.db.close();
      vi.restoreAllMocks();
    }
  });

  it('production inheritance retries behind an overlapping disposition fence', async () => {
    const record = providerOperationRecord('settlement-pending');
    const time = new VirtualTime();
    const runtime = sandboxedRuntime(time);
    const prover = createProviderProxySetContainmentProver(runtime);
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const collect = vi.spyOn(prover, 'collectContainmentProof');
    const inherit = vi.fn(async (locator: ProviderOperationRecord, db: Database, signal: AbortSignal) => {
      await wait;
      return attemptProviderProxySetInheritance(
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
            buildSetId: record.operation.buildSetId,
          },
          operationRegistry: new LocalOperationRegistry(),
          collectContainmentProof: prover.collectContainmentProof,
          reapRecordedContainment: () => {
            throw new Error('competing inheritance must not reap');
          },
        },
        signal,
      );
    });
    const harness = composeProductionStartup(
      record,
      {
        inheritProviderProxySet: inherit,
        redeemDiscoveredCapsule: async () => {
          throw new Error('no discovered capsule');
        },
      },
      runtime,
      (db) =>
        new JobStore('provider-proxy-startup-integration', runtime, createEventBodyCodec(), {
          db,
          providers: permissiveProviderLookupPort,
        }),
    );
    let fence: ReturnType<ReturnType<typeof providerOperationMutationAdmission>['closeSet']> | undefined;
    try {
      const startup = productionStartupOutcome(harness);
      await vi.waitFor(() => expect(inherit).toHaveBeenCalledOnce());
      const admission = providerOperationMutationAdmission(harness.db);
      fence = admission.closeSet(providerProxySetIdentityFromRecord(record));
      expect(fence.kind).toBe('holding');
      expect(collect).not.toHaveBeenCalled();
      // A second admitted closer receives a retry; the existing closer still waits for its writes.
      resume();
      const result = await startup;
      expect(result).toMatchObject({
        kind: 'fulfilled',
        report: {
          incidents: [
            expect.objectContaining({
              kind: 'set-retry-scheduled',
              reason: 'mutation-set-fenced',
            }),
          ],
        },
      });
      expect(collect).not.toHaveBeenCalled();
      expect(readProviderOperation(harness.db, record.operation)?.retryCount).toBe(1);
      expect(() => admission.runSync('proof-overlapping-write', () => undefined, record.operation)).toThrow(
        ProviderOperationMutationSetClosedError,
      );
      if (fence.kind === 'holding') await fence.retryAfter;
      fence.release();
      expect(admission.pendingMutations()).toEqual([]);
      expect(harness.fatals).not.toHaveBeenCalled();
    } finally {
      resume();
      fence?.release();
      harness.services.stopProviderOperationReconciler();
      harness.ownershipService.releaseAll();
      harness.db.close();
    }
  });

  it('a detached disappearance finishes under its original owner and releases its fence', async () => {
    const record = providerOperationRecord('settlement-pending');
    const time = new VirtualTime();
    const runtime = sandboxedRuntime(time);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fence: ReturnType<ProviderOperationMutationAdmission['closeSet']> | undefined;
    let blocked = false;
    const originalRun = ProviderOperationMutationAdmission.prototype.run;
    vi.spyOn(ProviderOperationMutationAdmission.prototype, 'run').mockImplementation(function (
      this: ProviderOperationMutationAdmission,
      label,
      mutation,
      set,
    ) {
      if (label !== 'provider-containment-disappearance' || blocked)
        return originalRun.call(this, label, mutation, set);
      blocked = true;
      return originalRun.call(
        this,
        label,
        async () => {
          fence = this.closeSet(record.operation);
          try {
            await wait;
            return await mutation();
          } finally {
            fence.release();
          }
        },
        set,
      );
    });
    const inherit = vi.fn(async () => ({
      kind: 'containment-disappeared' as const,
      disappearanceReceipt: 'absent-fixture',
    }));
    const harness = composeProductionStartup(
      record,
      { inheritProviderProxySet: inherit },
      runtime,
      (db) =>
        new JobStore('provider-proxy-startup-integration', runtime, createEventBodyCodec(), {
          db,
          providers: permissiveProviderLookupPort,
        }),
    );
    try {
      const startup = productionStartupOutcome(harness);
      await vi.waitFor(() => expect(fence).toBeDefined());
      time.tick(PROVIDER_OPERATION_STARTUP_BOUND_MS);
      expect(await startup).toMatchObject({
        kind: 'fulfilled',
        report: { incidents: [expect.objectContaining({ kind: 'startup-deadline-expired' })] },
      });
      harness.services.startProviderOperationReconciler();
      time.tick(25);
      await drainMicrotasks();
      expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
      expect(fence?.isHeld()).toBe(true);
      expect(inherit).toHaveBeenCalledOnce();
      release();
      await drainMicrotasks(100);
      expect(harness.fatals).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 10 && readProviderOperation(harness.db, record.operation) !== null; attempt++) {
        time.tick(2_000);
        await drainMicrotasks(100);
      }
      expect(readProviderOperation(harness.db, record.operation)).toBeNull();
      expect(inherit).toHaveBeenCalledOnce();
      expect(fence?.isHeld()).toBe(false);
      expect(harness.services.providerOperationStartupStatus()).toBeNull();
      expect(providerOperationMutationAdmission(harness.db).pendingMutations()).toEqual([]);
      const lateMutation = vi.fn();
      await expect(fence?.run('late-proof-publication', lateMutation)).rejects.toThrow();
      expect(lateMutation).not.toHaveBeenCalled();
    } finally {
      release();
      await drainMicrotasks(100);
      fence?.release();
      harness.services.stopProviderOperationReconciler();
      harness.ownershipService.releaseAll();
      harness.db.close();
      vi.restoreAllMocks();
    }
  });

  it('bounds disposition initialization before visiting any provider set', async () => {
    const record = providerOperationRecord('settlement-pending');
    const time = new VirtualTime();
    const runtime = sandboxedRuntime(time);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialize = vi
      .spyOn(ProviderProxySetLifecycle.prototype, 'reconcileDurableOperatorDispositions')
      .mockImplementationOnce(async () => {
        await wait;
        return { kind: 'completed' };
      });
    const harness = composeProductionStartup(
      record,
      undefined,
      runtime,
      (db) =>
        new JobStore('provider-proxy-startup-integration', runtime, createEventBodyCodec(), {
          db,
          providers: permissiveProviderLookupPort,
        }),
    );
    try {
      const startup = productionStartupOutcome(harness);
      await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
      expect(harness.services.providerOperationStartupStatus()).toMatchObject({
        phase: 'recovering',
        sets: [expect.objectContaining({ state: 'queued', pendingMutations: [] })],
      });
      time.tick(PROVIDER_OPERATION_STARTUP_BOUND_MS);
      expect(await startup).toMatchObject({
        kind: 'fulfilled',
        report: {
          setsVisited: 0,
          incidents: expect.arrayContaining([
            expect.objectContaining({ kind: 'startup-deadline-expired' }),
            { kind: 'startup-initialization-detached' },
          ]),
        },
      });
      expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
    } finally {
      release();
      await drainMicrotasks();
      harness.services.stopProviderOperationReconciler();
      harness.ownershipService.releaseAll();
      harness.db.close();
      vi.restoreAllMocks();
    }
  });

  it('keeps stalled sets detached while a completed set progresses through the due poll', async () => {
    const record = providerOperationRecord('settlement-pending');
    const second = providerOperationRecord('settlement-pending', {
      operation: {
        ...record.operation,
        operationId: randomUUID(),
        jobId: randomUUID(),
        proxyInstanceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      },
      locator: {
        ...record.locator,
        proxy: { ...record.locator.proxy, instanceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
      },
    });
    const completed = providerOperationRecord('settlement-pending', {
      operation: {
        ...record.operation,
        jobId: randomUUID(),
        operationId: randomUUID(),
        proxyInstanceId: '00000000-0000-4000-8000-000000000000',
      },
      locator: {
        ...record.locator,
        proxy: { ...record.locator.proxy, instanceId: '00000000-0000-4000-8000-000000000000' },
      },
    });
    let completedSignal: AbortSignal | undefined;
    const time = new VirtualTime();
    const runtime = sandboxedRuntime(time);
    const recover = vi
      .spyOn(StartupSetRecoveryProducer.prototype, 'recoverSetAtStartup')
      .mockImplementation((work, signal) => {
        if (work.identity.proxyInstanceId !== completed.operation.proxyInstanceId) return new Promise(() => undefined);
        completedSignal = signal;
        return Promise.resolve({
          kind: 'retry-scheduled',
          reason: 'completed-set-control',
          nextAttemptAtMs: time.now() + 10_000,
        });
      });
    const harness = composeProductionStartup(
      record,
      undefined,
      runtime,
      (db) =>
        new JobStore('provider-proxy-startup-integration', runtime, createEventBodyCodec(), {
          db,
          providers: permissiveProviderLookupPort,
        }),
      [
        second,
        completed,
        ...Array.from({ length: 31 }, () =>
          providerOperationRecord('settlement-pending', {
            operation: { ...record.operation, jobId: randomUUID(), operationId: randomUUID() },
          }),
        ),
      ],
    );
    try {
      let result: Awaited<ReturnType<typeof productionStartupOutcome>> | undefined;
      const pending = productionStartupOutcome(harness).then((outcome) => {
        result = outcome;
      });
      await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(3));
      time.tick(PROVIDER_OPERATION_STARTUP_BOUND_MS - 1);
      await drainMicrotasks();
      expect(result).toBeUndefined();
      time.tick(1);
      await pending;
      expect(result).toMatchObject({
        kind: 'fulfilled',
        report: {
          setsVisited: 3,
          operationsVisited: 34,
          incidents: [
            expect.objectContaining({ kind: 'set-retry-scheduled', reason: 'completed-set-control' }),
            expect.objectContaining({
              kind: 'startup-deadline-expired',
              successor: 'detached-startup-recovery',
            }),
            expect.objectContaining({
              kind: 'startup-deadline-expired',
              successor: 'detached-startup-recovery',
            }),
          ],
        },
      });
      expect(harness.services.providerOperationStartupStatus()?.sets.map(({ setKey }) => setKey)).toHaveLength(2);
      expect(completedSignal?.aborted).toBe(false);
      if (completedSignal === undefined) throw new Error('completed set recovery signal was not captured');
      await expect(
        providerOperationMutationAdmission(harness.db).runRecovery(
          'completed-set-callback',
          () => 'still-admitted',
          completed.operation,
          completedSignal,
        ),
      ).resolves.toBe('still-admitted');
      harness.services.startProviderOperationReconciler();
      time.tick(25);
      await drainMicrotasks();
      expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
      expect(readProviderOperation(harness.db, second.operation)).toMatchObject({
        operation: second.operation,
        phase: second.phase,
      });
      expect(readProviderOperation(harness.db, second.operation)?.retryCount).toBe(0);
      time.tick(10_000);
      await drainMicrotasks(100);
      const progressed = readProviderOperation(harness.db, completed.operation);
      expect(progressed === null || progressed.retryCount > 1).toBe(true);
      expect(recover).toHaveBeenCalledTimes(3);
      expect(harness.services.providerOperationStartupStatus()).toMatchObject({ phase: 'detached', elapsedMs: 10_525 });
      expect(providerOperationMutationAdmission(harness.db).pendingMutations()).toContain(
        'provider-operation-startup-reconciliation',
      );
    } finally {
      harness.services.stopProviderOperationReconciler();
      harness.ownershipService.releaseAll();
      harness.db.close();
      vi.restoreAllMocks();
    }
  });
});

it('detached disposition initialization fences its own set while an unrelated set drains', async () => {
  const record = providerOperationRecord('settlement-pending');
  const time = new VirtualTime();
  const schedule = time.setTimeout.bind(time);
  time.setTimeout = (callback, ms) => schedule(AsyncResource.bind(callback), ms);
  const runtime = sandboxedRuntime(time);
  const dispositions = new ProviderProxySetOperatorDispositionStore(
    runtime.storage,
    runtime.paths.coral.coordinator.runDir,
  );
  const identity = providerProxySetIdentityFromRecord(record);
  expect(
    dispositions.replace([
      durableProviderProxySetOperatorDispositionRecord({
        writerIncarnation: 'previous-coordinator',
        setIdentity: identity,
        subjectKey: 'proxy',
        disposition: { disposition: 'held', incidentReason: 'control loss', waitingFor: 'control-reattachment' },
        status: { kind: 'stale', markedByIncarnation: 'previous-coordinator', markedAtMs: 1 },
      }),
    ]).kind,
  ).toBe('recorded');
  const harness = composeProductionStartup(
    record,
    undefined,
    runtime,
    (db) =>
      new JobStore('startup-initialization', runtime, createEventBodyCodec(), {
        db,
        providers: permissiveProviderLookupPort,
      }),
  );
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  harness.reapRecordedContainment.mockImplementation(async () => {
    await wait;
    return { kind: 'containment-absent', disappearanceReceipt: 'external-reaper-absent' };
  });
  let foreignFence: ReturnType<ProviderOperationMutationAdmission['closeSet']> | undefined;
  try {
    const startup = productionStartupOutcome(harness);
    await drainMicrotasks(100);
    expect(harness.reapRecordedContainment).toHaveBeenCalledOnce();
    time.tick(PROVIDER_OPERATION_STARTUP_BOUND_MS);
    expect((await startup).kind).toBe('fulfilled');
    const admission = providerOperationMutationAdmission(harness.db);
    expect(() => admission.runSync('late-own-set-write', () => undefined, identity)).toThrow(
      ProviderOperationMutationSetClosedError,
    );
    foreignFence = admission.closeSet({ proxyInstanceId: randomUUID(), buildSetId: randomUUID() });
    expect(foreignFence.kind).toBe('drained');
    expect(harness.services.providerOperationStartupStatus()?.phase).toBe('detached');
    release();
    await drainMicrotasks(200);
    expect(harness.services.providerOperationStartupStatus()).toBeNull();
    expect(harness.fatals).not.toHaveBeenCalled();
  } finally {
    foreignFence?.release();
    release();
    await drainMicrotasks(200);
    harness.services.stopProviderOperationReconciler();
    harness.ownershipService.releaseAll();
    harness.db.close();
  }
});
