import { createServer } from 'node:http';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type * as HttpHandlerMod from '#src/transport/http/handler.js';
import type * as CompositionWorldMod from '#src/coordinator/composition/world.js';
import type * as ExecutionServicesMod from '#src/coordinator/composition/execution-services.js';
import type * as CarrierObserverMod from '#src/coordinator/live/carrier-observer.js';
import type * as NodeProcessMod from '#src/infra/node-process.js';
import type { ProviderOperationStartupOwnershipReleaseDisposition } from '#src/recovery/unreadable-provider-operation.js';
import { parseBackendHealth } from '#src/transport/http/backend/health.js';
import { formatBackendStatus, formatUnreadableProviderOperationDiscard } from '#src/cli/format/backend.js';
import { registerBackendCommands } from '#src/cli/commands/backend.js';

type DiscardProviderOperation = NonNullable<HttpHandlerPorts['recoveryQuarantine']['discardProviderOperation']>;
type ReleaseStartupOwnership = (recordKey: string) => Promise<ProviderOperationStartupOwnershipReleaseDisposition>;

const captured = vi.hoisted(() => ({
  healthRead: null as HttpHandlerPorts['health']['read'] | null,
  publishRecovery: null as (() => void) | null,
  discardProviderOperation: null as DiscardProviderOperation | null,
}));
const observeCarrierStatuses = vi.hoisted(() => vi.fn(async () => new Map()));
const probeSelfIncarnation = vi.hoisted(() => vi.fn());
const releaseStartupOwnership = vi.hoisted(() => ({
  current: null as ReleaseStartupOwnership | null,
}));

vi.mock('#src/transport/http/handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpHandlerMod>();
  return {
    ...actual,
    createHttpHandler: (deps: HttpHandlerPorts) => {
      captured.healthRead = deps.health.read;
      captured.discardProviderOperation = deps.recoveryQuarantine.discardProviderOperation ?? null;
      return actual.createHttpHandler(deps);
    },
  };
});

vi.mock('#src/coordinator/composition/execution-services.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExecutionServicesMod>();
  return {
    ...actual,
    createExecutionServices: (...args: Parameters<typeof actual.createExecutionServices>) => {
      const services = actual.createExecutionServices(...args);
      return {
        ...services,
        releaseUnreadableProviderOperationStartupOwnership: (recordKey: string) =>
          releaseStartupOwnership.current?.(recordKey) ??
          services.releaseUnreadableProviderOperationStartupOwnership(recordKey),
      };
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

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeProcessMod>();
  return { ...actual, probeProcessIncarnation: probeSelfIncarnation };
});

import {
  createCoordinatorCore,
  LAUNCH_PERMIT_REPORT_AGE_MS,
  MAX_SETTLEMENT_REFUSAL_DIAGNOSTICS,
} from '#src/coordinator/composition/index.js';
import {
  LAUNCH_RECLAMATION_AGE_FLOOR_MS,
  SETTLED_UNBOUND_ABSENCE_CHECK_MS,
  SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT,
} from '#src/coordinator/live/admission.js';
import type { FetchFn } from '#src/coordinator/composition/types.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import type { CoordinatorStoreServices } from '#src/coordinator/composition/store-services-ref.js';
import type { ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { JobProjectionDetail } from '#src/jobs/read-queries.js';
import type { JobRuntime, JobStatus } from '#src/jobs/records.js';
import type { JobStore } from '#src/jobs/store.js';
import {
  attributeUnreadableProviderOperations,
  insertProviderOperation,
  readProviderOperations,
} from '#src/store/provider-operation-journal.js';
import {
  PROVIDER_OPERATION_RECORD_VERSION,
  type ProviderOperationRecord,
} from '#src/store/provider-operation-record.js';
import { readStoredNonterminalProjectionJobIds } from '#src/jobs/projection-row.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { encodeRecoveryQuarantineKey, RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { unreadableProviderOperationSubject } from '#src/recovery/unreadable-provider-operation.js';
import { executeRenderedCommand } from '#tests/helpers/rendered-command.js';
import {
  SETTLED_UNBOUND_STATUS_BOUNDARY,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
} from '#src/recovery/source-registry.js';
import { MAX_SETTLED_UNBOUND_STATUS_ENTRIES } from '#src/coordinator/services/recovery/settled-unbound-status.js';

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
    workDir: fixtureCanonicalWorkDir('/workspace'),
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

function queuedDetail(jobId: string): JobProjectionDetail {
  return {
    status: { ...acquiredDetail(jobId).status!, phase: 'queued' },
    launch: null,
    runtime: null,
    exit: null,
  };
}

function providerHostManager(): ProviderHostManager {
  return {
    openSession: async () => {
      throw new Error('provider host was not expected');
    },
    attachSession: async () => null,
    drainForHandoff: async () => ({
      kind: 'provider-hosts-quiesced',
      liveProxySets: [],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    }),
    shutdown: async () => ({
      kind: 'provider-hosts-quiesced',
      liveProxySets: [],
      acquisitionCleanupHolds: [],
      closingHosts: [],
    }),
    routeAppServerOperation: () => null,
  };
}

function createCore(
  operationRegistry: LocalOperationRegistry,
  networkObserver: FetchFn,
  runtime: Runtime = createRealRuntime('prod'),
) {
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
  > &
    Partial<Pick<JobStore, 'readStatus'>>,
): void {
  setStoreServicesForTest(core.storeServicesRef, {
    storeDb: db,
    progressStore: progressStore as JobStore,
    consumerDriver: null,
  } satisfies CoordinatorStoreServices);
}

function readHealth() {
  if (captured.healthRead === null) throw new Error('health port was not composed');
  return captured.healthRead();
}

beforeEach(() => {
  captured.healthRead = null;
  captured.publishRecovery = null;
  captured.discardProviderOperation = null;
  releaseStartupOwnership.current = null;
  observeCarrierStatuses.mockClear();
  probeSelfIncarnation.mockReset().mockReturnValue(testIncarnation('health-default'));
});

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.clear();
});

