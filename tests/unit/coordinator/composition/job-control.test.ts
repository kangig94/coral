import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorControl } from '#src/coordinator/composition/job-control.js';
import type { CoordinatorWorld } from '#src/coordinator/composition/world.js';
import type { ProviderStopDecision } from '#src/coordinator/services/provider-operation-reconciler.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

function noProviderStops(jobIds: readonly string[]): ProviderStopDecision {
  return {
    kind: 'answered',
    outcomes: new Map(jobIds.map((jobId) => [jobId, { kind: 'no-operation' } as const])),
  };
}

function controlFor(
  harness: ReturnType<typeof createProviderOperationReconcilerHarness>,
  internalJobAbortRegistry = new AbortRegistry(new SimulationRuntime().ids),
) {
  return createCoordinatorControl({
    world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
    listExecutionServices: () => [],
    getLifecycleController: () => null,
    getProgressStore: () => harness.progressStore as never,
    internalJobAbortRegistry,
    requestStops: (jobIds, cause) => harness.reconciler.requestStops(jobIds, cause),
  });
}

function createControlHarness(): {
  control: ReturnType<typeof createCoordinatorControl>;
  internalJobAbortRegistry: AbortRegistry;
} {
  const runtime = new SimulationRuntime();
  const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
  const world = {
    idleTimer: { requestDrain() {} },
  } as unknown as CoordinatorWorld;
  const control = createCoordinatorControl({
    world,
    listExecutionServices: () => [],
    getLifecycleController: () => null,
    getProgressStore: () => ({}) as never,
    internalJobAbortRegistry,
    requestStops: noProviderStops,
  });
  return { control, internalJobAbortRegistry };
}

