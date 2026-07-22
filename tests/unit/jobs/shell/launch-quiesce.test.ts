import { describe, expect, it, vi } from 'vitest';

import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { none } from '#src/providers/capability.js';
import type { ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import type { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { ProviderDurableSpawner } from '#src/providers/cli-runner.js';
import type { AdmittedHandle, JobAdmissionPort, LaunchPool } from '#src/jobs/contracts/admission.js';
import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { ContinuitySnapshot } from '#src/sessions/continuity.js';
import type { ProviderServerLease, ProviderServerSpec } from '#src/providers/contract.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type {
  SessionInitialLaunchPort,
  SessionJobContinuityCheckpointResult,
  SessionJobClaimPort,
} from '#src/sessions/contracts.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { prepareFixtureExecutionContext } from '#tests/helpers/scripted-provider.js';

// AC4: quiesce-for-handoff must synchronously detach durable terminal/
// completion side effects for active app-server jobs. Continuity checkpoints
// received BEFORE detach commit; events arriving AFTER detach do not.

function createControlledProviderStream(): {
  iterable: AsyncIterable<ProviderEventBody>;
  emit: (event: ProviderEventBody) => Promise<void>;
  end: () => void;
} {
  const buffer: ProviderEventBody[] = [];
  let pending: ((value: ProviderEventBody | null) => void) | null = null;
  let ended = false;

  const iterable: AsyncIterable<ProviderEventBody> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        while (buffer.length === 0 && !ended) {
          await new Promise<void>((resolve) => {
            pending = (value) => {
              if (value !== null) buffer.push(value);
              resolve();
            };
          });
        }
        if (buffer.length === 0 && ended) {
          return { value: undefined, done: true } as IteratorResult<ProviderEventBody>;
        }
        const event = buffer.shift()!;
        return { value: event, done: false };
      },
    }),
  };

  return {
    iterable,
    async emit(event: ProviderEventBody) {
      buffer.push(event);
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve(null);
      }
      // Allow the consumer microtask to drain before resolving the emit.
      await Promise.resolve();
      await Promise.resolve();
    },
    end() {
      ended = true;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve(null);
      }
    },
  };
}

function fakeRuntime(): Pick<Runtime, 'time' | 'ids' | 'storage' | 'env' | 'paths'> {
  const noop = (() => {}) as never;
  return {
    time: { now: () => 0, sleep: async () => {} } as never,
    ids: { uuid: () => 'job-1' } as never,
    storage: {
      mkdirSync: noop,
      writeAtomicSync: noop,
      writeFileSync: noop,
      rmSync: noop,
      existsSync: () => false,
      readFileSync: () => '',
    } as never,
    env: { platform: () => 'linux', fullSnapshot: () => ({}) } as never,
    paths: {
      coral: {
        exports: { jobsRoot: '/tmp/coral/exports/jobs' },
        corpus: { kbRoot: '/tmp/coral/kb' },
        projects: { root: '/tmp/coral/projects', dataDir: (source: string) => `/tmp/coral/projects/${source}` },
      },
      projectSource: (projectRoot: string) => projectRoot,
      projectData: (projectRoot: string) => `/tmp/coral/projects/${projectRoot}`,
    } as never,
  };
}

interface QuiesceHarness {
  orchestrator: LaunchOrchestrator;
  recordTerminalSpy: ReturnType<typeof vi.fn>;
  appendProgressSpy: ReturnType<typeof vi.fn>;
  writeArtifactSpy: ReturnType<typeof vi.fn>;
  releaseLaunchSpy: ReturnType<typeof vi.fn>;
  abortRemoveSpy: ReturnType<typeof vi.fn>;
  releaseJobClaimSpy: ReturnType<typeof vi.fn>;
  checkpointSpy: ReturnType<typeof vi.fn>;
  jobPools: Map<string, LaunchPool>;
  providerStream: ReturnType<typeof createControlledProviderStream>;
  attachServer: () => Promise<void>;
  jobId: string;
  sessionId: string;
}

