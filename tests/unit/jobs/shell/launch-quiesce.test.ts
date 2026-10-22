import { ProviderRegistry } from '#src/providers/registry.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { JobStore } from '#src/jobs/store.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { recordProviderTerminal } from '#src/coordinator/services/terminal-materializer.js';
import { executionHarness } from '#tests/helpers/job-executions.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { initTestJob, testConversationFacet } from '#tests/helpers/session.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { ProviderEventBody } from '#src/providers/contract.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const jobId = '10000000-0000-4000-8000-000000000001';
const journals: ReturnType<typeof executionHarness>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of journals.splice(0)) h.db.close();
});

function controlledStream() {
  const started = createDeferred<void>();
  const buffer: Array<{ event: ProviderEventBody; processed(): void }> = [];
  let wake = createDeferred<void>();
  let ended = false;
  const iterable = {
    async *[Symbol.asyncIterator]() {
      started.resolve();
      while (!ended) {
        if (buffer.length === 0) await wake.promise;
        const next = buffer.shift();
        if (!next) continue;
        try {
          yield next.event;
        } finally {
          next.processed();
        }
      }
    },
  };
  return {
    iterable,
    started: started.promise,
    emit(event: ProviderEventBody) {
      const processed = createDeferred<void>();
      buffer.push({ event, processed: () => processed.resolve() });
      wake.resolve();
      wake = createDeferred<void>();
      return processed.promise;
    },
    end() {
      ended = true;
      wake.resolve();
    },
  };
}