describe('createCoordinatorControl.abortJobs', () => {
  it('refuses before any effect when the saga stop can no longer be recorded', () => {
    const harness = createProviderOperationReconcilerHarness();
    const record = providerOperationRecord('executing');
    insertProviderOperation(harness.db, record);
    const runtime = new SimulationRuntime();
    const registry = new AbortRegistry(runtime.ids);
    const listener = vi.fn();
    const settle = vi.fn();
    registry.register(record.operation.jobId, listener, settle);
    const signal = registry.getSignal(record.operation.jobId);
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: (jobIds: string[]) => registry.abort(jobIds) }] as never,
      getLifecycleController: () => null,
      getProgressStore: () => harness.progressStore as never,
      internalJobAbortRegistry: new AbortRegistry(runtime.ids),
      requestStops: (jobIds, cause) => harness.reconciler.requestStops(jobIds, cause),
    });
    expect(harness.reconciler.stop()).toEqual({ kind: 'drained' });

    expect(control.abortJobs([record.operation.jobId])).toEqual({
      kind: 'successor-owned',
      jobIds: [record.operation.jobId],
    });
    expect(signal?.aborted).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('aborts a saga-owned job no generation-local registry claims', () => {
    const harness = createProviderOperationReconcilerHarness();
    const record = providerOperationRecord('executing');
    insertProviderOperation(harness.db, record);
    const runtime = new SimulationRuntime();
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () => harness.progressStore as never,
      internalJobAbortRegistry: new AbortRegistry(runtime.ids),
      requestStops: (jobIds, cause) => harness.reconciler.requestStops(jobIds, cause),
    });

    expect(control.abortJobs([record.operation.jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [record.operation.jobId], notFound: [] },
    });
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
      phase: 'executing',
      controlIntent: { kind: 'stop', cause: 'signal_abort' },
    });
  });

  it('does not report a local-recovery-pending job aborted before its local owner is registered', async () => {
    let acceptRecovery!: () => void;
    const recoveryAccepted = new Promise<void>((resolve) => {
      acceptRecovery = resolve;
    });
    const completeLocalRecovery = vi.fn();
    const recoverLocalJob = vi.fn(
      async (record: Extract<ProviderOperationRecord, { phase: 'local-recovery-pending' }>) => {
        await recoveryAccepted;
        return { state: 'accepted' as const, jobId: record.operation.jobId, owner: 'recovery-coordinator' as const };
      },
    );
    const harness = createProviderOperationReconcilerHarness({ recoverLocalJob, completeLocalRecovery });
    const record = providerOperationRecord('local-recovery-pending');
    insertProviderOperation(harness.db, record);
    const recovery = harness.reconciler.reconcile(record, harness.authority);
    await vi.waitFor(() => expect(recoverLocalJob).toHaveBeenCalledOnce());

    const decision = controlFor(harness).abortJobs([record.operation.jobId]);

    expect(decision).toEqual({
      kind: 'answered',
      result: { aborted: [], notFound: [record.operation.jobId] },
    });
    expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
    acceptRecovery();
    await recovery;
    expect(readProviderOperation(harness.db, record.operation)).toBeNull();
    expect(completeLocalRecovery).toHaveBeenCalledWith(record.operation.jobId);
  });

  it('reports settlement-pending with the same not-found answer as a rowless job', () => {
    const harness = createProviderOperationReconcilerHarness();
    const record = providerOperationRecord('settlement-pending');
    insertProviderOperation(harness.db, record);
    const control = controlFor(harness);

    expect(control.abortJobs([record.operation.jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [], notFound: [record.operation.jobId] },
    });
    expect(control.abortJobs(['rowless-job'])).toEqual({
      kind: 'answered',
      result: { aborted: [], notFound: ['rowless-job'] },
    });
    expect(readProviderOperation(harness.db, record.operation)).toEqual(record);
  });

  it('reports an executing row that already carries a stop as recorded', () => {
    const harness = createProviderOperationReconcilerHarness();
    const record = providerOperationRecord('executing');
    insertProviderOperation(harness.db, record);
    expect(harness.reconciler.requestStops([record.operation.jobId], 'signal_abort')).toEqual({
      kind: 'answered',
      outcomes: new Map([[record.operation.jobId, { kind: 'recorded' }]]),
    });
    expect(harness.reconciler.requestStops([record.operation.jobId], 'signal_abort')).toEqual({
      kind: 'answered',
      outcomes: new Map([[record.operation.jobId, { kind: 'recorded' }]]),
    });

    expect(controlFor(harness).abortJobs([record.operation.jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [record.operation.jobId], notFound: [] },
    });
  });

  it('does not report an executing row carrying a non-abort stop as recorded', () => {
    const harness = createProviderOperationReconcilerHarness();
    const record = providerOperationRecordSchema.parse({
      ...providerOperationRecord('executing'),
      controlIntent: {
        kind: 'stop',
        cause: 'restart',
        requestedAt: '2026-08-09T12:34:57.000Z',
      },
    });
    insertProviderOperation(harness.db, record);

    expect(harness.reconciler.requestStops([record.operation.jobId], 'signal_abort')).toEqual({
      kind: 'answered',
      outcomes: new Map([[record.operation.jobId, { kind: 'no-operation' }]]),
    });
  });

  it('refuses an unrecorded saga stop without firing its local abort effects', () => {
    const runtime = new SimulationRuntime();
    const registry = new AbortRegistry(runtime.ids);
    const listener = vi.fn();
    const jobId = registry.register('unrecorded-saga-stop', listener);
    const signal = registry.getSignal(jobId);
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: (jobIds: string[]) => registry.abort(jobIds) }] as never,
      getLifecycleController: () => null,
      getProgressStore: () => ({}) as never,
      internalJobAbortRegistry: new AbortRegistry(runtime.ids),
      requestStops: () => ({
        kind: 'answered',
        outcomes: new Map([[jobId, { kind: 'unrecorded', reason: 'provider journal unavailable' }]]),
      }),
    });

    expect(control.abortJobs([jobId])).toEqual({
      kind: 'answered',
      result: {
        aborted: [],
        notFound: [],
        refused: [
          {
            jobId,
            reason: 'provider journal unavailable',
            nextStep:
              "The stop could not be recorded, so this job was not aborted and may still be running. Retry the abort. If the same refusal repeats, this coordinator cannot read the job's provider-operation record.",
          },
        ],
      },
    });
    expect(signal?.aborted).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a durable stop when admission closes before the local registry step', () => {
    const harness = createProviderOperationReconcilerHarness();
    const record = providerOperationRecord('executing');
    insertProviderOperation(harness.db, record);
    const registry = new AbortRegistry(new SimulationRuntime().ids);
    const listener = vi.fn(() => harness.reconciler.requestStop(record.operation.jobId, 'signal_abort'));
    registry.register(record.operation.jobId, listener);
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: (jobIds: string[]) => registry.abort(jobIds) }] as never,
      getLifecycleController: () => null,
      getProgressStore: () => harness.progressStore as never,
      internalJobAbortRegistry: new AbortRegistry(new SimulationRuntime().ids),
      requestStops: (jobIds, cause) => {
        const decision = harness.reconciler.requestStops(jobIds, cause);
        harness.reconciler.stop();
        return decision;
      },
    });

    expect(control.abortJobs([record.operation.jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [record.operation.jobId], notFound: [] },
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
      phase: 'executing',
      controlIntent: { kind: 'stop', cause: 'signal_abort' },
    });
  });

  it('keeps a mixed closed-admission batch away from an incumbent-held local job', () => {
    const harness = createProviderOperationReconcilerHarness();
    const saga = providerOperationRecord('executing');
    insertProviderOperation(harness.db, saga);
    const registry = new AbortRegistry(new SimulationRuntime().ids);
    const heldJobId = registry.register('held-local');
    registry.hold(heldJobId, 'cleanup held', 'inspect containment', () => ({
      kind: 'abandoned',
      reason: 'operator abandoned cleanup',
      nextStep: 'inspect containment',
    }));
    expect(registry.abort([heldJobId]).refused).toHaveLength(1);
    expect(harness.reconciler.stop()).toEqual({ kind: 'drained' });
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: (jobIds: string[]) => registry.abort(jobIds) }] as never,
      getLifecycleController: () => null,
      getProgressStore: () => harness.progressStore as never,
      internalJobAbortRegistry: new AbortRegistry(new SimulationRuntime().ids),
      requestStops: (jobIds, cause) => harness.reconciler.requestStops(jobIds, cause),
    });

    expect(control.abortJobs([saga.operation.jobId, heldJobId])).toEqual({
      kind: 'successor-owned',
      jobIds: [saga.operation.jobId, heldJobId],
    });
    expect(registry.has(heldJobId)).toBe(true);
  });

  it('abandons a held job with no saga row while admission is closed', () => {
    const harness = createProviderOperationReconcilerHarness();
    const runtime = new SimulationRuntime();
    const registry = new AbortRegistry(runtime.ids);
    const jobId = registry.register('held-job-without-saga');
    registry.hold(jobId, 'process absence is not yet proven', 'Inspect the recorded process.', () => ({
      kind: 'abandoned',
      reason: 'operator released cleanup ownership',
      nextStep: 'Inspect the recorded process.',
    }));
    expect(registry.abort([jobId]).refused).toHaveLength(1);
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: (jobIds: string[]) => registry.abort(jobIds) }] as never,
      getLifecycleController: () => null,
      getProgressStore: () => harness.progressStore as never,
      internalJobAbortRegistry: new AbortRegistry(runtime.ids),
      requestStops: (jobIds, cause) => harness.reconciler.requestStops(jobIds, cause),
    });
    expect(harness.reconciler.stop()).toEqual({ kind: 'drained' });

    expect(control.abortJobs([jobId])).toEqual({
      kind: 'answered',
      result: {
        aborted: [],
        notFound: [],
        abandoned: [
          {
            jobId,
            reason: 'operator released cleanup ownership',
            nextStep: 'Inspect the recorded process.',
          },
        ],
      },
    });
  });

  it('reports the first unresolved cleanup as held and uses a later abort as explicit abandonment', () => {
    const runtime = new SimulationRuntime();
    const registry = new AbortRegistry(runtime.ids);
    const abandon = vi.fn(() => ({
      kind: 'abandoned' as const,
      reason: 'job ownership was released without proof of process absence',
      nextStep: 'Inspect the recorded process because it may still be live.',
    }));
    const jobId = registry.register('held-job');
    registry.getSignal(jobId)?.addEventListener(
      'abort',
      () => {
        registry.hold(
          jobId,
          'process absence is not yet proven',
          `Run coral-cli abort jobs ${jobId} again to abandon without another signal.`,
          abandon,
        );
      },
      { once: true },
    );

    expect(registry.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      refused: [
        {
          jobId,
          reason: 'process absence is not yet proven',
          nextStep: `Run coral-cli abort jobs ${jobId} again to abandon without another signal.`,
        },
      ],
    });
    expect(abandon).not.toHaveBeenCalled();

    expect(registry.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      abandoned: [
        {
          jobId,
          reason: 'job ownership was released without proof of process absence',
          nextStep: 'Inspect the recorded process because it may still be live.',
        },
      ],
    });
    expect(abandon).toHaveBeenCalledOnce();
    expect(registry.has(jobId)).toBe(true);
    expect(registry.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      abandoned: [
        {
          jobId,
          reason: 'job ownership was released without proof of process absence',
          nextStep: 'Inspect the recorded process because it may still be live.',
        },
      ],
    });
    expect(abandon).toHaveBeenCalledOnce();
  });

  it('keeps reporting a hold when durable abandonment is not accepted', () => {
    const runtime = new SimulationRuntime();
    const registry = new AbortRegistry(runtime.ids);
    const abandon = vi.fn(() => ({
      kind: 'retained' as const,
      reason: 'durable containment status could not be persisted',
      nextStep: 'Retry durable abandonment.',
    }));
    const jobId = registry.register('held-job');
    registry.hold(jobId, 'process absence is not yet proven', 'Retry durable abandonment.', abandon);
    registry.abort([jobId]);

    expect(registry.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      refused: [
        {
          jobId,
          reason: 'durable containment status could not be persisted',
          nextStep: 'Retry durable abandonment.',
        },
      ],
    });
    expect(abandon).toHaveBeenCalledOnce();
  });

  it('consults the internal-job abort registry before returning notFound', () => {
    const { control, internalJobAbortRegistry } = createControlHarness();
    const jobId = internalJobAbortRegistry.register('kb-reindex-1');

    const decision = control.abortJobs([jobId, 'unknown-job']);

    expect(decision).toEqual({
      kind: 'answered',
      result: { aborted: [jobId], notFound: ['unknown-job'] },
    });
    expect(internalJobAbortRegistry.getSignal(jobId)?.aborted).toBe(true);
  });

  it('reports notFound when the internal-job registry is empty', () => {
    const { control } = createControlHarness();

    const decision = control.abortJobs(['absent-job']);

    expect(decision).toEqual({
      kind: 'answered',
      result: { aborted: [], notFound: ['absent-job'] },
    });
  });

  it('preserves a recovery abort refusal without trying another owner', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const internalAbort = vi.spyOn(internalJobAbortRegistry, 'abort');
    const executionAbort = vi.fn();
    const refusal = {
      jobId: 'recovered-job',
      reason: 'the recorded durable process containment is unavailable',
      nextStep:
        'Run coral-cli jobs detail recovered-job; Coral retains ownership until the recorded containment is observed absent.',
    };
    const recoveryRegistry = {
      size: 1,
      has: (jobId: string) => jobId === refusal.jobId,
      abort: () => ({ aborted: [], notFound: [], refused: [refusal] }),
    };
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: executionAbort }] as never,
      getLifecycleController: () => ({ getRecoveryRegistry: () => recoveryRegistry }) as never,
      getProgressStore: () => ({}) as never,
      internalJobAbortRegistry,
      requestStops: noProviderStops,
    });

    expect(control.abortJobs([refusal.jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [], notFound: [], refused: [refusal] },
    });
    expect(executionAbort).not.toHaveBeenCalled();
    expect(internalAbort).not.toHaveBeenCalled();
  });

  it('preserves an asynchronous recovery abort hold without trying another owner', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const internalAbort = vi.spyOn(internalJobAbortRegistry, 'abort');
    const executionAbort = vi.fn();
    const hold = {
      jobId: 'recovered-job',
      reason: 'identity-safe reaping is awaiting confirmed absence',
      nextStep: 'Wait for cleanup, then inspect the job.',
    };
    const recoveryRegistry = {
      size: 1,
      has: (jobId: string) => jobId === hold.jobId,
      abort: () => ({ aborted: [], notFound: [], held: [hold] }),
    };
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: executionAbort }] as never,
      getLifecycleController: () => ({ getRecoveryRegistry: () => recoveryRegistry }) as never,
      getProgressStore: () => ({}) as never,
      internalJobAbortRegistry,
      requestStops: noProviderStops,
    });

    expect(control.abortJobs([hold.jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [], notFound: [], held: [hold] },
    });
    expect(executionAbort).not.toHaveBeenCalled();
    expect(internalAbort).not.toHaveBeenCalled();
  });
});

