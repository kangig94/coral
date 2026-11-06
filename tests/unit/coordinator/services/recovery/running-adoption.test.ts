import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyRecoveryAction } from '#src/coordinator/services/recovery/actions.js';
import { reapDurableCliProcess } from '#src/coordinator/services/recovery/actions.js';
import { observeDurableRecoveryContainmentFor } from '#src/coordinator/services/recovery/lifecycle.js';
import { createRunningRecoveryAdoption } from '#src/coordinator/services/recovery/running-adoption.js';
import { RecoveryRegistry } from '#src/jobs/reconcile/registry.js';
import type { CoordinatorRecoveryControls } from '#src/coordinator/services/recovery/walk.js';
import type { RunningRecoverableJob } from '#src/coordinator/services/recovery/actions.js';
import { markDurableCliExecutionEntered, recordDurableCliExecution } from '#src/jobs/durable-cli-execution.js';
import { writeDurableCliProvisionalProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { ProcessContainmentError } from '#src/infra/process-containment.js';
import type { RecordedContainmentObservation } from '#src/infra/process-containment.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import type { RecoveryCapableService, ProviderRecoveryLaunch } from '#src/jobs/reconcile/contracts.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import {
  ExecutionAcceptanceRefusedError,
  ExecutionFinisher,
  readExecutionFinishingState,
} from '#src/jobs/finishing.js';
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
    recoveryRegistry: null as RecoveryRegistry | null,
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
    takeAdoptedJobCleanup: () => {
      const cleanup = state.adoptedRunningJobCleanups.get(jobId) ?? null;
      state.adoptedRunningJobCleanups.delete(jobId);
      return cleanup;
    },
    maybeReleaseRecoveryRegistry: () => undefined,
  };
  const appendProgress = vi.spyOn(store, 'appendProgress');
  const appendRuntimeStarted = vi.spyOn(store, 'appendRuntimeStarted');
  let localCleanup: (() => void) | undefined;
  const run = (controls?: CoordinatorRecoveryControls) => {
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
        controls: controls ?? {
          report: () => undefined,
          setProcessLocalCleanup: (cleanup) => {
            localCleanup = cleanup;
          },
          clearProcessLocalCleanup: () => {
            localCleanup = undefined;
          },
        },
      },
    );
  };
  return {
    journal,
    dependencies,
    service,
    store,
    runtime,
    runtimeRecord,
    recovery,
    releaseLocalCleanup: () => localCleanup?.(),
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
  it.each(['populated', 'missing', 'unknown'] as const)(
    'keeps the same leaf evidence through provider finalization when it becomes %s before commit',
    async (transition) => {
      const h = createHarness();
      const identity = { pid: h.runtimeRecord.pid, incarnation: testIncarnation('adopted-wrapper') };
      writeDurableCliProvisionalProcessRuntimeMeta(h.journal.db, {
        jobId: EXECUTION_JOB_ID,
        ...identity,
        processGroupId: identity.pid,
      });
      recordDurableCliExecution(h.journal.db, { jobId: EXECUTION_JOB_ID, execution: 1, ...identity });
      Object.defineProperty(h.runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
      let observation: FailureDomainObservation = { kind: 'absent' };
      vi.spyOn(h.runtime.process, 'failureDomainContainment').mockReturnValue({
        observe: () => observation,
        kill: () => ({ kind: 'refused', errno: 'EACCES' }),
      });
      h.observe({ kind: 'absent' });
      let finish!: () => void;
      const paused = new Promise<void>((resolve) => {
        finish = resolve;
      });
      h.finalizeInterruptedDurableJob.mockImplementation(async (_authority, _record, _outcome, fence) => {
        await paused;
        fence.onCommitStart();
      });
      const result = h.run();
      const rejection = expect(result).rejects.toMatchObject({ code: 'process_containment_reap_failed' });
      await vi.waitFor(() => expect(h.finalizeInterruptedDurableJob).toHaveBeenCalledOnce());
      observation = transition === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: transition };
      finish();
      await rejection;
      expect(h.finishingState()).toMatchObject({ kind: 'finishing' });
    },
  );

  it('refreshes the same leaf at the actual registered cleanup callback', async () => {
    const h = createHarness();
    const identity = { pid: h.runtimeRecord.pid, incarnation: testIncarnation('release-wrapper') };
    writeDurableCliProvisionalProcessRuntimeMeta(h.journal.db, {
      jobId: EXECUTION_JOB_ID,
      ...identity,
      processGroupId: identity.pid,
    });
    recordDurableCliExecution(h.journal.db, { jobId: EXECUTION_JOB_ID, execution: 1, ...identity });
    Object.defineProperty(h.runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
    let empty = true;
    vi.spyOn(h.runtime.process, 'failureDomainContainment').mockReturnValue({
      observe: () => (empty ? { kind: 'absent' } : { kind: 'missing' }),
      kill: () => ({ kind: 'refused', errno: 'EACCES' }),
    });
    const registry = new RecoveryRegistry();
    registry.register(EXECUTION_JOB_ID, h.recovery.authority.launchRecord, h.runtimeRecord);
    h.state.recoveryRegistry = registry;
    h.observe({ kind: 'absent' });
    await expect(h.run()).resolves.toMatchObject({ kind: 'advanced' });
    empty = false;
    expect(() => h.releaseLocalCleanup()).toThrow(/leaf absence/);
    expect(registry.has(EXECUTION_JOB_ID)).toBe(true);
  });

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
      observation.kind === 'alive' ? { kind: 'advanced', detail: 'running job adopted' } : { kind: 'deferred' },
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

function placed(h: ReturnType<typeof createHarness>) {
  const identity = { pid: h.runtimeRecord.pid, incarnation: testIncarnation('registered-wrapper') };
  writeDurableCliProvisionalProcessRuntimeMeta(h.journal.db, {
    jobId: EXECUTION_JOB_ID,
    ...identity,
    processGroupId: identity.pid,
  });
  recordDurableCliExecution(h.journal.db, { jobId: EXECUTION_JOB_ID, execution: 1, ...identity });
  Object.defineProperty(h.runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
  let observation: FailureDomainObservation = { kind: 'absent' };
  const kill = vi.fn(() => ({ kind: 'refused' as const, errno: 'EACCES' }));
  vi.spyOn(h.runtime.process, 'failureDomainContainment').mockReturnValue({ observe: () => observation, kill });
  vi.spyOn(h.dependencies, 'observeDurableRecoveryContainment').mockImplementation((_job, record, leaf) =>
    observeDurableRecoveryContainmentFor(h.store, h.runtime, EXECUTION_JOB_ID, record, leaf),
  );
  vi.spyOn(h.dependencies, 'runHeldRecoveryReap').mockImplementation((_job, record, signal, leaf) =>
    reapDurableCliProcess(h.runtime, record, signal, leaf?.failureDomain, leaf),
  );
  const registry = new RecoveryRegistry();
  h.state.recoveryRegistry = registry;
  registry.register(EXECUTION_JOB_ID, h.recovery.authority.launchRecord, h.runtimeRecord);
  let tick = 0n;
  vi.spyOn(h.runtime.time, 'monotonicNow').mockImplementation(() => (tick += 25n));
  vi.spyOn(h.runtime.time, 'sleep').mockResolvedValue();
  return {
    identity,
    registry,
    kill,
    set: (next: FailureDomainObservation) => {
      observation = next;
    },
  };
}

async function registerAcrossMissing(h: ReturnType<typeof createHarness>, leaf: ReturnType<typeof placed>) {
  let capture!: () => void;
  const paused = new Promise<void>((resolve) => {
    capture = resolve;
  });
  vi.spyOn(h.service, 'captureProviderRecoveryAuthority').mockImplementation(async () => {
    await paused;
    return { ok: true, authority: h.recovery.authority };
  });
  const running: RunningRecoverableJob[] = [];
  const pending = applyRecoveryAction(
    {
      type: 'registerRunning',
      jobId: EXECUTION_JOB_ID,
      launchRecord: h.recovery.authority.launchRecord,
      runtimeRecord: h.runtimeRecord,
    },
    {
      progressStore: h.store,
      recoveryRegistry: leaf.registry,
      queuedRecoverable: [],
      runningRecoverable: running,
      runtime: h.runtime,
      log: () => undefined,
      createInvocationContext: () => ({}) as never,
      getRecoveryService: () => h.service,
      signal: new AbortController().signal,
      settleFault: () => [],
      setProcessLocalCleanup: () => undefined,
      clearProcessLocalCleanup: () => undefined,
    },
  );
  leaf.set({ kind: 'missing' });
  capture();
  await pending;
  if (running[0] === undefined) throw new Error('registration must transfer recovery');
  Object.assign(h.recovery, running[0]);
}

it('retains registration leaf history through authority capture and abort acceptance', async () => {
  const h = createHarness();
  const leaf = placed(h);
  await registerAcrossMissing(h, leaf);
  expect(leaf.registry.abort([EXECUTION_JOB_ID]).aborted).toEqual([]);
  await leaf.registry.getAbortDisposition(EXECUTION_JOB_ID)?.settlement;
  await Promise.resolve();
  expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(true);
  expect(leaf.registry.getAbortDisposition(EXECUTION_JOB_ID)?.kind).not.toBe('accepted');
  installReleaseWalk(h);
  await expect(h.run()).resolves.toMatchObject({ kind: 'deferred' });
  leaf.set({ kind: 'absent' });
  h.observe({ kind: 'absent' });
  h.intervalCallbacks[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(false);
  expect(h.finishingState().kind).toBe('ended');
});

it('retains registration leaf history through authority capture and adoption finalization', async () => {
  const h = createHarness();
  const leaf = placed(h);
  await registerAcrossMissing(h, leaf);
  h.observe({ kind: 'absent' });
  await expect(h.run()).resolves.toMatchObject({ kind: 'deferred' });
  expect(h.finalizeInterruptedDurableJob).not.toHaveBeenCalled();
  expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(true);
  expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(true);
  installReleaseWalk(h);
  leaf.set({ kind: 'absent' });
  h.observe({ kind: 'absent' });
  h.intervalCallbacks[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(false);
  expect(h.finishingState().kind).toBe('ended');
});

it('reaps a surviving leaf instead of adopting its dead wrapper', async () => {
  const h = createHarness();
  const leaf = placed(h);
  leaf.set({ kind: 'populated' });
  vi.spyOn(h.runtime.process, 'observeLiveness').mockImplementation((pid) =>
    pid === -h.runtimeRecord.pid ? 'alive' : 'absent',
  );
  await expect(h.run()).resolves.toMatchObject({ kind: 'deferred' });
  expect(h.adoptRunningJob).not.toHaveBeenCalled();
  expect(leaf.kill).toHaveBeenCalled();
  expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(true);
  expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(true);
});

it.each([
  ['planned', 'populated'],
  ['planned', 'missing'],
  ['planned', 'unknown'],
  ['entered', 'populated'],
  ['entered', 'missing'],
  ['entered', 'unknown'],
] as const)(
  'retains adopted cleanup with a %s receipt and retries finalization after the leaf becomes %s',
  async (phase, kind) => {
    const h = createHarness(false);
    const leaf = placed(h);
    if (phase === 'entered')
      markDurableCliExecutionEntered(h.journal.db, { jobId: EXECUTION_JOB_ID, execution: 1, ...leaf.identity });
    const cleanup = vi.fn();
    h.adoptRunningJob.mockResolvedValue({ adopted: true, cleanup });
    let wrapperLive = true;
    vi.spyOn(h.runtime.process, 'observeLiveness').mockImplementation((pid) =>
      Math.abs(pid) === h.runtimeRecord.pid && wrapperLive ? 'alive' : 'absent',
    );
    vi.spyOn(h.runtime.process, 'readProcessIncarnation').mockImplementation((pid) =>
      pid === h.runtimeRecord.pid && wrapperLive ? leaf.identity.incarnation : null,
    );
    installReleaseWalk(h);
    let first = true;
    h.finalizeInterruptedDurableJob.mockImplementation(async (_authority, _record, _outcome, fence) => {
      await Promise.resolve();
      if (first) {
        first = false;
        leaf.set(kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind });
      }
      fence.onCommitStart();
    });
    await h.run();
    wrapperLive = false;
    h.intervalCallbacks[0]?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanup).not.toHaveBeenCalled();
    expect(h.state.adoptedRunningJobCleanups.has(EXECUTION_JOB_ID)).toBe(true);
    expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(true);
    leaf.set({ kind: 'absent' });
    h.intervalCallbacks[0]?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(h.state.adoptedRunningJobCleanups.has(EXECUTION_JOB_ID)).toBe(false);
    expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(false);
    expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(false);
  },
);

function installReleaseWalk(h: ReturnType<typeof createHarness>) {
  let quarantined = false;
  vi.spyOn(h.dependencies, 'deleteCoordinatorRecoveryQuarantine').mockImplementation(() => {
    quarantined = false;
    return true;
  });
  vi.spyOn(h.dependencies, 'clearRecoveryPoller').mockImplementation(() => {
    h.state.recoveryPollIntervals.delete(EXECUTION_JOB_ID);
  });
  vi.spyOn(h.dependencies, 'runCoordinatorWalk').mockImplementation(async (options) => {
    if (quarantined) return;
    let release: (() => void) | undefined;
    const controls = {
      report: () => undefined,
      clearProcessLocalCleanup: () => {
        release = undefined;
      },
      setProcessLocalCleanup: (fn: () => void) => {
        release = fn;
      },
    };
    const detail = h.store.loadJobProjectionDetail(EXECUTION_JOB_ID);
    if (detail.status === null) throw new Error('fixture status');
    try {
      const result = await options.settle(
        { jobId: EXECUTION_JOB_ID, detail: { ...detail, status: detail.status }, conversation: null },
        controls,
      );
      if (result.kind === 'advanced') release?.();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ProcessContainmentError') throw error;
      quarantined = true;
    }
  });
}

it.each(['direct', 'wrapped'] as const)(
  'retains interrupted app-server cleanup and automatically retries its %s quarantined finalization',
  async (form) => {
    const h = createHarness(false);
    h.recovery.runtimeRecord = {
      transport: 'app-server',
      startTime: EXECUTION_NOW,
      providerMeta: { provider: 'codex', leaseState: 'waiting' },
    };
    const registry = new RecoveryRegistry();
    registry.register(EXECUTION_JOB_ID, h.recovery.authority.launchRecord, h.recovery.runtimeRecord);
    h.state.recoveryRegistry = registry;
    const cleanup = vi.fn();
    h.state.adoptedRunningJobCleanups.set(EXECUTION_JOB_ID, cleanup);
    let repaired = false;
    const finalize = vi.spyOn(h.service, 'finalizeInterruptedAppServerJob').mockImplementation(async () => {
      if (!repaired) {
        const refusal = new ProcessContainmentError('process_containment_reap_failed', 'carrier leaf disappeared');
        throw form === 'wrapped'
          ? new ExecutionAcceptanceRefusedError('Interrupted recovery refused', { cause: refusal })
          : refusal;
      }
    });
    let quarantined = false;
    vi.spyOn(h.dependencies, 'deleteCoordinatorRecoveryQuarantine').mockImplementation(() => {
      quarantined = false;
      return true;
    });
    const retryWalk = vi
      .fn<Parameters<typeof createRunningRecoveryAdoption>[0]['runCoordinatorWalk']>()
      .mockImplementation(async (options) => {
        if (quarantined) return;
        const detail = h.store.loadJobProjectionDetail(EXECUTION_JOB_ID);
        if (detail.status === null) throw new Error('requested fixture missing');
        let release: (() => void) | undefined;
        const result = await options.settle(
          { jobId: EXECUTION_JOB_ID, detail: { ...detail, status: detail.status }, conversation: null },
          {
            report: () => {},
            setProcessLocalCleanup: (callback) => {
              release = callback;
            },
            clearProcessLocalCleanup: () => {
              release = undefined;
            },
          },
        );
        if (result.kind === 'quarantine') quarantined = true;
        release?.();
      });
    vi.spyOn(h.dependencies, 'runCoordinatorWalk').mockImplementation(retryWalk);
    vi.spyOn(h.dependencies, 'clearRecoveryPoller').mockImplementation((jobId) => {
      const interval = h.state.recoveryPollIntervals.get(jobId);
      if (interval !== undefined) h.runtime.time.clearInterval(interval);
      h.state.recoveryPollIntervals.delete(jobId);
    });
    const result = await h.run();
    expect(result).toMatchObject({ kind: 'quarantine', detail: expect.stringContaining('500ms') });
    quarantined = true;
    h.releaseLocalCleanup();
    expect(cleanup).not.toHaveBeenCalled();
    expect(registry.has(EXECUTION_JOB_ID)).toBe(true);
    expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(true);
    repaired = true;
    h.intervalCallbacks[0]?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.has(EXECUTION_JOB_ID)).toBe(false);
    expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(false);
  },
);

it.each(['receipt-valid', 'receipt-legacy', 'metadata-valid'] as const)(
  'automatically releases registered containment after unresolved %s evidence is repaired',
  async (repair) => {
    const h = createHarness();
    const leaf = placed(h);
    const receipt = h.journal.db
      .prepare<
        [],
        { key: string; value: string }
      >("SELECT key, value FROM meta WHERE key LIKE 'durable_cli_execution.v1:%'")
      .get();
    if (receipt === undefined) throw new Error('receipt fixture missing');
    if (repair === 'metadata-valid')
      h.journal.db.prepare("DELETE FROM meta WHERE key LIKE 'durable_cli_provisional_process.v1:%'").run();
    else h.journal.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('corrupt receipt', receipt.key);
    await registerAcrossMissing(h, leaf);
    h.observe({ kind: 'absent' });
    installReleaseWalk(h);
    await expect(h.run()).resolves.toMatchObject({ kind: 'deferred' });
    expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(true);
    expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(true);
    if (repair === 'metadata-valid')
      writeDurableCliProvisionalProcessRuntimeMeta(h.journal.db, {
        jobId: EXECUTION_JOB_ID,
        ...leaf.identity,
        processGroupId: leaf.identity.pid,
      });
    else if (repair === 'receipt-legacy') h.journal.db.prepare('DELETE FROM meta WHERE key = ?').run(receipt.key);
    else h.journal.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(receipt.value, receipt.key);
    leaf.set(repair === 'receipt-legacy' ? { kind: 'missing' } : { kind: 'absent' });
    h.intervalCallbacks[0]?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(leaf.registry.has(EXECUTION_JOB_ID)).toBe(false);
    expect(h.state.recoveryPollIntervals.has(EXECUTION_JOB_ID)).toBe(false);
    expect(h.finishingState().kind).toBe('ended');
  },
);
