import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type * as HttpHandlerMod from '#src/transport/http/handler.js';
import type * as CompositionWorldMod from '#src/coordinator/composition/world.js';
import type * as CarrierObserverMod from '#src/coordinator/live/carrier-observer.js';

const captured = vi.hoisted(() => ({
  healthRead: null as HttpHandlerPorts['health']['read'] | null,
  publishRecovery: null as (() => void) | null,
}));
const observeCarrierStatuses = vi.hoisted(() => vi.fn(async () => new Map()));

vi.mock('#src/transport/http/handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpHandlerMod>();
  return {
    ...actual,
    createHttpHandler: (deps: HttpHandlerPorts) => {
      captured.healthRead = deps.health.read;
      return actual.createHttpHandler(deps);
    },
  };
});

vi.mock('#src/coordinator/composition/world.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CompositionWorldMod>();
  return {
    ...actual,
    createStartupRecoveryBarrier: () => {
      const barrier = actual.createStartupRecoveryBarrier();
      captured.publishRecovery = barrier.publication.publish;
      return barrier;
    },
  };
});

vi.mock('#src/coordinator/live/carrier-observer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CarrierObserverMod>();
  return { ...actual, observeCarrierStatuses };
});

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type { FetchFn } from '#src/coordinator/composition/types.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import type { ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { JobProjectionDetail } from '#src/jobs/read-queries.js';
import type { JobRuntime, JobStatus } from '#src/jobs/records.js';
import type { JobStore } from '#src/jobs/store.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { readStoredNonterminalProjectionJobIds } from '#src/jobs/projection-row.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

type ExecutingRecord = Extract<ProviderOperationRecord, { phase: 'executing' }>;

const LIVE_JOB_ID = '00000000-0000-4000-8000-000000000097';
const ACCOUNTED_UNKNOWN_JOB_ID = '00000000-0000-4000-8000-000000000098';
const DEFECT_UNKNOWN_JOB_ID = '00000000-0000-4000-8000-000000000099';

const openDbs = new Set<Database>();

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  openDbs.add(db);
  return db;
}

function acquiredDetail(jobId: string): JobProjectionDetail {
  const status: JobStatus = {
    jobId,
    owner: { kind: 'provider-session', id: `session-${jobId}` },
    sessionId: `session-${jobId}`,
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'health-carrier-test',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
  const runtime: JobRuntime = {
    transport: 'app-server',
    startTime: '2026-08-11T00:00:00.000Z',
    providerMeta: {
      provider: 'codex',
      leaseState: 'acquired',
      hostRef: {
        provider: 'codex',
        fingerprint: 'a'.repeat(64),
        instanceId: 'health-host',
        leaseMode: 'shared',
      },
    },
  };
  return { status, launch: null, runtime, exit: null };
}

function providerHostManager(): ProviderHostManager {
  return {
    openSession: async () => {
      throw new Error('provider host was not expected');
    },
    attachSession: async () => null,
    drainForHandoff: async () => undefined,
    shutdown: async () => undefined,
    routeAppServerOperation: () => null,
  };
}

function createCore(operationRegistry: LocalOperationRegistry, networkObserver: FetchFn) {
  const runtime = createRealRuntime('prod');
  const core = createCoordinatorCore(
    {
      runtime,
      storeFormat: currentCoralStoreFormat(),
      pluginRoot: process.cwd(),
      backendNamespace: 'health-carrier-test',
      bootSnapshot: {
        version: 'test-version',
        bundleHash: 'test-bundle',
        flavor: 'prod',
        instanceId: 'health-carrier-instance',
        token: 'health-carrier-token',
        bootToken: 'health-carrier-boot-token',
        pid: process.pid,
        now: () => 10_000,
        log: () => undefined,
      },
      createServerFn: (handler) => createServer(handler),
      fetchFn: networkObserver,
      providerHostManager: providerHostManager(),
      operationRegistry,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      getConsumerStuck: () => [],
    },
    async () => [],
  );
  return core;
}

function installProgressStore(
  core: ReturnType<typeof createCoordinatorCore>,
  db: Database,
  progressStore: Pick<
    JobStore,
    'getDb' | 'listStoredNonterminalJobIds' | 'loadJobProjectionDetail' | 'liveJobCount' | 'listJobIds'
  >,
): void {
  setStoreServicesForTest(
    core.storeServicesRef,
    { storeDb: db, progressStore: progressStore as JobStore, consumerDriver: null } satisfies CoordinatorStoreServices,
    { storeDbPath: ':memory:' },
  );
}

function readHealth() {
  if (captured.healthRead === null) throw new Error('health port was not composed');
  return captured.healthRead();
}

beforeEach(() => {
  captured.healthRead = null;
  captured.publishRecovery = null;
  observeCarrierStatuses.mockClear();
});

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.clear();
});