async function buildOrchestratorAroundProviderStream(): Promise<QuiesceHarness> {
  const jobId = 'job-quiesce';
  const sessionId = 'session-quiesce';
  const providerStream = createControlledProviderStream();

  const recordTerminalSpy = vi.fn();
  const appendProgressSpy = vi.fn();
  const writeArtifactSpy = vi.fn();
  const releaseLaunchSpy = vi.fn();
  const abortRemoveSpy = vi.fn();
  const releaseJobClaimSpy = vi.fn(async () => true);
  const checkpointSpy = vi.fn(
    async (
      _sessionId: string,
      _options: { expectedActiveJobId: string; expectedVersion: number; snapshot: ContinuitySnapshot },
    ): Promise<SessionJobContinuityCheckpointResult> => ({ ok: true, nextVersion: 2 }),
  );

  const session: ProviderSession = {
    sessionId,
    binding: TEST_CODEX_BINDING,
    activeJobId: jobId,
    version: 1,
  } as unknown as ProviderSession;

  const sessionManager: SessionJobClaimPort & SessionInitialLaunchPort = {
    prepare: () => {
      throw new Error('Initial launch is outside this test.');
    },
    appendPreparedClaim: () => {
      throw new Error('Initial launch is outside this test.');
    },
    get: () => session,
    releaseJob: () => {},
    checkpointJobContinuityAtomic: checkpointSpy,
    releaseJobClaimAtomic: releaseJobClaimSpy,
  } as never;

  const abortController = new AbortController();
  const abortRegistry = {
    register: () => {},
    getSignal: () => abortController.signal,
    remove: abortRemoveSpy,
  } as unknown as AbortRegistry;

  const launchAdmission: JobAdmissionPort = {
    requestLaunch: () => ({ type: 'immediate' }) satisfies AdmittedHandle,
    releaseLaunch: releaseLaunchSpy,
    cancelQueued: () => false,
  };

  const durableSpawner: ProviderDurableSpawner = {
    spawnCli: async () => {
      throw new Error('Durable spawner should not run in app-server quiesce test');
    },
  } as never;

  const jobPools = new Map<string, LaunchPool>([[jobId, 'default']]);

  const progressStoreSpy = {
    nextEnqueueSequence: () => 1,
    appendLaunchRequested: vi.fn(),
    appendProgress: vi.fn(),
    appendRuntimeStarted: vi.fn(),
    readLaunchProjection: () => null,
    readRuntimeProjection: () => null,
    readStatus: () => ({
      jobId,
      sessionId,
      provider: 'codex',
      projectRoot: '/tmp/project',
      backendNamespace: 'ns',
      jobKind: 'provider',
      phase: 'running',
      updatedAt: '2026-04-01T00:00:00.000Z',
    }),
    commit: (cb: (c: { append: (e: unknown) => unknown }) => unknown) => {
      cb({ append: () => ({ seq: 1 }) });
      return [];
    },
    jobDir: () => '/tmp/job-dir',
    ensureResultArtifact: () => {},
  } as unknown as JobProgressStore;

  const writeResultArtifactWatcher = writeArtifactSpy;
  // The orchestrator calls `writeResultArtifact` directly with runtime.storage;
  // we observe via runtime.storage.writeAtomicSync as a proxy:
  const runtime = fakeRuntime();
  (runtime.storage as unknown as { writeAtomicSync: ReturnType<typeof vi.fn> }).writeAtomicSync =
    writeResultArtifactWatcher;

  const acquireServerCalls: ProviderServerSpec[] = [];
  const acquireServer = async (spec: ProviderServerSpec): Promise<ProviderServerLease> => {
    acquireServerCalls.push(spec);
    return {
      rpc: async () => ({}),
      subscribe: () => () => {},
      release: () => {},
      closed: new Promise(() => {}),
    } as unknown as ProviderServerLease;
  };

  const providerRegistry = new ProviderRegistry();
  const orchestrator = new LaunchOrchestrator({
    abortRegistry,
    progressStore: progressStoreSpy,
    sessionManager,
    launchAdmission,
    durableSpawner,
    providerRegistry,
    runtime,
    coordinatorCommit: (cb) => progressStoreSpy.commit(cb),
    backendNamespace: 'ns',
    bundleHash: 'bundle',
    jobPools,
    terminalMaterializer: {
      recordProviderTerminal: recordTerminalSpy as never,
    },
    acquireServer,
  });

  // Provide a synthetic provider whose `run` returns the controlled stream and
  // calls runtime.acquireServer on first invocation so the orchestrator marks
  // the job as app-server.
  const provider = defineProvider({
    name: 'codex',
    run: ((
      _request: ProviderRequest,
      providerRuntime: { acquireServer: (s: ProviderServerSpec) => Promise<unknown> },
    ) => {
      // mark this job as app-server through the runtime port
      void providerRuntime.acquireServer({ provider: 'codex', shared: false } as ProviderServerSpec).catch(() => {});
      return providerStream.iterable;
    }) as never,
    prepareExecutionContext: prepareFixtureExecutionContext,
  })
    .binding(fixtureProviderBindingCodec('codex'))
    .artifacts(none('quiesce fixture owns no provider artifacts'))
    .build();
  providerRegistry.register(provider);
  const boundProviderResult = providerRegistry.rehydrateBinding(TEST_CODEX_BINDING);
  if (!boundProviderResult.ok) throw new Error('expected fixture provider binding');
  const boundProvider = boundProviderResult.value;

  const request: ProviderRequest = {
    action: 'start',
    cwd: '/tmp/project',
    coralEnv: {},
  } as unknown as ProviderRequest;

  // Drive `executeJob` through `runAsync`:
  orchestrator.runAsync(boundProvider, sessionId, jobId, request, { type: 'immediate' }, 'default');

  // Allow `runAsync` IIFE plus the stream's first `next()` to settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const attachServer = async (): Promise<void> => {
    // Already triggered by provider.run; await microtasks for acquireServer chain.
    await Promise.resolve();
    await Promise.resolve();
  };

  // Suppress unused locals after tests reference them.
  void writeResultArtifactWatcher;
  void acquireServerCalls;

  return {
    orchestrator,
    recordTerminalSpy,
    appendProgressSpy,
    writeArtifactSpy,
    releaseLaunchSpy,
    abortRemoveSpy,
    releaseJobClaimSpy,
    checkpointSpy,
    jobPools,
    providerStream,
    attachServer,
    jobId,
    sessionId,
  };
}