describe('createCoordinatorControl.scopeCheckJobs', () => {
  // The status deliberately carries a foreign `backendNamespace`, so this assertion fails again if
  // namespace ever re-enters scope judgement.
  it('keeps a job recorded under another build namespace in scope when the work directory matches', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () =>
        ({
          readStatus: () => ({
            workDir: fixtureCanonicalWorkDir('/current/project'),
            jobKind: 'provider',
            backendNamespace: 'other-ns',
          }),
        }) as never,
      internalJobAbortRegistry,
      requestStops: noProviderStops,
    });

    const result = control.scopeCheckJobs(['foreign-job'], fixtureCanonicalWorkDir('/current/project'), 'exact');

    expect(result).toEqual({ valid: ['foreign-job'], missing: [], mismatch: [] });
  });

  it('keeps KB jobs in scope from any project but rejects foreign non-KB jobs', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const statuses = {
      'kb-job': { workDir: null, jobKind: 'kb', backendNamespace: 'test-ns' },
      'provider-job': {
        workDir: fixtureCanonicalWorkDir('/other/project'),
        jobKind: 'provider',
        backendNamespace: 'test-ns',
      },
    };
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () => ({ readStatus: (id: string) => statuses[id as keyof typeof statuses] ?? null }) as never,
      internalJobAbortRegistry,
      requestStops: noProviderStops,
    });

    const result = control.scopeCheckJobs(
      ['kb-job', 'provider-job'],
      fixtureCanonicalWorkDir('/current/project'),
      'contains',
    );

    expect(result.valid).toContain('kb-job');
    expect(result.mismatch).toContain('provider-job');
    expect(result.mismatch).not.toContain('kb-job');
  });

  it('uses containment for explicit jobs and equality for ambient jobs', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const status = { workDir: fixtureCanonicalWorkDir('/repo/sub'), jobKind: 'provider' };
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () => ({ readStatus: () => status }) as never,
      internalJobAbortRegistry,
      requestStops: noProviderStops,
    });
    const callerRoot = fixtureCanonicalWorkDir('/repo');

    expect(control.scopeCheckJobs(['job'], callerRoot, 'contains').mismatch).toEqual([]);
    expect(control.scopeCheckJobs(['job'], callerRoot, 'exact').mismatch).toEqual(['job']);
  });
});
