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

import { acquireProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
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

  it('does not retire a host that accepted an unsettled child shutdown obligation', async () => {
    vi.useFakeTimers();
    const server = createFakeProviderServerHandle();
    const entry = createEntry({
      handle: server.handle,
      hostStats: { liveControllers: 0, activeTurns: 0, heldControllers: 1 },
    });
    const closeProviderServerEntry = vi.fn(async () => undefined);

    maybeArmIdleTimer(entry, {
      runtime,
      idleTimeoutMs: 5,
      entries: new Map([[entry.hostKey, entry]]),
      carrierBlocksRetirement: () => false,
      closeProviderServerEntry,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(closeProviderServerEntry).not.toHaveBeenCalled();
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