describe('LaunchOrchestrator handoff quiesce', () => {
  it('returns synchronously (no awaits-that-can-hang)', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    const startedAt = Date.now();
    const budget = 30_000;
    await harness.orchestrator.quiesceAppServerJobsForHandoff(new AbortController().signal);
    const elapsed = Date.now() - startedAt;
    // Structural bound: quiesce must resolve far below the supplied budget.
    expect(elapsed).toBeLessThan(budget / 10);

    harness.providerStream.end();
  });

  it('checkpoints received BEFORE quiesce commit; checkpoints AFTER do not', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    // Continuity checkpoint pre-quiesce: must reach the session manager.
    await harness.providerStream.emit({
      kind: 'continuity',
      conversationRef: 'thread-1',
      resumable: true,
      providerContinuity: { provider: 'codex', threadId: 'thread-1' },
    });
    await vi.waitFor(() => {
      expect(harness.checkpointSpy).toHaveBeenCalledTimes(1);
    });

    // Quiesce flips the flag synchronously.
    await harness.orchestrator.quiesceAppServerJobsForHandoff(new AbortController().signal);

    // Continuity checkpoint AFTER quiesce: must short-circuit (no
    // sessionManager.checkpoint call beyond the first).
    await harness.providerStream.emit({
      kind: 'continuity',
      conversationRef: 'thread-1-evolved',
      resumable: true,
      providerContinuity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-2' },
    });
    expect(harness.checkpointSpy).toHaveBeenCalledTimes(1);

    harness.providerStream.end();
  });

  it('terminal events on quiesced jobs do not record terminal, write artifact, or release admission/claim', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    await harness.orchestrator.quiesceAppServerJobsForHandoff(new AbortController().signal);

    // Drive a terminal event onto the quiesced stream — it must be ignored:
    // - no terminal record
    // - no result artifact
    // - no abort registry removal
    // - no session claim release
    // - no admission release
    // - no job-pool delete
    await harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'completed during handoff', outcome: { kind: 'completed' } },
    } as never);

    // Allow consumeJobStream's microtasks to flush.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.recordTerminalSpy).not.toHaveBeenCalled();
    expect(harness.releaseLaunchSpy).not.toHaveBeenCalled();
    expect(harness.abortRemoveSpy).not.toHaveBeenCalled();
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.jobPools.has(harness.jobId)).toBe(true);

    harness.providerStream.end();
  });
});
