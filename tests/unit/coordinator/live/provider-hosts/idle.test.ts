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
import {
  connectProviderHostRetirementReevaluation,
  createCarrierBlocksRetirement,
} from '#src/coordinator/composition/world.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { backendLog } from '#src/infra/backend-log.js';
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
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import {
  StubbedContainmentProviderHostManager,
  createFakeProviderServerHandle,
  createLaunch,
  createSharedSpec,
  createSpawnProviderServerMock,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

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
      isWorkflowOwnedByThisCoordinator: () => false,
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
});