function fixture(
  options: { checkpointGate?: Promise<void>; releaseGate?: Promise<void>; finishingGate?: Promise<void> } = {},
) {
  const runtime = new SimulationRuntime();
  const h = executionHarness();
  journals.push(h);
  const store = new JobStore('test', runtime, h.ctx.bodyCodec, {
    db: h.db,
    providers: h.ctx.providers,
    reducers: h.ctx.reducers,
  });
  initTestJob(store, {
    jobId: jobId,
    conversation: testConversationFacet('codex', '/project'),
    projectRoot: '/project',
    backendNamespace: 'test',
  });
  const sessions = new ConversationManager('/project', runtime, (cb) => store.commit(cb), h.db);
  const admission = new LaunchCoordinator({ runtime });
  const registry = new AbortRegistry();
  const stream = controlledStream();
  const checkpointStarted = createDeferred<void>();
  const releaseStarted = createDeferred<void>();
  const completed = createDeferred<void>();
  const terminals: ProviderEventBody[] = [];
  const releaseStates: Array<{ owned: boolean; state: string }> = [];
  let artifact = false;
  registry.register(jobId, 1);
  const accepted = admission.requestLaunch(jobId, 'codex', { kind: 'provider-session', id: jobId }, 'default');
  if (accepted === 'queue_full' || accepted.type !== 'immediate') throw new Error('expected permit');
  const release = admission.releaseLaunch.bind(admission);
  admission.releaseLaunch = (permit) => {
    releaseStates.push({
      owned: finisher.owns({ jobId, execution: 1 }),
      state: finisher.state({ jobId, execution: 1 }).kind,
    });
    const result = release(permit);
    completed.resolve();
    return result;
  };
  const checkpoint = sessions.checkpointJobContinuityAtomic.bind(sessions);
  vi.spyOn(sessions, 'checkpointJobContinuityAtomic').mockImplementation(async (...args) => {
    checkpointStarted.resolve();
    await options.checkpointGate;
    return checkpoint(...args);
  });
  const ensureResult = store.ensureResultArtifact.bind(store);
  vi.spyOn(store, 'ensureResultArtifact').mockImplementation((...args) => {
    artifact = true;
    return ensureResult(...args);
  });
  const finisher = new ExecutionFinisher({
    time: { sleep: async () => {} },
    commit: (cb) => store.commit(cb),
    read: (address) => readExecutionFinishingState(h.db, address, store),
    quiesce: async () => {
      await options.finishingGate;
      return true;
    },
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  const provider: BoundProvider = {
    name: 'codex',
    envelope: TEST_CODEX_BINDING,
    present: () => 'Codex fixture',
    artifacts: { kind: 'none', reason: 'fixture' },
    appServer: {
      supportsInterrupt: false,
      openReplacement: async () => {
        throw new Error('Replacement hosts are outside this fixture.');
      },
      interrupt: async () => {
        throw new Error('Provider interruption is outside this fixture.');
      },
      send: async () => {
        throw new Error('Provider input is outside this fixture.');
      },
    },
    compareIdentity: () => ({ ok: true, value: true }),
    decodeContinuity: () => ({ ok: true, value: undefined }),
    readiness: async (use) => ({ ok: true, value: { ready: true, use } }),
    preflight: async () => ({ kind: 'satisfied' }),
    prepareExecution: () => ({
      kind: 'app-server',
      hostSpec: { provider: 'codex', command: 'fixture', args: [], leaseMode: 'job-exclusive' },
      execute: () => stream.iterable,
    }),
  };
  const orchestrator = new LaunchOrchestrator({
    runtime,
    launchAdmission: admission,
    providerOperationBinding: admission,
    abortRegistry: registry,
    backendNamespace: 'test',
    bundleHash: 'test',
    providerRegistry: new ProviderRegistry(),
    durableSpawner: admission,
    progressStore: store,
    conversationManager: sessions,
    coordinatorCommit: (cb) => store.commit(cb),
    executionFinisher: finisher,
    settlementRefusalRecorder: { record: () => true },
    terminalMaterializer: {
      recordProviderTerminal: async (owner, event, address) => {
        terminals.push(event);
        releaseStarted.resolve();
        await options.releaseGate;
        return recordProviderTerminal(owner, event, address);
      },
    },
  });
  orchestrator.runAsync(
    provider,
    jobId,
    1,
    {
      action: 'exec',
      jobId: jobId,
      prompt: 'run',
      cwd: fixtureCanonicalWorkDir('/project'),
      coralEnv: {},
      bypassPermissions: false,
    },
    accepted,
    'default',
  );
  return {
    runtime,
    store,
    events: h.events,
    releaseStates,
    orchestrator,
    admission,
    registry,
    stream,
    sessions,
    terminals,
    finisher,
    checkpointStarted: checkpointStarted.promise,
    releaseStarted: releaseStarted.promise,
    completed: completed.promise,
    hasArtifact: () => artifact,
  };
}

const terminal: ProviderEventBody = {
  kind: 'terminal',
  terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
  diagnostics: {},
};

describe('LaunchOrchestrator handoff quiesce', () => {
  const persistenceEvents: ProviderEventBody[] = [
    { kind: 'continuity', conversationRef: 'thread-retry', resumable: true, providerContinuity: null },
    { kind: 'artifact_handle', handle: '/native/rollout.jsonl', identity: { kind: 'fixture', ref: 'thread-retry' } },
  ];

  it.each(persistenceEvents)(
    'retains the local stream and permit until a failed $kind write recovers',
    async (event) => {
      const finishing = createDeferred<void>();
      const retry = createDeferred<void>();
      const f = fixture({ finishingGate: finishing.promise });
      await f.stream.started;
      let available = false;
      const commit = f.store.commit.bind(f.store);
      const writes = vi.spyOn(f.store, 'commit').mockImplementation((...args) => {
        if (!available) throw new Error('storage unavailable');
        return commit(...args);
      });
      const sleep = vi.spyOn(f.runtime.time, 'sleep').mockImplementation(() => retry.promise);
      const receipt = { commit: vi.fn(), reject: vi.fn() };
      const emitted = f.stream.emit(event.kind === 'continuity' ? attachContinuityCommit(event, receipt) : event);
      try {
        await vi.waitFor(() => expect(writes).toHaveBeenCalled());
        expect(f.admission.reservationFor(jobId)).not.toBeNull();
        expect(f.orchestrator.holdsLocalAppServerExecution(jobId, 1)).toBe(true);
        expect(f.registry.has(jobId, 1)).toBe(true);
        expect(f.events().filter((row) => row.type === 'job.execution.outcome.accepted')).toHaveLength(0);
        expect(receipt.commit).not.toHaveBeenCalled();
        expect(receipt.reject).not.toHaveBeenCalled();
        expect(sleep).toHaveBeenCalledTimes(1);

        available = true;
        retry.resolve();
        await emitted;
        await f.stream.emit(terminal);
        await f.completed;
        expect(f.releaseStates).toEqual([{ owned: true, state: 'finishing' }]);
        finishing.resolve();
        await f.finisher.finish({ jobId, execution: 1 });
        expect(f.terminals).toEqual([terminal]);
        expect(f.events().filter((row) => row.type === 'job.execution.outcome.accepted')).toHaveLength(1);
        expect(f.events().filter((row) => row.type === 'job.execution.ended')).toHaveLength(1);
        expect(f.events().filter((row) => row.type === 'job.continuity.checkpointed')).toHaveLength(
          event.kind === 'continuity' ? 1 : 0,
        );
        expect(f.events().filter((row) => row.type === 'job.artifact.recorded')).toHaveLength(
          event.kind === 'artifact_handle' ? 1 : 0,
        );
        expect(receipt.commit).toHaveBeenCalledTimes(event.kind === 'continuity' ? 1 : 0);
        expect(receipt.reject).not.toHaveBeenCalled();
        expect(f.admission.reservationFor(jobId)).toBeNull();
        expect(f.orchestrator.holdsLocalAppServerExecution(jobId, 1)).toBe(false);
      } finally {
        available = true;
        retry.resolve();
        finishing.resolve();
        f.stream.end();
        await f.finisher.dispose();
      }
    },
  );

  it.each(persistenceEvents)('fences a failed $kind write when handoff starts during retry sleep', async (event) => {
    const retry = createDeferred<void>();
    const f = fixture();
    await f.stream.started;
    const writes = vi.spyOn(f.store, 'commit').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const sleep = vi.spyOn(f.runtime.time, 'sleep').mockImplementation(() => retry.promise);
    const receipt = { commit: vi.fn(), reject: vi.fn() };
    const emitted = f.stream.emit(event.kind === 'continuity' ? attachContinuityCommit(event, receipt) : event);
    try {
      await vi.waitFor(() => expect(writes).toHaveBeenCalled());
      expect(sleep).toHaveBeenCalledTimes(1);
      await f.orchestrator.quiesceAppServerJobsForHandoff();
      retry.resolve();
      await emitted;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toHaveBeenCalledTimes(1);
      expect(receipt.commit).not.toHaveBeenCalled();
      expect(receipt.reject).toHaveBeenCalledTimes(event.kind === 'continuity' ? 1 : 0);
      expect(f.releaseStates).toEqual([]);
      expect(f.admission.reservationFor(jobId)).not.toBeNull();
      expect(f.events().filter((row) => row.type === 'job.execution.outcome.accepted')).toHaveLength(0);
    } finally {
      retry.resolve();
      f.stream.end();
      await f.finisher.dispose();
    }
  });

  it('waits for an in-flight checkpoint and rejects its receipt after handoff', async () => {
    const checkpoint = createDeferred<void>();
    const f = fixture({ checkpointGate: checkpoint.promise });
    await f.stream.started;
    let committed = false;
    const rejected = createDeferred<void>();
    const emitted = f.stream.emit(
      attachContinuityCommit(
        {
          kind: 'continuity',
          conversationRef: null,
          resumable: false,
          providerContinuity: null,
        },
        {
          commit: () => {
            committed = true;
          },
          reject: () => rejected.resolve(),
        },
      ),
    );
    await f.checkpointStarted;
    let quiesced = false;
    const quiesce = f.orchestrator.quiesceAppServerJobsForHandoff().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    checkpoint.resolve();
    await Promise.all([quiesce, emitted, rejected.promise]);
    expect(committed).toBe(false);
    f.stream.end();
  });

  it('prevents terminal recording and ownership release after quiesce', async () => {
    const f = fixture();
    await f.stream.started;
    await f.orchestrator.quiesceAppServerJobsForHandoff();
    await f.stream.emit(terminal);
    expect(f.terminals).toEqual([]);
    expect(f.hasArtifact()).toBe(false);
    expect(f.sessions.readById(jobId)?.open).toBe(true);
    expect(f.admission.reservationFor(jobId)).not.toBeNull();
    f.stream.end();
  });

  it('waits for terminal finalization before the claim release completes', async () => {
    const release = createDeferred<void>();
    const f = fixture({ releaseGate: release.promise });
    await f.stream.started;
    const emitted = f.stream.emit(terminal);
    await f.releaseStarted;
    let quiesced = false;
    const quiesce = f.orchestrator.quiesceAppServerJobsForHandoff().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    expect(f.terminals).toHaveLength(1);
    expect(f.sessions.readById(jobId)?.open).toBe(true);
    release.resolve();
    await Promise.all([quiesce, emitted, f.completed]);
    await f.finisher.finish({ jobId: jobId, execution: 1 });
    expect(f.sessions.readById(jobId)?.open).toBe(false);
  });

  it('cannot clear a replacement execution registration with stale terminal cleanup', async () => {
    const f = fixture();
    await f.stream.started;
    f.registry.register(jobId, 2);
    const replacement = f.registry.getSignal(jobId, 2);
    await f.stream.emit(terminal);
    await f.completed;
    expect(f.registry.getSignal(jobId, 2)).toBe(replacement);
    expect(f.admission.reservationFor(jobId)).toBeNull();
    expect(f.registry.has(jobId, 2)).toBe(true);
  });
});