describe('health local carrier observation', () => {
  it('bounds settlement refusal diagnostics with deterministic oldest-first eviction', async () => {
    vi.useFakeTimers();
    try {
      const core = createCore(
        new LocalOperationRegistry(),
        vi.fn(async () => ({ ok: true }) as never),
      );
      const db = createDb();
      installProgressStore(core, db, {
        getDb: () => db,
        listStoredNonterminalJobIds: () => [],
        loadJobProjectionDetail: () => ({ status: null, launch: null, runtime: null, exit: null }),
        liveJobCount: () => 0,
        listJobIds: () => [],
      });
      const quarantine = new RecoveryQuarantineStore(db, { now: () => 100 });
      for (let index = 0; index < MAX_SETTLED_UNBOUND_STATUS_ENTRIES; index += 1) {
        expect(
          quarantine.upsert({
            boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
            subject: {
              key: `capacity-${index}`,
              revision: { kind: 'fingerprint', value: `capacity-revision-${index}` },
            },
            state: 'active',
            stage: 'settle',
            errorMessage: 'capacity fixture',
            detail: 'capacity fixture',
          }),
        ).toBe(true);
      }
      core.launchCoordinator.connectProviderOperationBindingJournal(() => ({
        kind: 'unknown',
        reason: 'journal unavailable',
      }));
      for (let index = 0; index <= MAX_SETTLEMENT_REFUSAL_DIAGNOSTICS; index += 1) {
        const jobId = `00000000-0000-4000-8000-${String(index + 1_000).padStart(12, '0')}`;
        const operationId = `00000000-0000-4000-8000-${String(index + 2_000).padStart(12, '0')}`;
        const proxyInstanceId = `00000000-0000-4000-8000-${String(index + 3_000).padStart(12, '0')}`;
        insertProviderOperation(
          db,
          providerOperationRecord('executing', {
            operation: {
              jobId,
              operationId,
              proxyInstanceId,
              buildSetId: `00000000-0000-4000-8000-${String(index + 4_000).padStart(12, '0')}`,
            },
          }),
        );
        expect(
          core.launchCoordinator.settleProviderOperationBinding({
            jobId,
            operationId,
          }),
        ).toEqual({ kind: 'settled-unbound' });
      }

      await vi.advanceTimersByTimeAsync(SETTLED_UNBOUND_ABSENCE_CHECK_MS * SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT);

      const failures = readHealth().diagnostics?.settlementRefusalRecordingFailures ?? [];
      expect(failures).toHaveLength(MAX_SETTLEMENT_REFUSAL_DIAGNOSTICS);
      expect(failures.some(({ jobId }) => jobId.endsWith('001000'))).toBe(false);
      expect(failures.at(-1)).toMatchObject({
        jobId: '00000000-0000-4000-8000-000000001100',
        operationId: '00000000-0000-4000-8000-000000002100',
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries a failed self-incarnation probe and caches the first success', () => {
    const incarnation = testIncarnation('health-retry-success');
    probeSelfIncarnation.mockReset().mockReturnValueOnce(null).mockReturnValue(incarnation);
    createCore(
      new LocalOperationRegistry(),
      vi.fn(async () => ({ ok: true }) as never),
    );

    const first = readHealth();
    const second = readHealth();
    const third = readHealth();

    expect([first.incarnation, second.incarnation, third.incarnation]).toEqual([undefined, incarnation, incarnation]);
    expect(probeSelfIncarnation).toHaveBeenCalledTimes(2);
    expect(probeSelfIncarnation).toHaveBeenNthCalledWith(1, process.pid, process.platform);
    expect(probeSelfIncarnation).toHaveBeenNthCalledWith(2, process.pid, process.platform);
  });

  it('reports exact live, unknown, and recovery-defect counts without probing the network', () => {
    const db = createDb();
    insertProviderOperation(db, providerOperationRecord('executing', { job: 98 }));

    const operationRegistry = new LocalOperationRegistry();
    const liveRecord = providerOperationRecord('executing', { job: 97 }) as ExecutingRecord;
    operationRegistry.activate(
      liveRecord,
      { stop: async () => undefined },
      { kind: 'job-local', jobId: LIVE_JOB_ID, pool: 'default' },
    );

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
        job_id, execution_owner, phase, terminal, diagnostics, session_id, provider, project_root, work_dir,
        backend_namespace, bundle_hash, job_kind, parent_workflow_job_id, workflow_slot,
        workflow_slot_generation, replaces_workflow_job_id, created_at, last_seq
      ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, 'workflow', NULL, NULL, NULL, NULL, ?, ?)
    `);
    insert.run(
      'live-job',
      JSON.stringify({ kind: 'workflow', id: 'live-job' }),
      'running',
      '{}',
      '/workspace',
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

  it('reports only aged permits or permits whose carrier is not live, preserving both ownership identities', () => {
    let now = 10_000;
    const baseRuntime = createRealRuntime('prod');
    const runtime = { ...baseRuntime, time: { ...baseRuntime.time, now: () => now } } satisfies Runtime;
    const core = createCore(
      new LocalOperationRegistry(),
      vi.fn(async () => ({ ok: true }) as never),
      runtime,
    );

    const old = core.launchCoordinator.requestLaunch(
      'old-live-job',
      'codex',
      { kind: 'provider-session', id: 'old-session' },
      'default',
    );
    if (old === 'queue_full' || old.type !== 'immediate') throw new Error('expected immediate old permit');

    now += LAUNCH_PERMIT_REPORT_AGE_MS + 1;
    const young = core.launchCoordinator.requestLaunch(
      'young-live-job',
      'claude',
      { kind: 'workflow', id: 'workflow-1' },
      'curate',
    );
    const unknown = core.launchCoordinator.requestLaunch(
      'unknown-carrier-job',
      'codex',
      { kind: 'discussion', id: 'discussion-1' },
      'discuss',
    );
    if (young === 'queue_full' || young.type !== 'immediate') throw new Error('expected immediate young permit');
    if (unknown === 'queue_full' || unknown.type !== 'immediate') {
      throw new Error('expected immediate unknown-carrier permit');
    }

    const db = createDb();
    const details = new Map([
      ['old-live-job', queuedDetail('old-live-job')],
      ['young-live-job', queuedDetail('young-live-job')],
      ['unknown-carrier-job', acquiredDetail('unknown-carrier-job')],
    ]);
    installProgressStore(core, db, {
      getDb: () => db,
      listStoredNonterminalJobIds: () => [...details.keys()],
      loadJobProjectionDetail: (jobId) =>
        details.get(jobId) ?? { status: null, launch: null, runtime: null, exit: null },
      liveJobCount: () => 0,
      listJobIds: () => [],
    });

    const produced = readHealth();
    expect(produced.diagnostics?.launchPermits).toEqual([
      {
        reservationId: old.permit.reservationId,
        jobId: 'old-live-job',
        pool: 'default',
        provider: 'codex',
        holder: { kind: 'local-execution' },
        executionOwner: { kind: 'provider-session', id: 'old-session' },
        heldForMs: LAUNCH_PERMIT_REPORT_AGE_MS + 1,
      },
      {
        reservationId: unknown.permit.reservationId,
        jobId: 'unknown-carrier-job',
        pool: 'discuss',
        provider: 'codex',
        holder: { kind: 'local-execution' },
        executionOwner: { kind: 'discussion', id: 'discussion-1' },
        heldForMs: 0,
      },
    ]);

    const roundTripReport = {
      ...produced,
      diagnostics: {
        ...produced.diagnostics,
        settlementRefusalRecordingFailures: [
          {
            jobId: 'failed-settlement-job',
            cause: 'terminal-persist-failed' as const,
            error: 'recovery quarantine unavailable',
            observedAtMs: 12_345,
          },
        ],
      },
    };
    const decoded = parseBackendHealth(roundTripReport);
    if (decoded === null) throw new Error('The produced health report did not pass the transport decoder.');
    const formatted = formatBackendStatus(
      {
        status: 'ok',
        health: {
          ...decoded.health,
          status: 'ok',
          skippedProviderProxySetRows: decoded.skippedProviderProxySetRows,
          skippedProviderProxySetTokens: decoded.skippedProviderProxySetTokens,
        },
      },
      { kind: 'absent' },
      null,
    );
    expect(formatted).toContain(
      `reservation=${old.permit.reservationId} job=old-live-job pool=default provider=codex heldForMs=${LAUNCH_PERMIT_REPORT_AGE_MS + 1}`,
    );
    expect(formatted).toContain('holder=local-execution');
    expect(formatted).toContain('executionOwner=provider-session:old-session');
    expect(formatted).toContain('job=failed-settlement-job cause=terminal-persist-failed observedAtMs=12345');
    expect(formatted).toContain('error=recovery quarantine unavailable');
  });

  it('omits launchPermits when every permit is young and carried live', () => {
    const db = createDb();
    const core = createCore(
      new LocalOperationRegistry(),
      vi.fn(async () => ({ ok: true }) as never),
    );
    const admission = core.launchCoordinator.requestLaunch(
      'young-live-job',
      'codex',
      { kind: 'provider-session', id: 'young-session' },
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected immediate permit');
    installProgressStore(core, db, {
      getDb: () => db,
      listStoredNonterminalJobIds: () => ['young-live-job'],
      loadJobProjectionDetail: () => queuedDetail('young-live-job'),
      liveJobCount: () => 0,
      listJobIds: () => [],
    });

    expect(readHealth().diagnostics).toBeDefined();
    expect(readHealth().diagnostics?.launchPermits).toBeUndefined();
  });

  it('projects non-release dispositions from coordinator-owned diagnostic state', () => {
    const core = createCore(
      new LocalOperationRegistry(),
      vi.fn(async () => ({ ok: true }) as never),
    );
    const admission = core.launchCoordinator.requestLaunch(
      'already-released-job',
      'codex',
      { kind: 'provider-session', id: 'already-released-session' },
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected immediate permit');
    core.launchCoordinator.releaseLaunch(admission.permit);
    core.launchCoordinator.releaseLaunch(admission.permit);

    const decoded = parseBackendHealth(readHealth());
    if (decoded === null) throw new Error('The produced health report did not pass the transport decoder.');
    expect(decoded.health.diagnostics?.launchReleaseDispositions).toEqual([
      expect.objectContaining({
        reservationId: admission.permit.reservationId,
        jobId: admission.permit.jobId,
        disposition: { kind: 'already-released', pool: 'default' },
      }),
    ]);
  });

  it('returns and reports a surviving provider-operation adoption refusal after discard', async () => {
    const runtime = createRealRuntime('prod');
    const db = createDb();
    const unreadable = providerOperationRecord('executing', { job: 93 });
    const unreadableKey =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      `${unreadable.operation.jobId}:${unreadable.operation.operationId}:` +
      `${unreadable.operation.proxyInstanceId}:${unreadable.operation.buildSetId}`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(unreadableKey, 'not-json');
    const attribution = attributeUnreadableProviderOperations(db, readProviderOperations(db).unreadableKeys).find(
      ({ key }) => key === unreadableKey,
    );
    if (attribution === undefined) throw new Error('expected unreadable provider-operation attribution');
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    expect(
      quarantine.upsert({
        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
        subject: unreadableProviderOperationSubject(unreadableKey, attribution.revision),
        state: 'active',
        stage: 'hydrate',
        errorMessage: 'Provider operation row is unreadable by this build.',
        detail: 'Operator discard is required.',
      }),
    ).toBe(true);

    const surviving = providerOperationRecord('executing', { job: 94 });
    const survivingRecordKey =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      `${surviving.operation.jobId}:${surviving.operation.operationId}:` +
      `${surviving.operation.proxyInstanceId}:${surviving.operation.buildSetId}`;
    const refusal = {
      recordKey: survivingRecordKey,
      ...surviving.operation,
      reason: 'the provider operation ownership path is not initialized',
      remedy: { kind: 'remote-settlement' },
    } as const;
    releaseStartupOwnership.current = async () => ({
      kind: 'adoption-refused',
      releasedLaunchPermits: 0,
      refusals: [refusal],
    });
    const core = createCore(
      new LocalOperationRegistry(),
      vi.fn(async () => ({ ok: true }) as never),
      runtime,
    );
    installProgressStore(core, db, {
      getDb: () => db,
      listStoredNonterminalJobIds: () => [],
      loadJobProjectionDetail: () => ({ status: null, launch: null, runtime: null, exit: null }),
      liveJobCount: () => 0,
      listJobIds: () => [],
    });
    const discardProviderOperation = captured.discardProviderOperation;
    if (discardProviderOperation === null) throw new Error('provider-operation discard port was not composed');

    const result = await discardProviderOperation({ key: unreadableKey, revision: attribution.revision });
    expect(result).toEqual({
      key: unreadableKey,
      revision: attribution.revision,
      kind: 'adoption-refused',
      rowDisposition: 'discarded',
      releasedLaunchPermits: 0,
      refusals: [refusal],
    });
    expect(readProviderOperations(db).unreadableKeys).not.toContain(unreadableKey);

    const produced = readHealth();
    expect(produced.diagnostics?.providerOperationAdoptionRefusals).toEqual([
      expect.objectContaining({
        triggerRecordKey: unreadableKey,
        rowDisposition: 'discarded',
        releasedLaunchPermits: 0,
        ...refusal,
      }),
    ]);
    const decoded = parseBackendHealth(produced);
    if (decoded === null) throw new Error('The produced health report did not pass the transport decoder.');
    const formatted = formatBackendStatus(
      {
        status: 'ok',
        health: {
          ...decoded.health,
          status: 'ok',
          skippedProviderProxySetRows: decoded.skippedProviderProxySetRows,
          skippedProviderProxySetTokens: decoded.skippedProviderProxySetTokens,
        },
      },
      { kind: 'absent' },
      null,
    );
    expect(formatted).toContain(`record=${survivingRecordKey} job=${surviving.operation.jobId}`);
    expect(formatted).toContain(`reason=${refusal.reason}`);
    expect(formatted).toContain('Coral retries the remote settlement path automatically');
    expect(formatted).not.toContain('external repair');
  });

  it('preserves the provider-operation row and launch capacity while startup recovery owns the fence', async () => {
    const runtime = createRealRuntime('prod');
    const db = createDb();
    const unreadable = providerOperationRecord('executing', { job: 92 });
    const unreadableKey =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      `${unreadable.operation.jobId}:${unreadable.operation.operationId}:` +
      `${unreadable.operation.proxyInstanceId}:${unreadable.operation.buildSetId}`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(unreadableKey, 'not-json');
    const attribution = attributeUnreadableProviderOperations(db, readProviderOperations(db).unreadableKeys).find(
      ({ key }) => key === unreadableKey,
    );
    if (attribution === undefined) throw new Error('expected unreadable provider-operation attribution');
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    expect(
      quarantine.upsert({
        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
        subject: unreadableProviderOperationSubject(unreadableKey, attribution.revision),
        state: 'active',
        stage: 'hydrate',
        errorMessage: 'Provider operation row is unreadable by this build.',
        detail: 'Operator discard is required.',
      }),
    ).toBe(true);

    const core = createCore(
      new LocalOperationRegistry(),
      vi.fn(async () => ({ ok: true }) as never),
      runtime,
    );
    installProgressStore(core, db, {
      getDb: () => db,
      listStoredNonterminalJobIds: () => [unreadable.operation.jobId],
      loadJobProjectionDetail: () => acquiredDetail(unreadable.operation.jobId),
      liveJobCount: () => 1,
      listJobIds: () => [unreadable.operation.jobId],
      readStatus: () => acquiredDetail(unreadable.operation.jobId).status,
    });
    core.launchCoordinator.restoreActiveLaunch(
      unreadable.operation.jobId,
      'codex',
      { kind: 'provider-session', id: 'fenced-discard-session' },
      'default',
      { kind: 'undecided-provider-operation', recordKeys: [unreadableKey] },
    );
    core.runtimeState.setLaunchFenceActive(true);
    const discardProviderOperation = captured.discardProviderOperation;
    if (discardProviderOperation === null) throw new Error('provider-operation discard port was not composed');

    const result = await discardProviderOperation({ key: unreadableKey, revision: attribution.revision });

    expect(result).toEqual({
      key: unreadableKey,
      revision: attribution.revision,
      kind: 'recovery-in-progress',
      code: 'backend_recovering',
      message: 'Provider-operation discard is unavailable while startup recovery owns the launch fence.',
      remedy: {
        kind: 'recovery-quarantine-discard',
        command: {
          kind: 'discard-provider-operation',
          key: unreadableKey,
          revision: `fingerprint:${attribution.revision}`,
          allowReadable: false,
        },
      },
    });
    if (result.kind !== 'recovery-in-progress') throw new Error('expected startup-recovery refusal');
    const output = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const program = new Command();
      program.exitOverride();
      registerBackendCommands(program, {
        recoveryQuarantine: {
          list: () => quarantine.list(),
          clear: async () => {
            throw new Error('clear was not requested');
          },
          discardProviderOperation: async (request) => discardProviderOperation(request),
        },
      });
      await executeRenderedCommand(program, formatUnreadableProviderOperationDiscard(result), {
        label: 'command',
        includes: encodeRecoveryQuarantineKey(unreadableKey),
      });
      expect(process.exitCode).toBe(75);
    } finally {
      output.mockRestore();
      process.exitCode = undefined;
    }
    expect(readProviderOperations(db).unreadableKeys).toContain(unreadableKey);
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, unreadableKey)).toMatchObject({
      state: 'active',
      subject: { key: unreadableKey },
    });
    expect(core.launchCoordinator.reservationFor(unreadable.operation.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'undecided-provider-operation', recordKeys: [unreadableKey] },
    });
    expect(core.launchCoordinator.active).toBe(1);
  });

  it('projects health evidence for an automatically reclaimed launch permit', () => {
    let now = 50_000;
    const baseRuntime = createRealRuntime('prod');
    const runtime = { ...baseRuntime, time: { ...baseRuntime.time, now: () => now } } satisfies Runtime;
    const core = createCore(
      new LocalOperationRegistry(),
      vi.fn(async () => ({ ok: true }) as never),
      runtime,
    );
    const admission = core.launchCoordinator.requestLaunch(
      'automatically-reclaimed-job',
      'codex',
      { kind: 'provider-session', id: 'reclaimed-session' },
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected immediate permit');
    const db = createDb();
    const terminalStatus = { ...acquiredDetail(admission.permit.jobId).status!, phase: 'error' as const };
    installProgressStore(core, db, {
      getDb: () => db,
      listStoredNonterminalJobIds: () => [],
      loadJobProjectionDetail: () => ({ status: terminalStatus, launch: null, runtime: null, exit: null }),
      liveJobCount: () => 0,
      listJobIds: () => [],
      readStatus: () => terminalStatus,
    });

    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS;
    core.eventBus.emit('job:phase_changed', {
      jobId: admission.permit.jobId,
      phase: 'error',
      previousPhase: 'running',
    });

    const decoded = parseBackendHealth(readHealth());
    if (decoded === null) throw new Error('The produced health report did not pass the transport decoder.');
    expect(decoded.health.diagnostics?.launchReclamations).toEqual([
      {
        reservationId: admission.permit.reservationId,
        jobId: admission.permit.jobId,
        pool: 'default',
        provider: 'codex',
        holder: { kind: 'local-execution' },
        heldForMs: LAUNCH_RECLAMATION_AGE_FLOOR_MS,
        evidence: { kind: 'job-terminal', phase: 'error' },
        reclaimedAtMs: now,
      },
    ]);
    expect(core.launchCoordinator.active).toBe(0);
    expect(core.launchCoordinator.reservationFor(admission.permit.jobId)).toBeNull();
  });
});
