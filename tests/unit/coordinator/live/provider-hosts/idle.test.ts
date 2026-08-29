import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRef } from '#src/providers/contract.js';
import type * as ProviderHostsMod from '#src/coordinator/live/provider-hosts/index.js';

const productionWiring = vi.hoisted(() => ({
  carrierBlocksRetirement: null as ((hostRef: HostRef) => boolean) | null,
  reevaluateIdleRetirement: vi.fn<(hostRef: HostRef) => void>(),
}));

vi.mock('#src/coordinator/live/provider-hosts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderHostsMod>();
  return {
    ...actual,
    createProviderHostManager: (options: Parameters<typeof actual.createProviderHostManager>[0]) => {
      productionWiring.carrierBlocksRetirement = options.carrierBlocksRetirement ?? null;
      return {
        openSession: async () => {
          throw new Error('provider host session was not expected');
        },
        attachSession: async () => null,
        drainForHandoff: async () => undefined,
        shutdown: async () => undefined,
        routeAppServerOperation: () => null,
        reevaluateIdleRetirement: productionWiring.reevaluateIdleRetirement,
        liveSets: () => [],
        registerInheritedSet: () => undefined,
      };
    },
  };
});

import { activePinCount, acquireProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
import { maybeArmIdleTimer } from '#src/coordinator/live/provider-hosts/idle.js';
import { hostRefFromEntry } from '#src/coordinator/live/provider-hosts/state.js';
import { createCoordinatorWorld } from '#src/coordinator/composition/world.js';
import {
  connectProviderHostRetirementReevaluation,
  createCarrierBlocksRetirement,
} from '#src/coordinator/composition/world.js';
import type { BackendDefaultsPlan } from '#src/coordinator/composition/defaults.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { backendLog } from '#src/infra/backend-log.js';
import type { JobProjectionDetail } from '#src/jobs/read-queries.js';
import type { JobRuntime, JobStatus } from '#src/jobs/records.js';
import type { JobStore } from '#src/jobs/store.js';
import { JobStore as ProductionJobStore } from '#src/jobs/store.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { createStoreServicesRef } from '#src/coordinator/composition/store-services-ref.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { consumeJobStream } from '#src/jobs/shell/continuity-consumer.js';
import { providerTerminalEvent } from '#src/providers/stream.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  StubbedContainmentProviderHostManager,
  createEntry,
  createFakeProviderServerHandle,
  createLaunch,
  createSharedSpec,
  createSpawnProviderServerMock,
  randomSequence,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const MATCHED_JOB_ID = '00000000-0000-4000-8000-000000000091';

function acquiredDetail(jobId: string, hostRef: HostRef): JobProjectionDetail {
  const status: JobStatus = {
    jobId,
    owner: { kind: 'provider-session', id: 'idle-session' },
    sessionId: 'idle-session',
    provider: hostRef.provider,
    projectRoot: '/workspace',
    workDir: fixtureCanonicalWorkDir('/workspace'),
    backendNamespace: 'idle-carrier-test',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
  const jobRuntime: JobRuntime = {
    transport: 'app-server',
    startTime: '2026-08-11T00:00:00.000Z',
    providerMeta: { provider: hostRef.provider, leaseState: 'acquired', hostRef },
  };
  return { status, launch: null, runtime: jobRuntime, exit: null };
}

function createDefaultsPlan(): BackendDefaultsPlan {
  return {
    eager: {
      resolvedPluginRoot: process.cwd(),
      createIdleTimer: () => ({}) as never,
    },
    finalizeWithWorld: () => {
      throw new Error('world-bound defaults were not expected');
    },
  } as unknown as BackendDefaultsPlan;
}

function composeProductionPredicate(rows: ReadonlyMap<string, JobProjectionDetail> | null): {
  predicate: (hostRef: HostRef) => boolean;
  db: Database | null;
} {
  const world = createCoordinatorWorld(
    {
      runtime,
      storeFormat: currentCoralStoreFormat(),
      pluginRoot: process.cwd(),
      backendNamespace: 'idle-carrier-test',
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'idle-carrier-instance',
        token: 'idle-carrier-token',
        pid: process.pid,
        now: () => 10_000,
        log: () => undefined,
      },
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      getConsumerStuck: () => [],
    },
    runtime,
    createDefaultsPlan(),
  );

  let db: Database | null = null;
  if (rows !== null) {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const progressStore = {
      getDb: () => db as Database,
      listStoredNonterminalJobIds: () => [...rows.keys()],
      loadJobProjectionDetail: (jobId: string) =>
        rows.get(jobId) ?? { status: null, launch: null, runtime: null, exit: null },
    } as Pick<JobStore, 'getDb' | 'listStoredNonterminalJobIds' | 'loadJobProjectionDetail'>;
    setStoreServicesForTest(world.storeServicesRef, {
      storeDb: db,
      progressStore: progressStore as JobStore,
      consumerDriver: null,
    } satisfies CoordinatorStoreServices);
  }

  const predicate = productionWiring.carrierBlocksRetirement;
  if (predicate === null) throw new Error('createCoordinatorWorld did not wire carrierBlocksRetirement');
  return { predicate, db };
}

beforeEach(() => {
  productionWiring.carrierBlocksRetirement = null;
  productionWiring.reevaluateIdleRetirement.mockReset();
});

describe('provider host idle properties', () => {
  it('connects the production-created manager to committed terminal publication', () => {
    const world = createCoordinatorWorld(
      {
        runtime,
        storeFormat: currentCoralStoreFormat(),
        pluginRoot: process.cwd(),
        backendNamespace: 'idle-production-connection',
        bootSnapshot: {
          version: 'test-version',
          bundleHash: 'test-bundle',
          flavor: 'prod',
          instanceId: 'idle-production-connection-instance',
          token: 'idle-production-connection-token',
          pid: process.pid,
          now: () => 10_000,
          log: () => undefined,
        },
        kbDaemonSupervisor: createMockKbDaemonSupervisor(),
        getConsumerStuck: () => [],
      },
      runtime,
      createDefaultsPlan(),
    );
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const progressStore = new ProductionJobStore('idle-production-connection', runtime, createEventBodyCodec(), {
      db,
      eventBus: world.eventBus,
      providers: permissiveProviderLookupPort,
    });
    setStoreServicesForTest(world.storeServicesRef, { storeDb: db, progressStore, consumerDriver: null });
    const jobId = '00000000-0000-4000-8000-000000000602';
    const sessionId = 'idle-production-connection-session';
    const exactRef: HostRef = {
      provider: 'codex',
      fingerprint: 'a'.repeat(64),
      instanceId: 'idle-production-connection-host',
      leaseMode: 'shared',
    };

    try {
      initTestJob(progressStore, {
        jobId,
        sessionId,
        provider: 'codex',
        projectRoot: '/workspace',
        backendNamespace: 'idle-production-connection',
        initialPhase: 'running',
      });
      progressStore.appendRuntimeStarted(jobId, {
        transport: 'app-server',
        startTime: '2026-08-13T00:00:00.000Z',
        providerMeta: { provider: 'codex', leaseState: 'acquired', hostRef: exactRef },
      });

      commitJobTerminal(progressStore, jobId, sessionId, {
        content: 'done',
        durationMs: 0,
        outcome: { kind: 'completed' },
      });

      expect(productionWiring.reevaluateIdleRetirement).toHaveBeenCalledExactlyOnceWith(exactRef);
    } finally {
      runtime.storage.rmSync(progressStore.jobDir(jobId), { recursive: true, force: true });
      db.close();
    }
  });

  it('connects operation settlement to targeted retirement re-evaluation', () => {
    const eventBus = new TypedEventBus();
    const storeServicesRef = createStoreServicesRef();
    const storeDb = newRawDatabase(':memory:');
    const operationRegistry = new LocalOperationRegistry();
    const retirement = { reevaluateIdleRetirement: vi.fn() };
    const record = providerOperationRecord('executing');
    if (record.phase !== 'executing') throw new Error('expected executing operation fixture');
    const exactRef = record.activationAck.hostRef;
    const progressStore = {
      loadJobProjectionDetail: () => acquiredDetail(record.operation.jobId, exactRef),
    };
    setStoreServicesForTest(storeServicesRef, {
      storeDb,
      progressStore: progressStore as unknown as JobStore,
      consumerDriver: null,
    });
    try {
      connectProviderHostRetirementReevaluation({
        eventBus,
        storeServicesRef,
        operationRegistry,
        retirement,
        time: runtime.time,
      });
      operationRegistry.activate(
        record,
        { stop: async () => undefined },
        { jobId: record.operation.jobId, pool: 'default' },
      );

      operationRegistry.settled(record.operation);

      expect(retirement.reevaluateIdleRetirement).toHaveBeenCalledExactlyOnceWith(exactRef);
    } finally {
      storeDb.close();
    }
  });

  it('bounds retries when every retirement wake fails', async () => {
    vi.useFakeTimers();
    const eventBus = new TypedEventBus();
    const storeServicesRef = createStoreServicesRef();
    const storeDb = newRawDatabase(':memory:');
    const operationRegistry = new LocalOperationRegistry();
    const record = providerOperationRecord('executing');
    if (record.phase !== 'executing') throw new Error('expected executing operation fixture');
    const exactRef = record.activationAck.hostRef;
    const progressStore = {
      loadJobProjectionDetail: () => acquiredDetail(record.operation.jobId, exactRef),
    };
    setStoreServicesForTest(storeServicesRef, {
      storeDb,
      progressStore: progressStore as unknown as JobStore,
      consumerDriver: null,
    });
    const retirementWake = vi.fn(() => {
      throw new Error('fixture persistent retirement wake failure');
    });
    vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    connectProviderHostRetirementReevaluation({
      eventBus,
      storeServicesRef,
      operationRegistry,
      retirement: { reevaluateIdleRetirement: retirementWake },
      time: runtime.time,
    });
    operationRegistry.activate(
      record,
      { stop: async () => undefined },
      { jobId: record.operation.jobId, pool: 'default' },
    );

    expect(() => operationRegistry.settled(record.operation)).not.toThrow();
    await vi.runAllTimersAsync();

    expect(retirementWake).toHaveBeenCalledTimes(3);
    expect(retirementWake).toHaveBeenCalledWith(exactRef);
    storeDb.close();
  });

  it('re-evaluates the real carrier guard after stream close, pin release, and terminal commit', async () => {
    vi.useFakeTimers();
    const eventBus = new TypedEventBus();
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const progressStore = new ProductionJobStore('idle-recheck-test', runtime, createEventBodyCodec(), {
      db,
      eventBus,
      providers: permissiveProviderLookupPort,
    });
    const storeServicesRef = createStoreServicesRef();
    setStoreServicesForTest(storeServicesRef, { storeDb: db, progressStore, consumerDriver: null });
    const operationRegistry = new LocalOperationRegistry();
    const carrierBlocksRetirement = createCarrierBlocksRetirement(storeServicesRef, {
      getDb: () => db,
      loadJobProjectionDetail: (jobId) => progressStore.loadJobProjectionDetail(jobId),
      platform: runtime.env.platform() as NodeJS.Platform,
      hasStartupRecoveryPassed: () => true,
      isAdmittedByThisCoordinator: () => false,
      registryStateForJob: (jobId) => operationRegistry.stateForJob(jobId),
    });
    const server = createFakeProviderServerHandle({ generation: 601 });
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      idleTimeoutMs: 10,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      carrierBlocksRetirement,
    });
    const retirementWake = vi.fn((hostRef: HostRef) => {
      if (retirementWake.mock.calls.length === 1) throw new Error('fixture transient retirement wake failure');
      manager.reevaluateIdleRetirement(hostRef);
    });
    vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    connectProviderHostRetirementReevaluation({
      eventBus,
      storeServicesRef,
      operationRegistry,
      retirement: { reevaluateIdleRetirement: retirementWake },
      time: runtime.time,
    });
    const jobId = '00000000-0000-4000-8000-000000000601';
    const sessionId = 'idle-recheck-session';
    const order: string[] = [];

    try {
      initTestJob(progressStore, {
        jobId,
        sessionId,
        provider: 'codex',
        projectRoot: '/workspace',
        backendNamespace: 'idle-recheck-test',
        initialPhase: 'running',
      });
      const managed = await manager.openSession(
        createLaunch(
          createSharedSpec({
            provider: 'codex',
            command: 'codex',
            args: ['app-server'],
            idleRetirement: 'unleased',
          }),
        ),
        { jobId },
      );
      progressStore.appendRuntimeStarted(jobId, {
        transport: 'app-server',
        startTime: '2026-08-13T00:00:00.000Z',
        providerMeta: { provider: 'codex', leaseState: 'acquired', hostRef: managed.hostRef },
      });

      const stream = (async function* () {
        try {
          yield providerTerminalEvent({ content: 'done', durationMs: 0, outcome: { kind: 'completed' } });
        } finally {
          order.push('stream-close');
          managed.close();
          order.push('pin-release');
        }
      })();
      const consumed = await consumeJobStream({
        jobId,
        sessionId,
        initialVersion: 1,
        stream,
        decodeContinuity: () => ({ ok: true, value: undefined }),
        sessionApi: {
          checkpointJobContinuityAtomic: vi.fn(),
          recordArtifactHandleAtomic: vi.fn(),
        },
        appendProgress: () => undefined,
      });

      expect(consumed.kind).toBe('terminal');
      expect(order).toEqual(['stream-close', 'pin-release']);
      expect(progressStore.listStoredNonterminalJobIds()).toContain(jobId);
      await vi.advanceTimersByTimeAsync(10);
      expect(server.closeMock).not.toHaveBeenCalled();

      order.push('terminal-commit');
      expect(() =>
        commitJobTerminal(progressStore, jobId, sessionId, {
          content: 'done',
          durationMs: 0,
          outcome: { kind: 'completed' },
        }),
      ).not.toThrow();
      expect(progressStore.listStoredNonterminalJobIds()).not.toContain(jobId);
      expect(server.closeMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(retirementWake).toHaveBeenCalledTimes(2);
      expect(retirementWake).toHaveBeenNthCalledWith(1, managed.hostRef);
      expect(retirementWake).toHaveBeenNthCalledWith(2, managed.hostRef);
      await vi.advanceTimersByTimeAsync(10);

      expect(order).toEqual(['stream-close', 'pin-release', 'terminal-commit']);
      expect(server.closeMock).toHaveBeenCalledOnce();
    } finally {
      await manager.shutdown();
      runtime.storage.rmSync(progressStore.jobDir(jobId), { recursive: true, force: true });
      db.close();
    }
  });

  it.each(['unleased', 'unleased-and-host-idle', 'never'] as const)(
    'does not retire a pinned host under the %s idle policy',
    async (idleRetirement) => {
      vi.useFakeTimers();
      const server = createFakeProviderServerHandle();
      const entry = createEntry({
        spec: createSharedSpec({ idleRetirement }),
        handle: server.handle,
        hostStats: { liveControllers: 0, activeTurns: 0 },
      });
      const closeProviderServerEntry = vi.fn(async () => undefined);
      const releasePin = acquireProviderHostPin(entry, { kind: 'acquisition' }, () => {});

      try {
        maybeArmIdleTimer(entry, {
          runtime,
          idleTimeoutMs: 5,
          entries: new Map([[entry.hostKey, entry]]),
          carrierBlocksRetirement: () => false,
          closeProviderServerEntry,
        });
        await vi.advanceTimersByTimeAsync(10);

        expect(closeProviderServerEntry).not.toHaveBeenCalled();
      } finally {
        releasePin();
      }
    },
  );

  it('never evicts a currently-acquired lease across 100 random idle sequences', async () => {
    vi.useFakeTimers();

    for (let seed = 1; seed <= 100; seed += 1) {
      const server = createFakeProviderServerHandle();
      const entry = createEntry({
        handle: server.handle,
        hostStats: { liveControllers: 0, activeTurns: 0 },
      });
      const entries = new Map([[entry.hostKey, entry]]);
      const releasePins: Array<() => void> = [];
      let evictedWhileHeld = false;

      const arm = () =>
        maybeArmIdleTimer(entry, {
          runtime,
          idleTimeoutMs: 5,
          entries,
          carrierBlocksRetirement: () => false,
          closeProviderServerEntry: async () => {
            if (activePinCount(entry) > 0) {
              evictedWhileHeld = true;
            }
          },
        });

      for (const step of randomSequence(seed)) {
        switch (step % 4) {
          case 0:
            releasePins.push(acquireProviderHostPin(entry, { kind: 'acquisition' }, () => {}));
            break;
          case 1:
            if (activePinCount(entry) === 0) {
              releasePins.push(acquireProviderHostPin(entry, { kind: 'acquisition' }, () => {}));
            } else {
              releasePins.pop()?.();
            }
            arm();
            break;
          case 2:
            arm();
            await vi.advanceTimersByTimeAsync(5);
            break;
          default:
            entry.hostStats = {
              liveControllers: step % 3 === 0 ? 1 : 0,
              activeTurns: step % 5 === 0 ? 1 : 0,
            };
            arm();
            break;
        }

        if (activePinCount(entry) > 0) {
          await vi.advanceTimersByTimeAsync(5);
          expect(evictedWhileHeld).toBe(false);
        }
      }
    }
  });

  it('rechecks the carrier predicate when an armed timer expires', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle();
    const entry = createEntry({ handle: server.handle, instanceId: 'timer-host' });
    const entries = new Map([[entry.hostKey, entry]]);
    const carrierBlocksRetirement = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const closeProviderServerEntry = vi.fn(async () => undefined);

    maybeArmIdleTimer(entry, {
      runtime,
      idleTimeoutMs: 5,
      entries,
      carrierBlocksRetirement,
      closeProviderServerEntry,
    });
    await vi.advanceTimersByTimeAsync(5);

    expect(carrierBlocksRetirement).toHaveBeenCalledTimes(2);
    expect(closeProviderServerEntry).not.toHaveBeenCalled();
  });

  it.each([
    {
      field: 'provider',
      stored: { provider: 'claude', fingerprint: 'a'.repeat(64), instanceId: 'host-1', leaseMode: 'shared' },
      candidate: { provider: 'codex', fingerprint: 'a'.repeat(64), instanceId: 'host-1', leaseMode: 'shared' },
      jobId: MATCHED_JOB_ID,
    },
    {
      field: 'fingerprint',
      stored: { provider: 'claude', fingerprint: 'a'.repeat(64), instanceId: 'host-1', leaseMode: 'shared' },
      candidate: { provider: 'claude', fingerprint: 'b'.repeat(64), instanceId: 'host-1', leaseMode: 'shared' },
      jobId: MATCHED_JOB_ID,
    },
    {
      field: 'instanceId',
      stored: { provider: 'claude', fingerprint: 'a'.repeat(64), instanceId: 'host-1', leaseMode: 'shared' },
      candidate: { provider: 'claude', fingerprint: 'a'.repeat(64), instanceId: 'host-2', leaseMode: 'shared' },
      jobId: MATCHED_JOB_ID,
    },
    {
      field: 'leaseMode',
      stored: { provider: 'claude', fingerprint: 'a'.repeat(64), instanceId: 'host-1', leaseMode: 'shared' },
      candidate: {
        provider: 'claude',
        fingerprint: 'a'.repeat(64),
        instanceId: 'host-1',
        leaseMode: 'job-exclusive',
        ownerJobId: 'candidate-job',
      },
      jobId: MATCHED_JOB_ID,
    },
    {
      field: 'ownerJobId',
      stored: {
        provider: 'claude',
        fingerprint: 'a'.repeat(64),
        instanceId: 'host-1',
        leaseMode: 'job-exclusive',
        ownerJobId: MATCHED_JOB_ID,
      },
      candidate: {
        provider: 'claude',
        fingerprint: 'a'.repeat(64),
        instanceId: 'host-1',
        leaseMode: 'job-exclusive',
        ownerJobId: 'candidate-job',
      },
      jobId: MATCHED_JOB_ID,
    },
  ] satisfies ReadonlyArray<{ field: string; stored: HostRef; candidate: HostRef; jobId: string }>)(
    'does not associate a stored job with a host that differs only by $field',
    ({ stored, candidate, jobId }) => {
      const { predicate, db } = composeProductionPredicate(new Map([[jobId, acquiredDetail(jobId, stored)]]));
      try {
        expect(predicate(candidate)).toBe(false);
      } finally {
        db?.close();
      }
    },
  );

  it('production wiring blocks a matching shared host through both manager-to-idle paths', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle();
    const rows = new Map<string, JobProjectionDetail>();
    const { predicate, db } = composeProductionPredicate(rows);
    const carrierBlocksRetirement = vi.fn(predicate);
    const manager = new StubbedContainmentProviderHostManager({
      runtime,
      idleTimeoutMs: 5,
      spawnProviderServer: createSpawnProviderServerMock(server.handle),
      carrierBlocksRetirement,
    });

    try {
      const first = await manager.openSession(createLaunch(createSharedSpec()));
      rows.set(MATCHED_JOB_ID, acquiredDetail(MATCHED_JOB_ID, first.hostRef));
      first.close();

      server.emitNotification({ method: 'host/stats', params: { liveControllers: 0, activeTurns: 0 } });
      const second = await manager.openSession(createLaunch(createSharedSpec()));
      second.close();
      await vi.advanceTimersByTimeAsync(5);

      expect(carrierBlocksRetirement).toHaveBeenCalledTimes(2);
      expect(carrierBlocksRetirement).toHaveBeenNthCalledWith(1, first.hostRef);
      expect(carrierBlocksRetirement).toHaveBeenNthCalledWith(2, first.hostRef);
      expect(server.closeMock).not.toHaveBeenCalled();
    } finally {
      await manager.shutdown();
      db?.close();
    }
  });

  it('treats an unavailable store as retirement-blocking', () => {
    const { predicate } = composeProductionPredicate(null);
    const entry = createEntry({ instanceId: 'unavailable-store-host' });
    expect(predicate(hostRefFromEntry(entry))).toBe(true);
  });

  it('treats a stored-row/detail mapping ambiguity as retirement-blocking', () => {
    const ambiguous = new Map<string, JobProjectionDetail>([
      [MATCHED_JOB_ID, { status: null, launch: null, runtime: null, exit: null }],
    ]);
    const { predicate, db } = composeProductionPredicate(ambiguous);
    const entry = createEntry({ instanceId: 'ambiguous-mapping-host' });
    try {
      expect(predicate(hostRefFromEntry(entry))).toBe(true);
    } finally {
      db?.close();
    }
  });
});
