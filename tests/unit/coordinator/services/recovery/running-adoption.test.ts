import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunningRecoveryAdoption } from '#src/coordinator/services/recovery/running-adoption.js';
import type { RunningRecoverableJob } from '#src/coordinator/services/recovery/actions.js';
import type { RecordedContainmentObservation } from '#src/infra/process-containment.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import type { RecoveryCapableService, ProviderRecoveryLaunch } from '#src/jobs/reconcile/contracts.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { JobStore } from '#src/jobs/store.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  executionHarness,
  openedJob,
  requestedExecution,
  EXECUTION_JOB_ID,
  EXECUTION_NOW,
} from '#tests/helpers/job-executions.js';
import { testJobConversation } from '#tests/helpers/session.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const journals: ReturnType<typeof executionHarness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.db.close();
});

function createHarness(accepted = true) {
  const journal = executionHarness();
  journals.push(journal);
  const runtime = new SimulationRuntime({ epochMs: Date.parse(EXECUTION_NOW) });
  const jobId = EXECUTION_JOB_ID;
  const store = new JobStore('tests', runtime, journal.ctx.bodyCodec, {
    db: journal.db,
    reducers: journal.ctx.reducers,
    providers: journal.ctx.providers,
  });
  const runtimeRecord: DurableCliRuntimeRecord = {
    transport: 'durable-cli',
    pid: 71_001,
    stdoutPath: '/jobs/stdout',
    stderrPath: '/jobs/stderr',
    startTime: EXECUTION_NOW,
  };
  journal.append(openedJob(), requestedExecution());
  store.appendRuntimeStarted(jobId, runtimeRecord);
  const originalTerminal = {
    content: 'original provider result',
    durationMs: 17,
    outcome: { kind: 'completed' as const },
  };
  if (accepted)
    journal.commit((commit) => {
      appendJobExecutionOutcomeAccepted(commit, { jobId, execution: 1, terminal: originalTerminal });
      return undefined;
    });

  const intervalCallbacks: Array<() => void> = [];
  vi.spyOn(runtime.time, 'setInterval').mockImplementation((callback) => {
    intervalCallbacks.push(callback);
    return { unref: () => undefined };
  });
  let observation: RecordedContainmentObservation = { kind: 'alive' };
  const extractProgress = vi.fn(() =>
    accepted ? { messages: ['late provider progress'], newOffset: 42 } : { messages: [], newOffset: 0 },
  );
  const unexpected = (): never => {
    throw new Error('Unexpected provider operation during containment recovery.');
  };
  const boundProvider: BoundProvider = {
    name: 'codex',
    envelope: TEST_CODEX_BINDING,
    present: () => 'codex fixture',
    readiness: unexpected,
    compareIdentity: unexpected,
    decodeContinuity: unexpected,
    preflight: unexpected,
    prepareExecution: unexpected,
    artifacts: { kind: 'none', reason: 'fixture' },
    recovery: { finalizeInterrupted: unexpected, finalizeFromArtifacts: unexpected, extractProgress },
  };
  const launchRecord: ProviderRecoveryLaunch = {
    jobId,
    execution: 1,
    owner: { kind: 'provider-session', id: jobId },
    provider: 'codex',
    jobKind: 'provider',
    projectRoot: '/workspace',
    backendNamespace: 'tests',
    pool: 'default',
    enqueueSequence: 1,
    createdAt: EXECUTION_NOW,
    providerAction: 'exec',
    request: { prompt: 'recover', cwd: '/workspace', bypassPermissions: false, coralEnv: {} },
  };
  const recovery: RunningRecoverableJob = {
    jobId,
    runtimeRecord,
    authority: {
      launchRecord,
      boundProvider,
      session: testJobConversation(jobId, { execution: 1, open: true, finishing: accepted, projectRoot: '/workspace' }),
    },
  };
  const finisher = new ExecutionFinisher({
    time: runtime.time,
    commit: journal.commit,
    read: (address) => readExecutionFinishingState(journal.db, address, journal.readCtx),
    quiesce: async () => observation.kind === 'absent',
    retentionAction: unexpected,
    settleRetention: unexpected,
  });
  const adoptRunningJob = vi
    .fn<RecoveryCapableService['adoptRunningJob']>()
    .mockResolvedValue({ adopted: true, cleanup: () => undefined });
  const finalizeInterruptedDurableJob = vi
    .fn<RecoveryCapableService['finalizeInterruptedDurableJob']>()
    .mockImplementation(async () => finisher.finish({ jobId, execution: 1 }));
  const service: RecoveryCapableService = {
    captureProviderRecoveryAuthority: unexpected,
    finalizeInterruptedAppServerJob: unexpected,
    recoverQueuedJob: unexpected,
    interruptAppServerJob: unexpected,
    adoptRunningJob,
    finalizeInterruptedDurableJob,
  };
  const state = {
    recoveryRegistry: null,
    cancelledRecoveryJobIds: new Set<string>(),
    adoptedRunningPids: new Map<string, { pid: number; pool: string }>(),
    unansweredAdoptionProbes: new Map<string, number>(),
    recoveryPollIntervals: new Map<string, TimerHandle>(),
    adoptedRunningJobCleanups: new Map<string, () => void>(),
    teardownRequested: false,
  };
  const context: InvocationContext = {
    projectRoot: fixtureCanonicalWorkDir('/workspace'),
    pluginRoot: '/plugin',
    coralEnv: {},
    principal: {
      subject: 'system',
      transport: 'local',
      credential: { kind: 'test', id: 'test' },
      binding: { kind: 'unbound' },
    },
  };
  const log: string[] = [];
  const startTrackedFinalization = vi
    .fn<Parameters<typeof createRunningRecoveryAdoption>[0]['startTrackedFinalization']>()
    .mockImplementation(async (_jobId, signal, run) => run({ signal, onCommitStart: () => undefined }));
  const dependencies: Parameters<typeof createRunningRecoveryAdoption>[0] = {
    state,
    progressStore: store,
    runtime,
    getRecoveryService: () => service,
    createInvocationContext: () => context,
    log: (message) => log.push(message),
    clearRecoveryPoller: () => undefined,
    startTrackedFinalization,
    observeDurableRecoveryContainment: () => ({ evidence: { kind: 'unavailable', reason: 'missing' }, observation }),
    runHeldRecoveryReap: unexpected,
    deleteCoordinatorRecoveryQuarantine: () => true,
    runCoordinatorWalk: unexpected,
    settleUnexpectedRecoveryFailure: unexpected,
    settleFault: unexpected,
    takeAdoptedJobCleanup: () => state.adoptedRunningJobCleanups.get(jobId) ?? null,
    maybeReleaseRecoveryRegistry: () => undefined,
  };
  const appendProgress = vi.spyOn(store, 'appendProgress');
  const appendRuntimeStarted = vi.spyOn(store, 'appendRuntimeStarted');
  const run = () => {
    const detail = store.loadJobProjectionDetail(jobId);
    if (detail.status === null) throw new Error('Expected requested provider job.');
    return createRunningRecoveryAdoption(dependencies)(
      recovery,
      {
        signal: new AbortController().signal,
        coordinatorCommit: journal.commit,
        interruptedAppServerReason: 'restart',
        abandonHeldJob: () => ({ kind: 'refused', reason: 'not abandoned' }),
      },
      {
        item: { jobId, detail: { ...detail, status: detail.status }, conversation: null },
        controls: {
          report: () => undefined,
          setProcessLocalCleanup: () => undefined,
          clearProcessLocalCleanup: () => undefined,
        },
      },
    );
  };
  return {
    journal,
    state,
    run,
    startTrackedFinalization,
    log,
    intervalCallbacks,
    extractProgress,
    appendProgress,
    appendRuntimeStarted,
    adoptRunningJob,
    finalizeInterruptedDurableJob,
    originalTerminal,
    observe: (next: RecordedContainmentObservation) => {
      observation = next;
    },
    finishingState: () => readExecutionFinishingState(journal.db, { jobId, execution: 1 }, journal.readCtx),
  };
}

