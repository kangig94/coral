import { describe, expect, it, vi } from 'vitest';

import { createObserveCarriers } from '#src/coordinator/composition/carrier-observation.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { observeCarrierStatuses, type CarrierStatusConnector } from '#src/coordinator/live/carrier-observer.js';
import type { JobProjectionDetail } from '#src/jobs/read-queries.js';
import type { JobEvent } from '#src/jobs/records.js';
import { planCarrierWaitEvents, WaitCoordinator, type CarrierWaitObservation } from '#src/jobs/shell/wait.js';
import {
  proxyOperationStatusNonceSchema,
  proxyOperationStatusParamsSchema,
  proxyOperationStatusResultSchema,
} from '#src/provider-proxy/protocol.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const JOB_A = 'job-a';
const JOB_B = 'job-b';
const INHERITED_JOB_ID = '00000000-0000-4000-8000-000000000098';
const STATUS_NONCE = proxyOperationStatusNonceSchema.parse('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function inheritedDetail(): JobProjectionDetail {
  return {
    status: {
      jobId: INHERITED_JOB_ID,
      owner: { kind: 'provider-session', id: 'session-1' },
      sessionId: 'session-1',
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: 'test-ns',
      jobKind: 'provider',
      phase: 'running',
      updatedAt: '2026-08-11T00:00:00.000Z',
    },
    launch: null,
    runtime: {
      transport: 'app-server',
      startTime: '2026-08-11T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        hostRef: { provider: 'codex', fingerprint: 'runtime-only', instanceId: 'host', leaseMode: 'shared' },
      },
    },
    exit: null,
  };
}

function emptySubscription(abortSignal?: AbortSignal): AsyncIterable<JobEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      if (!abortSignal?.aborted) {
        await new Promise<void>((resolve) => abortSignal?.addEventListener('abort', () => resolve(), { once: true }));
      }
    },
  };
}

function observation(jobId: string, liveness: CarrierWaitObservation['liveness']): CarrierWaitObservation {
  return { jobId, liveness, storedPhase: 'running', observedMaxJournalSeq: 9 };
}

describe('planCarrierWaitEvents', () => {
  it('turns an absent carrier into one nonterminal interruption', () => {
    const pending = new Set([JOB_A, JOB_B]);

    const plan = planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, new Set());

    expect(plan.interrupted).toEqual([
      {
        type: 'interrupted',
        jobId: JOB_A,
        storedPhase: 'running',
        observedMaxJournalSeq: 9,
        remainingJobIds: [JOB_A, JOB_B],
        observation: { kind: 'carrier_interrupted', reason: 'carrier_absent' },
        continuity: 'unavailable',
        outcome: 'unknown',
      },
    ]);
    // Nothing left `pending`: the job is still running as far as the journal is concerned, and only the
    // journal may end it.
    expect(pending).toEqual(new Set([JOB_A, JOB_B]));
  });

  it('reports the same absence once across ticks', () => {
    const pending = new Set([JOB_A]);
    const reported = new Set<string>();

    const first = planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, reported);
    const second = planCarrierWaitEvents([observation(JOB_A, 'absent')], pending, reported);

    // Observation runs on every poll tick; the event reports a discovery, so restating it each tick would
    // say the same thing indefinitely while the job is still pending.
    expect(first.interrupted).toHaveLength(1);
    expect(second.interrupted).toEqual([]);
  });

  it('collects unknowns for the waiting snapshot in sorted order and emits nothing for them', () => {
    const plan = planCarrierWaitEvents(
      [observation(JOB_B, 'unknown'), observation(JOB_A, 'unknown')],
      new Set([JOB_A, JOB_B]),
      new Set(),
    );

    expect(plan.interrupted).toEqual([]);
    expect(plan.unknownJobIds).toEqual([JOB_A, JOB_B]);
  });

  it('says nothing at all about a live carrier', () => {
    const plan = planCarrierWaitEvents([observation(JOB_A, 'live')], new Set([JOB_A]), new Set());

    expect(plan).toEqual({ interrupted: [], unknownJobIds: [] });
  });

  it('ignores a verdict about a job this stream is no longer waiting on', () => {
    // A reply can arrive after its job terminalized. Emitting an interruption for it would contradict a
    // journal terminal that has already been delivered.
    const plan = planCarrierWaitEvents([observation(JOB_B, 'absent')], new Set([JOB_A]), new Set());

    expect(plan).toEqual({ interrupted: [], unknownJobIds: [] });
  });
});

describe('wait carrier observation composition', () => {
  it('does not emit interrupted when the real observer validates a held transport reply', async () => {
    const db = createDb();
    const record = providerOperationRecord('executing', { job: 98 });
    insertProviderOperation(db, record);
    const requests: ReturnType<typeof proxyOperationStatusParamsSchema.parse>[] = [];
    const close = vi.fn();
    const connect: CarrierStatusConnector = vi.fn(async () => ({
      call: async (_method: string, params: unknown) => {
        const request = proxyOperationStatusParamsSchema.parse(params);
        requests.push(request);
        return proxyOperationStatusResultSchema.parse({
          proxy: {
            proxyInstanceId: record.operation.proxyInstanceId,
            buildSetId: record.operation.buildSetId,
          },
          nonce: request.nonce,
          operations: request.operations.map((operation) => ({ operation, state: 'held' })),
        });
      },
      close,
    }));
    const observerTimer = { setTimeout: () => ({}), clearTimeout: () => {} };
    const detail = inheritedDetail();
    const observeCarriers = createObserveCarriers(
      {
        getDb: () => db,
        loadJobProjectionDetail: (jobId) =>
          jobId === INHERITED_JOB_ID ? detail : { status: null, launch: null, runtime: null, exit: null },
        platform: process.platform,
        hasStartupRecoveryPassed: () => false,
        isAdmittedByThisCoordinator: () => false,
        registryStateForJob: () => null,
      },
      () => 9,
      (records) =>
        observeCarrierStatuses(records, {
          timer: observerTimer,
          mintNonce: () => STATUS_NONCE,
          log: vi.fn(),
          connect,
        }),
    );
    const runtime = createRealRuntime('prod');
    const coordinator = new WaitCoordinator({
      sessionManager: { get: () => null },
      launchQueue: new LaunchCoordinator({ runtime }),
      eventBus: new TypedEventBus(),
      jobPools: new Map(),
      time: runtime.time,
      loadJobProjectionDetail: (jobId) =>
        jobId === INHERITED_JOB_ID ? detail : { status: null, launch: null, runtime: null, exit: null },
      readJobEvents: () => [],
      aggregateWorkflowUsage: () => undefined,
      subscribeJobEvents: ({ abortSignal }) => emptySubscription(abortSignal),
      getCurrentJournalSeq: () => 9,
      resultPathForJob: (jobId) => `/tmp/coral-exports/jobs/${jobId}/result.md`,
      observeCarriers,
    });
    const iterator = coordinator.waitForJobs({ jobIds: [INHERITED_JOB_ID], timeoutSeconds: 0 })[Symbol.asyncIterator]();

    const first = await iterator.next();

    expect(first.value).not.toMatchObject({ type: 'interrupted' });
    expect(first.value).toEqual({ type: 'waiting', waitingJobIds: [INHERITED_JOB_ID] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.operations).toEqual([record.operation]);
    expect(close).toHaveBeenCalledOnce();
    await iterator.return?.(undefined);
    db.close();
  });
});
