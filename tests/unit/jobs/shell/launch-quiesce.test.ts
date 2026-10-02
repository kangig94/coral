import { describe, expect, it } from 'vitest';

import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import type { ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

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

function fixture(options: { checkpointGate?: Promise<void>; releaseGate?: Promise<void> } = {}) {
  const runtime = new SimulationRuntime();
  const admission = new LaunchCoordinator({ runtime });
  const registry = new AbortRegistry(runtime.ids);
  const stream = controlledStream();
  const checkpointStarted = createDeferred<void>();
  const releaseStarted = createDeferred<void>();
  const completed = createDeferred<void>();
  const terminals: ProviderEventBody[] = [];
  const session = { sessionId: 'session-1', activeJobId: 'job-1', version: 1, providerContinuity: null };
  let artifact = false;
  registry.register('job-1');
  const accepted = admission.requestLaunch('job-1', 'codex', { kind: 'provider-session', id: 'session-1' }, 'default');
  if (accepted === 'queue_full' || accepted.type !== 'immediate') throw new Error('expected permit');
  const release = admission.releaseLaunch.bind(admission);
  admission.releaseLaunch = (permit) => {
    const result = release(permit);
    completed.resolve();
    return result;
  };
  const provider = {
    name: 'codex',
    appServer: {},
    compareIdentity: () => ({ ok: true }),
    decodeContinuity: () => ({ ok: true, value: undefined }),
    readiness: async () => ({ ok: true }),
    prepareExecution: () => ({ kind: 'app-server', execute: () => stream.iterable }),
  } as unknown as BoundProvider;
  const orchestrator = new LaunchOrchestrator({
    runtime,
    launchAdmission: admission,
    providerOperationBinding: admission,
    abortRegistry: registry,
    backendNamespace: 'test',
    bundleHash: 'test',
    providerRegistry: {} as never,
    durableSpawner: {} as never,
    progressStore: {
      appendProgress: () => {},
      readStatus: () => ({ phase: 'running' }),
      readLaunchProjection: () => null,
      ensureResultArtifact: () => {
        artifact = true;
      },
    } as never,
    sessionManager: {
      get: () => session,
      checkpointJobContinuityAtomic: async () => {
        checkpointStarted.resolve();
        await options.checkpointGate;
        session.version++;
        return { ok: true, nextVersion: session.version };
      },
      releaseJobClaimAtomic: async (
        _sessionId: string,
        claim: { expectedActiveJobId: string; expectedVersion: number },
      ) => {
        releaseStarted.resolve();
        await options.releaseGate;
        if (session.activeJobId !== claim.expectedActiveJobId || session.version !== claim.expectedVersion)
          return false;
        session.activeJobId = '';
        return true;
      },
    } as never,
    coordinatorCommit: () => [],
    settlementRefusalRecorder: { record: () => true },
    terminalMaterializer: {
      recordProviderTerminal: (_store, event) => {
        terminals.push(event);
      },
    },
  });
  orchestrator.runAsync(
    provider,
    'session-1',
    'job-1',
    {
      action: 'exec',
      sessionId: 'session-1',
      prompt: 'run',
      cwd: '/project',
      coralEnv: {},
      bypassPermissions: false,
    } as ProviderRequest,
    accepted,
    'default',
  );
  return {
    orchestrator,
    admission,
    registry,
    stream,
    session,
    terminals,
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
    expect(f.session.activeJobId).toBe('job-1');
    expect(f.admission.reservationFor('job-1')).not.toBeNull();
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
    expect(f.session.activeJobId).toBe('job-1');
    release.resolve();
    await Promise.all([quiesce, emitted, f.completed]);
    expect(f.session.activeJobId).toBe('');
  });

  it('cannot clear a replacement claim with a stale terminal release', async () => {
    const f = fixture();
    await f.stream.started;
    f.session.activeJobId = 'replacement';
    f.session.version++;
    await f.stream.emit(terminal);
    await f.completed;
    expect(f.session.activeJobId).toBe('replacement');
    expect(f.admission.reservationFor('job-1')).toBeNull();
    expect(f.registry.has('job-1')).toBe(false);
  });
});