describe('running recovery adoption finalization ownership', () => {
  it('logs and consumes a rejected tracked finalization', async () => {
    const h = createHarness(false);
    h.startTrackedFinalization.mockRejectedValue(new Error('tracked finalization rejected'));
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(h.run()).resolves.toMatchObject({ kind: 'advanced', detail: 'running job adopted' });
      h.observe({ kind: 'absent' });
      const poll = h.intervalCallbacks[0];
      if (poll === undefined) throw new Error('Expected adopted-runtime poller.');
      poll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.log.join('')).toContain('Durable finalization cleanup failed');
      expect(h.log.join('')).toContain('tracked finalization rejected');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it.each<RecordedContainmentObservation>([
    { kind: 'alive' },
    { kind: 'unobservable', reason: 'identity probe unavailable' },
  ])('keeps an accepted execution open while durable containment is $kind', async (observation) => {
    const h = createHarness();
    h.observe(observation);
    const result = await h.run();
    expect(result).toMatchObject(
      observation.kind === 'alive' ? { kind: 'advanced', detail: 'running job adopted' } : { kind: 'quarantine' },
    );
    expect(h.finalizeInterruptedDurableJob).not.toHaveBeenCalled();
    expect(h.adoptRunningJob).toHaveBeenCalledTimes(observation.kind === 'alive' ? 1 : 0);
    const poll = h.intervalCallbacks[0];
    if (poll !== undefined) poll();
    expect(h.finishingState()).toMatchObject({ kind: 'finishing', accepted: { terminal: h.originalTerminal } });
    expect(h.extractProgress).not.toHaveBeenCalled();
    expect(h.appendProgress).not.toHaveBeenCalled();
    expect(h.appendRuntimeStarted).not.toHaveBeenCalled();
  });

  it('finishes the original accepted outcome after durable containment is absent without appending progress', async () => {
    const h = createHarness();
    h.observe({ kind: 'absent' });
    await expect(h.run()).resolves.toMatchObject({ kind: 'advanced', detail: 'dead durable job finalized' });
    expect(h.finalizeInterruptedDurableJob).toHaveBeenCalledTimes(1);
    expect(h.adoptRunningJob).not.toHaveBeenCalled();
    expect(h.finishingState()).toMatchObject({ kind: 'ended', accepted: { terminal: h.originalTerminal } });
    expect(h.journal.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
    expect(h.extractProgress).not.toHaveBeenCalled();
    expect(h.appendProgress).not.toHaveBeenCalled();
    expect(h.appendRuntimeStarted).not.toHaveBeenCalled();
  });
});
