import { describe, expect, it, vi } from 'vitest';

import { createCoordinatorControl } from '#src/coordinator/composition/job-control.js';
import type { CoordinatorWorld } from '#src/coordinator/composition/world.js';
import type { ProviderStopDecision } from '#src/coordinator/services/provider-operation-reconciler.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
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
    isLifecycleRunning: () => true,
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
    isLifecycleRunning: () => true,
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
      world: {
        idleTimer: { requestDrain() {} },
        launchCoordinator: { successionAdmissionPaused: () => false },
      } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: (jobIds: string[]) => registry.abort(jobIds) }] as never,
      isLifecycleRunning: () => true,
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
      isLifecycleRunning: () => true,
      getLifecycleController: () => null,
      getProgressStore: () => harness.progressStore as never,
      internalJobAbortRegistry: new AbortRegistry(runtime.ids),
      requestStops: (jobIds, cause) => harness.reconciler.requestStops(jobIds, cause),
    });

    expect(control.abortJobs([record.operation.jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [record.operation.jobId], stopRequested: [record.operation.jobId], notFound: [] },
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

  it('refuses an unrecorded saga stop without firing its local abort effects', () => {
    const runtime = new SimulationRuntime();
    const registry = new AbortRegistry(runtime.ids);
    const listener = vi.fn();
    const jobId = registry.register('unrecorded-saga-stop', listener);
    const signal = registry.getSignal(jobId);
    const control = createCoordinatorControl({
      world: { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld,
      listExecutionServices: () => [{ abort: (jobIds: string[]) => registry.abort(jobIds) }] as never,
      isLifecycleRunning: () => true,
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
      isLifecycleRunning: () => true,
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
      result: { aborted: [record.operation.jobId], stopRequested: [record.operation.jobId], notFound: [] },
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(readProviderOperation(harness.db, record.operation)).toMatchObject({
      phase: 'executing',
      controlIntent: { kind: 'stop', cause: 'signal_abort' },
    });
  });

  it('returns a typed retryable cancellation while writers are parked and aborts after admission reopens', () => {
    const runtime = new SimulationRuntime();
    const registry = new AbortRegistry(runtime.ids);
    const jobId = registry.register('parked-job');
    let parked = true;
    const control = createCoordinatorControl({
      world: {
        idleTimer: { requestDrain() {} },
        launchCoordinator: { successionAdmissionPaused: () => parked },
      } as unknown as CoordinatorWorld,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      isLifecycleRunning: () => true,
      getProgressStore: () => ({}) as never,
      internalJobAbortRegistry: registry,
      requestStops: (jobIds) => (parked ? { kind: 'admission-closed', jobIds } : noProviderStops(jobIds)),
    });

    expect(control.abortJobs([jobId])).toEqual({
      kind: 'retryable',
      code: 'succession_admission_paused',
      jobIds: [jobId],
    });
    expect(registry.has(jobId)).toBe(true);

    parked = false;
    expect(control.abortJobs([jobId])).toEqual({
      kind: 'answered',
      result: { aborted: [jobId], notFound: [] },
    });
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
      isLifecycleRunning: () => true,
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
      isLifecycleRunning: () => true,
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
      isLifecycleRunning: () => true,
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
      isLifecycleRunning: () => true,
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
});

it('keeps a recorded stop applied when its saga has a permanent diagnostic', () => {
  const harness = createProviderOperationReconcilerHarness();
  const record = providerOperationRecord('proxy-activation-pending');
  insertProviderOperation(harness.db, {
    ...record,
    lastError: { observedAtMs: 100, code: 'provider_activation_ack_invalid', message: 'Fingerprint mismatch' },
  });
  const decision = controlFor(harness).abortJobs([record.operation.jobId]);
  expect(decision).toMatchObject({
    kind: 'answered',
    result: {
      aborted: [record.operation.jobId],
      stopRequested: [record.operation.jobId],
      stopDiagnostics: [
        { jobId: record.operation.jobId, lastError: 'provider_activation_ack_invalid: Fingerprint mismatch' },
      ],
    },
  });
});

it('annotates an applied stop with a condensed retry diagnostic without creating an abort hold', () => {
  const harness = createProviderOperationReconcilerHarness();
  const initial = providerOperationRecord('executing');
  const registry = new AbortRegistry(new SimulationRuntime().ids);
  vi.spyOn(registry, 'abort').mockReturnValue({
    aborted: [],
    notFound: [],
    held: [{ jobId: initial.operation.jobId, reason: 'Local cleanup is pending', nextStep: 'Wait for cleanup.' }],
  });
  const record = {
    ...initial,
    lastError: { observedAtMs: 100, code: 'provider_operation_failed', message: 'Reply lost\n  while stopping' },
  };
  try {
    insertProviderOperation(harness.db, record);
    const decision = controlFor(harness, registry).abortJobs([record.operation.jobId]);
    expect(decision).toMatchObject({
      kind: 'answered',
      result: {
        aborted: [record.operation.jobId],
        stopRequested: [record.operation.jobId],
        stopDiagnostics: [
          { jobId: record.operation.jobId, lastError: 'provider_operation_failed: Reply lost while stopping' },
        ],
      },
    });
    expect(decision.kind === 'answered' && decision.result.held).toBeUndefined();
  } finally {
    harness.reconciler.stop();
    harness.db.close();
  }
});
