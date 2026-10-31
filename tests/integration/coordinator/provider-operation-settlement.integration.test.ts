import { describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import type { PublicationReceipt } from '#src/coordinator/live/provider-proxy/set-publication.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import {
  authorizeProviderProxySetContainmentProof,
  createProviderProxySetContainmentProver,
  runProviderProxySetContainmentProofMutation,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import { ProviderProxySetOperatorDispositionStore } from '#src/coordinator/services/provider-proxy-set/operator-disposition-store.js';
import type { ProviderProxySetRecordedContainmentReapResult } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { JobStore } from '#src/jobs/store.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import {
  compareAndSwapProviderOperation,
  insertProviderOperation,
  providerOperationMutationAdmission,
  readProviderOperation,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { composeReducers } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('accepted provider terminal settlement escalation', () => {
  it.each([
    { failure: 'rejection', count: 1 },
    { failure: 'inadequate acknowledgement', count: 1 },
    { failure: 'inadequate acknowledgement', count: 2 },
    { failure: 'inadequate acknowledgement', count: 3 },
  ] as const)(
    'ends $count executions and unblocks their waits and next requests after persistent $failure and verified containment',
    async ({ failure, count }) => {
      const runtime = new SimulationRuntime();
      const eventBus = new TypedEventBus();
      const siblingOperations = Array.from(
        { length: count - 1 },
        (_, index) => providerOperationRecord('settlement-pending', { job: index + 10 }).operation,
      );
      let store!: JobStore;
      const settle = vi.fn(async (_operation, seq: number) => {
        if (failure === 'rejection') throw new Error('Settlement rejected');
        return { state: 'released-after-terminal' as const, settledThroughProviderSeq: seq - 1 };
      });
      const harness = createProviderOperationReconcilerHarness({
        time: {
          now: () => runtime.time.now(),
          monotonicNow: () => runtime.time.monotonicNow(),
          setTimeout: (callback, ms) => runtime.time.setTimeout(callback, ms),
          clearTimeout: (timer) => runtime.time.clearTimeout(timer),
        },
        settleOperation: settle,
        commitContainment: async () => ({ kind: 'outcome-unknown', error: 'Containment reply unavailable' }),
        requestContainment: (identity, request) => lifecycle.requestOperationContainment(identity, request),
        progressStore: (db, record) => {
          store = new JobStore('settlement-test', runtime, createEventBodyCodec(), {
            db,
            reducers: composeReducers(jobsRegistry),
            providers: permissiveProviderLookupPort,
            eventBus,
          });
          for (const { jobId } of [record.operation, ...siblingOperations]) {
            store.commit(
              (c) => {
                const opened = openedJob({ owner: { kind: 'provider-session', id: jobId } });
                if (opened.body.jobKind !== 'provider') throw new Error('provider fixture');
                opened.body.conversation.retention = 'discard_provider_artifacts_on_terminal';
                c.append({ ...opened, stream: { kind: 'job', id: jobId } });
                c.append({ ...requestedExecution(), stream: { kind: 'job', id: jobId } });
                return undefined;
              },
              { admittingJobs: [jobId] },
            );
          }
          return store;
        },
      });
      const { db, reconciler, authority } = harness;
      const operation = harness.record.operation;
      const operations = [operation, ...siblingOperations];
      const addresses = operations.map(({ jobId }) => ({ jobId, execution: 1 }));
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([]);
      const unsubscribe = subscribeProviderOperationMutations(db, (mutation) => claims.applyMutation(mutation));
      let reapResult: ProviderProxySetRecordedContainmentReapResult = {
        kind: 'identity-unobservable',
        signalDelivered: false,
      };
      const reap = vi.fn(async () => reapResult);
      const reportLifecycle = vi.fn();
      const prover = createProviderProxySetContainmentProver({
        ...runtime,
        process: { ...runtime.process, readProcessIncarnation: () => null, observeLiveness: () => 'absent' },
      });
      const collectProof = (identity: typeof authority.setIdentity, signal: AbortSignal) => {
        const mutationFence = providerOperationMutationAdmission(db).closeSet(identity);
        return prover.collectContainmentProof(
          authorizeProviderProxySetContainmentProof(identity, {
            mutationFence,
            closeAdmission: async () => {
              if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
            },
          }),
          db,
          signal,
        );
      };
      const lifecycle = new ProviderProxySetLifecycle({
        buildSetId: operation.buildSetId,
        claims,
        capacity: { maxSets: 4, idleRetirement: { kind: 'never' } },
        time: runtime.time,
        controlEstablished: () => undefined,
        fenceProviderOperationMutations: (identity) => providerOperationMutationAdmission(db).closeSet(identity),
        recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({
          'containment-proof': ({ identity, signal }) => collectProof(identity, signal),
          'disappearance-consumer': ({ notice, mutationProof }) =>
            mutationProof === undefined
              ? reconciler.containmentDisappeared(notice)
              : runProviderProxySetContainmentProofMutation(
                  mutationProof,
                  notice.setIdentity,
                  'test-disappearance',
                  () => reconciler.containmentDisappeared(notice),
                ),
          'capsule-retirement': () => ({ kind: 'retired' }),
        }),
        reapRecordedContainment: reap,
        reportLifecycle,
        operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(runtime.storage, '/coral/run'),
        writerIncarnation: 'settlement-test',
        collectOperatorDispositionContainmentProof: collectProof,
        reobserveAcquisitionContainment: async () => ({ kind: 'held', observation: 'unknown', reason: 'unused' }),
      });
      lifecycle.activateDurableOperatorDispositions();
      lifecycle.initializeClaimSlots();
      lifecycle.completeStartupDiscovery();
      lifecycle.registerInheritedSet(authority, { kind: 'provider-proxy-set-published' } as PublicationReceipt);
      const retention = vi.fn(async () => ({ kind: 'completed', outcome: 'discarded' }) as const);
      const finisher = new ExecutionFinisher({
        recovery: { db: () => db, readCtx: store, time: runtime.time },
        time: runtime.time,
        commit: (write) => store.commit(write),
        read: (address) => readExecutionFinishingState(db, address, store),
        quiesce: async (address) =>
          readProviderOperation(db, operations.find(({ jobId }) => jobId === address.jobId)!) === null,
        retentionAction: async () => ({ attempt: 0, handles: ['/native'] }),
        settleRetention: retention,
      });
      const wait = new WaitCoordinator({
        conversationManager: { get: () => null },
        launchQueue: harness.startupOwnership.binding,
        eventBus,
        time: runtime.time,
        loadJobWaitDetail: (jobId, seq, ids) => store.loadJobWaitDetail(jobId, seq, ids),
        readJobLastSeq: (jobId) => store.readJobLastSeq(jobId),
        visitProgress: (_epoch, read) => store.visitProgress(read),
        aggregateWorkflowUsage: () => undefined,
        subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
        getCurrentJournalSeq: () => store.readJobLastSeq(operation.jobId) ?? 0,
        resultJobsRoot: runtime.paths.coral.exports.jobsRoot,
        observeResultAvailability: () => {
          throw new Error('unused');
        },
      });
      try {
        await harness.begin();
        const executing = readProviderOperation(db, operation)!;
        for (const [index, current] of operations.entries()) {
          const address = addresses[index];
          const requestSeq = store.readJobLastSeq(current.jobId)!;
          store.commit((c) => {
            appendJobExecutionOutcomeAccepted(c, {
              ...address,
              terminal: { content: 'original provider result', outcome: { kind: 'completed' }, durationMs: 1 },
            });
            return undefined;
          });
          const pending = providerOperationRecordSchema.parse({
            ...(index === 0 ? executing : providerOperationRecord('settlement-pending', { operation: current })),
            jobLaunchEventSeq: requestSeq,
            phase: 'settlement-pending',
            terminalProviderSeq: 4,
            committedThroughProviderSeq: 4,
            settlementIntent: 'release-after-terminal',
            settlementFailure: { elapsedMs: 0, observedAtMs: runtime.time.now(), containmentRequested: false },
            revision: index === 0 ? executing.revision + 1 : 0,
          });
          if (index === 0) {
            expect(compareAndSwapProviderOperation(db, executing, pending).kind).toBe('updated');
          } else {
            insertProviderOperation(db, pending);
            const launch = store.readLaunchProjection(current.jobId)!;
            const permit = harness.startupOwnership.binding.restoreActiveLaunch(
              current.jobId,
              'codex',
              launch.owner,
              launch.pool,
            );
            expect(harness.startupOwnership.binding.prepareProviderOperationBinding(permit, current).kind).toBe(
              'prepared',
            );
          }
        }
        const waited = new Set<string>();
        const waiting = operations.map(({ jobId }) =>
          wait.waitForJobTerminal(jobId, 180_000).then(() => {
            waited.add(jobId);
          }),
        );
        const finishing = addresses.map((address) => finisher.finish(address));
        reconciler.start();
        for (const current of operations) reconciler.settlementPending(current);
        await flushMicrotasks(100);
        for (let n = 0; n < 30 && reap.mock.calls.length === 0; n++) {
          runtime.time.tick(5_000);
          await flushMicrotasks(100);
        }
        expect(reap).toHaveBeenCalled();
        expect(claims.claimsFor(authority.setIdentity)).toEqual([]);
        expect(reportLifecycle).toHaveBeenCalledWith(
          'info',
          expect.stringContaining(
            'action=stop-and-reap reason=operation_release_failed fault=none subject=retirement liveClaims=0',
          ),
        );
        expect(settle.mock.calls.length).toBeGreaterThan(count);
        expect(waited.size).toBe(0);
        expect(retention).not.toHaveBeenCalled();
        for (const current of operations) {
          expect(readProviderOperation(db, current)).toMatchObject({
            phase: 'settlement-pending',
            settlementFailure: { containmentRequested: true },
          });
          expect(claims.claimFor(current)).not.toBeNull();
          expect(store.loadJobWaitDetail(current.jobId).terminalSeq).toBeUndefined();
          expect(() =>
            store.commit((c) => {
              c.append({ ...requestedExecution(2), stream: { kind: 'job', id: current.jobId } });
              return undefined;
            }),
          ).toThrow();
        }

        reapResult = { kind: 'containment-absent', disappearanceReceipt: 'verified-settlement-containment' };
        for (let n = 0; n < 10 && waited.size < count; n++) {
          runtime.time.tick(1_000);
          await flushMicrotasks(100);
        }
        expect(waited.size).toBe(count);
        await Promise.all([...waiting, ...finishing]);
        expect(retention).toHaveBeenCalledTimes(count);
        for (const operation of operations) {
          expect(readProviderOperation(db, operation)).toBeNull();
          expect(claims.claimFor(operation)).toBeNull();
          expect(
            db
              .prepare<[string], { type: string }>('SELECT type FROM events WHERE stream_id = ? ORDER BY seq')
              .all(operation.jobId)
              .map((event) => event.type)
              .slice(-4),
          ).toEqual([
            'job.execution.outcome.accepted',
            'job.retention.discard.requested',
            'job.retention.discard.completed',
            'job.execution.ended',
          ]);
          expect(store.readStatus(operation.jobId)).toMatchObject({ execution: 1, phase: 'completed' });
          expect(store.loadJobWaitDetail(operation.jobId).exit).toMatchObject({
            content: 'original provider result',
            outcome: { kind: 'completed' },
          });
          store.commit(
            (c) => {
              c.append({ ...requestedExecution(2), stream: { kind: 'job', id: operation.jobId } });
              return undefined;
            },
            { admittingJobs: [operation.jobId] },
          );
          expect(store.readStatus(operation.jobId)?.execution).toBe(2);
        }
        expect(harness.fatalErrors).toEqual([]);
      } finally {
        reconciler.stop();
        unsubscribe();
        db.close();
      }
    },
  );
});
