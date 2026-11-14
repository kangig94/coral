import { registerProviderProxySetForTest } from '#tests/helpers/provider-proxy-registration.js';
import { describe, expect, it, vi } from 'vitest';

import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { createProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { providerOperationPrepareAttempt } from '#src/coordinator/services/provider-proxy-operation-activation.js';
import { ControlClientError, controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import {
  ProxyControlProtocolError,
  proxyOperationCancelParamsSchema,
  proxyOperationInspectParamsSchema,
  proxyOperationPrepareParamsSchema,
} from '#src/provider-proxy/protocol.js';
import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { operationPrepareAttemptKey } from '#src/provider-proxy/ledger.js';
import { asReservation } from '#tests/helpers/provider-proxy-correlation.js';
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
  hasProviderOperationForJob,
  providerOperationMutationAdmission,
  readProviderOperation,
  subscribeProviderOperationMutations,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { composeReducers } from '#src/store/reducers.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import {
  createTestProviderProxyContainmentProofProducer,
  createTestProviderProxyRecoveryDispatcher,
} from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('accepted provider terminal settlement escalation', () => {
  it('should recover a lost cleanup cancellation reply from a retained admission refusal', async () => {
    const runtime = new SimulationRuntime();
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    const commitContainment = vi.fn(async () => ({ kind: 'outcome-unknown', error: 'unused' }) as const);
    const harness = createProviderOperationReconcilerHarness({
      time: {
        now: () => runtime.time.now(),
        monotonicNow: () => runtime.time.monotonicNow(),
        setTimeout: (callback, ms) => runtime.time.setTimeout(callback, ms),
        clearTimeout: (timer) => runtime.time.clearTimeout(timer),
      },
      authorityFor: () => lifecycle.authorityFor(authority.setIdentity),
      prepareOperation: (attempt) => authority.prepareOperation(attempt),
      cancelOperation: (...args) => authority.cancelOperation(...args),
      commitContainment,
    });
    const { db, reconciler, record } = harness;
    const unsubscribe = subscribeProviderOperationMutations(db, (mutation) => claims.applyMutation(mutation));
    const supervisor = new OperationSupervisor({
      host: {
        start: () => {
          throw new Error('An admission-refused operation cannot start.');
        },
        stop: () => undefined,
      },
      timer: runtime.time,
      mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
      wallClockNow: () => runtime.time.now(),
      nowMs: () => runtime.time.now(),
      proxyInstanceId: record.operation.proxyInstanceId,
      buildSetId: record.operation.buildSetId,
      hostSetFingerprint: record.locator.hostFingerprint,
      stageProviderRoot: () => {
        throw new ProxyControlProtocolError('semantic_operation_admission_closed', 'Admission is closed.');
      },
      pushProviderEvent: () => {
        throw new Error('A never-started operation cannot publish provider events.');
      },
      faultProviderEventControl: () => undefined,
    });
    let resumeInspection!: () => void;
    const inspectionReady = new Promise<void>((resolve) => {
      resumeInspection = resolve;
    });
    const cancel = vi.spyOn(supervisor, 'cancel');
    const inspect = vi.spyOn(supervisor, 'inspect');
    const exchange = vi.fn(async (method: string, params: unknown) => {
      let value: unknown;
      if (method === 'operation.prepare.v1') {
        const request = proxyOperationPrepareParamsSchema.parse(params);
        value = await supervisor.prepare(request.operation, {
          ...request,
          prepareAttemptKey: operationPrepareAttemptKey(request),
        });
      } else if (method === 'operation.cancel.v1') {
        const request = proxyOperationCancelParamsSchema.parse(params);
        value = await supervisor.cancel(request.operation, request.prepareAttemptNumber, request.prepareAttemptKey);
        if (cancel.mock.calls.length === 1) {
          throw new ControlClientError('control_call_failed', 'Cleanup reply timed out', 'timeout');
        }
      } else {
        const request = proxyOperationInspectParamsSchema.parse(params);
        await inspectionReady;
        value = await supervisor.inspect(request.operation, request.prepareAttemptKey);
      }
      return controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } });
    });
    const authority = createProviderProxyOperationAuthority({
      base: harness.authority as never,
      setIdentity: harness.authority.setIdentity,
      clients: { proxy: { exchange } } as never,
      faults: createProviderProxyAuthorityFaultLatch(),
      mutationRpcTimeoutMs: 1_000,
    });
    const containmentProof = createTestProviderProxyContainmentProofProducer(runtime, db);
    const lifecycle = new ProviderProxySetLifecycle({
      buildSetId: record.operation.buildSetId,
      claims,
      capacity: { maxSets: 4, idleRetirement: { kind: 'never' } },
      time: runtime.time,
      controlEstablished: (recovered) => reconciler.onControlEstablished(recovered),
      recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({}),
      reportLifecycle: () => undefined,
      operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(runtime.storage, '/coral/run'),
      writerIncarnation: 'lost-cleanup-reply',
      reapRecordedContainment: async () => ({ kind: 'identity-unobservable', signalDelivered: false }),
      collectOperatorDispositionContainmentProof: (identity, signal) => containmentProof({ identity, signal }),
      reobserveAcquisitionContainment: async () => ({ kind: 'held', observation: 'unknown', reason: 'unused' }),
    });
    lifecycle.activateDurableOperatorDispositions();
    lifecycle.initializeClaimSlots();
    lifecycle.completeStartupDiscovery();
    registerProviderProxySetForTest(lifecycle, authority, {
      kind: 'provider-proxy-set-published',
    } as PublicationReceipt);
    try {
      reconciler.start();
      const beginning = harness.begin();
      await flushMicrotasks(100);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(readProviderOperation(db, record.operation)?.phase).toBe('prestart-cleanup-pending');
      expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
      resumeInspection();
      await flushMicrotasks(100);
      expect(inspect).toHaveBeenCalledWith(record.operation, expect.any(String));
      expect(await inspect.mock.results[0].value).toMatchObject({ state: 'permanent-refusal' });
      expect(lifecycle.authorityFor(authority.setIdentity)).toBe(authority);
      await expect(beginning).resolves.toMatchObject({ kind: 'local-authorized' });
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel.mock.calls[1]).toEqual(cancel.mock.calls[0]);
      expect(await cancel.mock.results[1].value).toEqual({
        state: 'released-never-started',
        operation: record.operation,
        prepareAttemptNumber: cancel.mock.calls[1][1],
        prepareAttemptKey: cancel.mock.calls[1][2],
      });
      expect(hasProviderOperationForJob(db, record.operation.jobId)).toBe(false);
      for (let second = 0; second < 30; second += 1) {
        runtime.time.tick(1_000);
        await flushMicrotasks(100);
      }
      expect(commitContainment).not.toHaveBeenCalled();
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      reconciler.stop();
      unsubscribe();
      db.close();
    }
  });

  it.each(['prepare', 'cancel'] as const)(
    'should reobserve an indeterminate %s and resume a parked sibling through control-established notification',
    async (mutation) => {
      const runtime = new SimulationRuntime();
      const faults = createProviderProxyAuthorityFaultLatch();
      const claims = new ProviderProxySetClaimMirror();
      claims.initialize([]);
      const harness = createProviderOperationReconcilerHarness({
        time: {
          now: () => runtime.time.now(),
          monotonicNow: () => runtime.time.monotonicNow(),
          setTimeout: (callback, ms) => runtime.time.setTimeout(callback, ms),
          clearTimeout: (timer) => runtime.time.clearTimeout(timer),
        },
        authorityFor: () => lifecycle.authorityFor(harness.authority.setIdentity),
      });
      const { db, reconciler } = harness;
      const unsubscribe = subscribeProviderOperationMutations(db, (change) => claims.applyMutation(change));
      let releaseInspection!: () => void;
      const inspectionReady = new Promise<void>((resolve) => {
        releaseInspection = resolve;
      });
      const exchange = vi.fn(async (method: string, params: unknown) => {
        if (method === 'operation.inspect.v1') {
          const request = proxyOperationInspectParamsSchema.parse(params);
          await inspectionReady;
          return controlExchangeForTest({
            kind: 'response',
            response: {
              kind: 'result',
              value: { state: 'released-never-started', ...request, prepareAttemptNumber: 1 },
            },
          });
        }
        if (method === 'operation.settle.v1') {
          return controlExchangeForTest({
            kind: 'response',
            response: { kind: 'result', value: { state: 'released-after-terminal', settledThroughProviderSeq: 4 } },
          });
        }
        throw new ControlClientError('control_call_failed', 'Mutation reply timed out', 'timeout');
      });
      const authority = createProviderProxyOperationAuthority({
        base: harness.authority as never,
        setIdentity: harness.authority.setIdentity,
        clients: { proxy: { exchange } } as never,
        faults,
        mutationRpcTimeoutMs: 1_000,
      });
      const established = vi.fn((recovered: typeof authority) => reconciler.onControlEstablished(recovered));
      const containmentProof = createTestProviderProxyContainmentProofProducer(runtime, db);
      const lifecycle = new ProviderProxySetLifecycle({
        buildSetId: harness.record.operation.buildSetId,
        claims,
        capacity: { maxSets: 4, idleRetirement: { kind: 'never' } },
        time: runtime.time,
        controlEstablished: established,
        recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({}),
        reportLifecycle: () => undefined,
        operatorDispositionStore: new ProviderProxySetOperatorDispositionStore(runtime.storage, '/coral/run'),
        writerIncarnation: 'reobservation-test',
        reapRecordedContainment: async () => ({ kind: 'identity-unobservable', signalDelivered: false }),
        collectOperatorDispositionContainmentProof: (identity, signal) => containmentProof({ identity, signal }),
        reobserveAcquisitionContainment: async () => ({ kind: 'held', observation: 'unknown', reason: 'unused' }),
      });
      lifecycle.activateDurableOperatorDispositions();
      lifecycle.initializeClaimSlots();
      lifecycle.completeStartupDiscovery();
      registerProviderProxySetForTest(lifecycle, authority, {
        kind: 'provider-proxy-set-published',
      } as PublicationReceipt);
      try {
        await harness.begin();
        const executing = readProviderOperation(db, harness.record.operation)!;
        const parked = providerOperationRecordSchema.parse({
          ...executing,
          phase: 'settlement-pending',
          terminalProviderSeq: 4,
          committedThroughProviderSeq: 4,
          settlementIntent: 'release-after-terminal',
          settlementFailure: { elapsedMs: 0, observedAtMs: runtime.time.now(), containmentRequested: false },
          retryNotBeforeMs: Number.MAX_SAFE_INTEGER,
          lastError: { observedAtMs: runtime.time.now(), code: 'operation-control-outcome-unknown', message: 'Held' },
          revision: executing.revision + 1,
        });
        expect(compareAndSwapProviderOperation(db, executing, parked).kind).toBe('updated');
        const inspectedOperation = { ...parked.operation, operationId: '00000000-0000-4000-8000-000000000099' };
        const attempt = providerOperationPrepareAttempt(authority, inspectedOperation, {
          version: 1,
          provider: 'codex',
          binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
          request: {
            action: 'exec',
            jobId: 'session',
            prompt: 'hello',
            cwd: fixtureCanonicalWorkDir(process.cwd()),
            bypassPermissions: false,
            coralEnv: {},
          },
          persistedContinuity: null,
          baseEnv: {},
          protectedEnv: {},
          platform: 'linux',
        });
        established.mockClear();
        await expect(
          mutation === 'prepare'
            ? authority.prepareOperation(attempt)
            : authority.cancelOperation(inspectedOperation, 1, attempt.prepareAttemptKey),
        ).rejects.toThrow('Mutation reply timed out');
        await flushMicrotasks(50);
        expect(exchange).toHaveBeenCalledWith(
          'operation.inspect.v1',
          {
            operation: inspectedOperation,
            prepareAttemptKey: attempt.prepareAttemptKey,
          },
          1_000,
        );
        expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
        reconciler.start();
        await flushMicrotasks(50);
        expect(readProviderOperation(db, parked.operation)?.retryNotBeforeMs).toBe(Number.MAX_SAFE_INTEGER);
        expect(exchange.mock.calls.some(([method]) => method === 'operation.settle.v1')).toBe(false);
        releaseInspection();
        await flushMicrotasks(100);
        expect(established).toHaveBeenCalledWith(authority);
        expect(exchange).toHaveBeenCalledWith(
          'operation.settle.v1',
          { operation: parked.operation, finalProviderSeq: 4 },
          1_000,
        );
        expect(hasProviderOperationForJob(db, parked.operation.jobId)).toBe(false);
        expect(harness.fatalErrors).toEqual([]);
      } finally {
        reconciler.stop();
        unsubscribe();
        db.close();
      }
    },
  );

  it.each([
    { failure: 'rejection', count: 1 },
    { failure: 'outcome unknown', count: 3 },
    { failure: 'inadequate acknowledgement', count: 1 },
    { failure: 'inadequate acknowledgement', count: 2 },
    { failure: 'inadequate acknowledgement', count: 3 },
  ] as const)(
    'ends $count executions and unblocks their waits and next requests after persistent $failure and verified containment',
    async ({ failure, count }) => {
      const runtime = new SimulationRuntime();
      const eventBus = new TypedEventBus();
      const faults = createProviderProxyAuthorityFaultLatch();
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
        ...(failure === 'outcome unknown'
          ? { authorityFor: () => lifecycle.authorityFor(harness.authority.setIdentity) }
          : {}),
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
      registerProviderProxySetForTest(
        lifecycle,
        {
          ...authority,
          faulted: faults.faulted,
          onFault: faults.onFault,
          onIncident: faults.onIncident,
        },
        {
          kind: 'provider-proxy-set-published',
        } as PublicationReceipt,
      );
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
        if (failure === 'outcome unknown') {
          faults.latch({
            kind: 'operation-control-failed',
            policy: {
              method: 'operation.prepare.v1',
              phase: 'prepare-pending',
              effect: 'mutation',
              indeterminate: 'requires-containment',
              preEffectProtocolCodes: new Set(),
            },
            error: new Error('Prepare reply unavailable while siblings await settlement'),
          });
          expect(lifecycle.authorityFor(authority.setIdentity)).toBeNull();
        }
        reconciler.start();
        for (const current of operations) reconciler.settlementPending(current);
        await flushMicrotasks(100);
        for (let n = 0; n < 200 && reap.mock.calls.length === 0; n++) {
          runtime.time.tick(1_000);
          await flushMicrotasks(100);
        }
        expect(reap).toHaveBeenCalled();
        expect(claims.claimsFor(authority.setIdentity)).toHaveLength(failure === 'outcome unknown' ? count : 0);
        if (failure === 'outcome unknown') {
          expect(settle).not.toHaveBeenCalled();
        } else {
          expect(reportLifecycle).toHaveBeenCalledWith(
            'info',
            expect.stringContaining(
              'action=stop-and-reap reason=operation_release_failed fault=none subject=retirement liveClaims=0',
            ),
          );
          expect(settle.mock.calls.length).toBeGreaterThan(count);
        }
        expect(waited.size).toBe(0);
        expect(retention).not.toHaveBeenCalled();
        for (const current of operations) {
          expect(readProviderOperation(db, current)).toMatchObject({
            phase: 'settlement-pending',
            settlementFailure: { containmentRequested: failure !== 'outcome unknown' },
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
          expect(hasProviderOperationForJob(db, operation.jobId)).toBe(false);
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