describe('health local carrier observation', () => {
  it('reports exact live, unknown, and recovery-defect counts without probing the network', () => {
    const db = createDb();
    insertProviderOperation(db, providerOperationRecord('executing', { job: 98 }));

    const operationRegistry = new LocalOperationRegistry();
    const liveRecord = providerOperationRecord('executing', { job: 97 }) as ExecutingRecord;
    operationRegistry.activate(liveRecord, { stop: async () => undefined }, { jobId: LIVE_JOB_ID, pool: 'default' });

    const networkObserver = vi.fn(async () => {
      throw new Error('health issued a network carrier probe');
    });
    const core = createCore(operationRegistry, networkObserver);
    const details = new Map([
      [LIVE_JOB_ID, acquiredDetail(LIVE_JOB_ID)],
      [ACCOUNTED_UNKNOWN_JOB_ID, acquiredDetail(ACCOUNTED_UNKNOWN_JOB_ID)],
      [DEFECT_UNKNOWN_JOB_ID, acquiredDetail(DEFECT_UNKNOWN_JOB_ID)],
    ]);
    const listJobIds = vi.fn(() => {
      throw new Error('health scanned historical job IDs');
    });
    const liveJobCount = vi.fn(() => 99);
    installProgressStore(core, db, {
      getDb: () => db,
      listStoredNonterminalJobIds: () => [...details.keys()],
      loadJobProjectionDetail: (jobId) =>
        details.get(jobId) ?? { status: null, launch: null, runtime: null, exit: null },
      liveJobCount,
      listJobIds,
    });
    captured.publishRecovery?.();

    const health = readHealth();

    expect(health.activeJobs).toBe(3);
    expect(health.status).toBe('starting');
    expect(health.diagnostics?.carriers).toEqual({
      coverage: 'complete',
      liveJobs: 1,
      unknownJobs: 2,
      recoveryDefectJobs: 1,
    });
    expect(listJobIds).not.toHaveBeenCalled();
    expect(liveJobCount).not.toHaveBeenCalled();
    expect(observeCarrierStatuses).not.toHaveBeenCalled();
    expect(networkObserver).not.toHaveBeenCalled();
  });

  it('reads only stored-nonterminal projection IDs through the phase/namespace index', () => {
    const db = createDb();
    const insert = db.prepare(`
      INSERT INTO projection_jobs (
        job_id, execution_owner, phase, terminal, diagnostics, session_id, provider, project_root,
        backend_namespace, bundle_hash, job_kind, parent_workflow_job_id, workflow_slot,
        workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
      ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, NULL, 'workflow', NULL, NULL, NULL, NULL, ?, ?)
    `);
    insert.run(
      'live-job',
      JSON.stringify({ kind: 'workflow', id: 'live-job' }),
      'running',
      '{}',
      '/workspace',
      'ns',
      '2026-08-11T00:00:00.000Z',
      1,
    );
    insert.run(
      'historical-job',
      JSON.stringify({ kind: 'workflow', id: 'historical-job' }),
      'completed',
      '{}',
      '/workspace',
      'ns',
      '2026-08-11T00:00:00.000Z',
      2,
    );

    expect(readStoredNonterminalProjectionJobIds(db)).toEqual(['live-job']);
  });

  it('discards partial classification and retains liveJobCount as the deterministic fallback', () => {
    const db = createDb();
    const networkObserver = vi.fn(async () => {
      throw new Error('health issued a network carrier probe');
    });
    const core = createCore(new LocalOperationRegistry(), networkObserver);
    const liveJobCount = vi.fn(() => 4);
    installProgressStore(core, db, {
      getDb: () => db,
      listStoredNonterminalJobIds: () => [LIVE_JOB_ID, DEFECT_UNKNOWN_JOB_ID],
      loadJobProjectionDetail: (jobId) => {
        if (jobId === LIVE_JOB_ID) return acquiredDetail(jobId);
        throw new Error('deterministic projection read failure');
      },
      liveJobCount,
      listJobIds: vi.fn(() => []),
    });

    const health = readHealth();

    expect(health.activeJobs).toBe(4);
    expect(health.diagnostics?.carriers).toEqual({
      coverage: 'unknown',
      liveJobs: 0,
      unknownJobs: 4,
      recoveryDefectJobs: 0,
    });
    expect(liveJobCount).toHaveBeenCalledOnce();
    expect(observeCarrierStatuses).not.toHaveBeenCalled();
    expect(networkObserver).not.toHaveBeenCalled();
  });
});
