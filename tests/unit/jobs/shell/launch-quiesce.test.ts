import { describe, expect, it, vi } from 'vitest';

import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import { none } from '#src/providers/capability.js';
import type { ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import type { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { ProviderDurableSpawner } from '#src/providers/cli-runner.js';
import type { JobAdmissionPort, SettlementRefusalRecorder } from '#src/jobs/contracts/admission.js';
import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import type { ContinuitySnapshot } from '#src/sessions/continuity.js';
import type { AppServerSession } from '#src/providers/contract.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import type {
  SessionInitialLaunchPort,
  SessionJobContinuityCheckpointResult,
  SessionJobClaimPort,
} from '#src/sessions/contracts.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import {
  prepareFixtureAppServerExecutionPlan,
  prepareFixtureHost,
  type FixtureExecutionPlan,
} from '#tests/helpers/scripted-provider.js';
import type { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { backendLog } from '#src/infra/backend-log.js';

// AC4: quiesce-for-handoff must synchronously detach durable terminal/
// completion side effects for active app-server jobs. Continuity checkpoints
// received BEFORE detach commit; events arriving AFTER detach do not.

function createControlledProviderStream(): {
  iterable: AsyncIterable<ProviderEventBody>;
  emit: (event: ProviderEventBody) => Promise<void>;
  end: () => void;
  started: Promise<void>;
} {
  type BufferedEvent = { event: ProviderEventBody; processed(): void };
  const buffer: BufferedEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const started = createDeferred<void>();

  const iterable: AsyncIterable<ProviderEventBody> = {
    [Symbol.asyncIterator]: () => {
      let acknowledgePrevious = () => {};
      return {
        async next() {
          started.resolve();
          acknowledgePrevious();
          acknowledgePrevious = () => {};
          while (buffer.length === 0 && !ended) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (buffer.length === 0 && ended) {
            return { value: undefined, done: true } as IteratorResult<ProviderEventBody>;
          }
          const next = buffer.shift()!;
          acknowledgePrevious = next.processed;
          return { value: next.event, done: false };
        },
        async return() {
          acknowledgePrevious();
          acknowledgePrevious = () => {};
          return { value: undefined, done: true } as IteratorResult<ProviderEventBody>;
        },
      };
    },
  };

  return {
    iterable,
    async emit(event: ProviderEventBody) {
      let processed!: () => void;
      const processing = new Promise<void>((resolve) => {
        processed = resolve;
      });
      buffer.push({ event, processed });
      if (wake) {
        const resolve = wake;
        wake = null;
        resolve();
      }
      await processing;
    },
    end() {
      ended = true;
      if (wake) {
        const resolve = wake;
        wake = null;
        resolve();
      }
    },
    started: started.promise,
  };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  await expect(
    Promise.race([promise.then(() => 'settled' as const), Promise.resolve('pending' as const)]),
  ).resolves.toBe('pending');
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
    env: { get: () => undefined, platform: () => 'linux', fullSnapshot: () => ({}) } as never,
    paths: {
      coral: {
        exports: { jobsRoot: '/tmp/coral/exports/jobs' },
        corpus: { kbRoot: '/tmp/coral/kb' },
        projects: { root: '/tmp/coral/projects', dataDir: (access: string) => `/tmp/coral/projects/${access}` },
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
  hasAbortRegistration: () => boolean;
  hasResultArtifact: () => boolean;
  releaseJobClaimSpy: ReturnType<typeof vi.fn>;
  checkpointSpy: ReturnType<typeof vi.fn>;
  recordArtifactHandleSpy: ReturnType<typeof vi.fn>;
  providerRunSpy: ReturnType<typeof vi.fn>;
  hostCloseSpy: ReturnType<typeof vi.fn>;
  launchCoordinator: LaunchCoordinator;
  providerStream: ReturnType<typeof createControlledProviderStream>;
  attachServer: () => Promise<void>;
  readinessStarted: Promise<void>;
  hostAcquisitionStarted: Promise<void>;
  start: () => void;
  openedServerSpecs: unknown[];
  jobId: string;
  sessionId: string;
  currentSession: () => ProviderSession;
}

async function buildOrchestratorAroundProviderStream(
  checkpointGate?: Promise<void>,
  options: {
    startImmediately?: boolean;
    releaseJobClaimGate?: Promise<void>;
    releaseJobClaimError?: Error;
    releaseJobClaimResult?: boolean;
    readinessGate?: Promise<void>;
    readinessError?: Error;
    hostAcquisitionGate?: Promise<void>;
    artifactGate?: Promise<void>;
    checkpointFailure?: 'stale' | 'throw';
    settlementRefusalRecorder?: SettlementRefusalRecorder;
  } = {},
): Promise<QuiesceHarness> {
  const jobId = 'job-quiesce';
  const sessionId = 'session-quiesce';
  const providerStream = createControlledProviderStream();

  const recordTerminalSpy = vi.fn();
  const appendProgressSpy = vi.fn();
  const writeArtifactSpy = vi.fn();
  const activeAbortJobs = new Set([jobId]);
  const abortRemoveSpy = vi.fn((removedJobId: string) => activeAbortJobs.delete(removedJobId));
  const ensuredResultArtifacts = new Set<string>();
  const releaseJobClaimSpy = vi.fn(async () => {
    await options.releaseJobClaimGate;
    if (options.releaseJobClaimError !== undefined) throw options.releaseJobClaimError;
    return options.releaseJobClaimResult ?? true;
  });
  let session!: ProviderSession;
  const checkpointSpy = vi.fn(
    async (
      _sessionId: string,
      _options: { expectedActiveJobId: string; expectedVersion: number; snapshot: ContinuitySnapshot },
    ): Promise<SessionJobContinuityCheckpointResult> => {
      await checkpointGate;
      if (options.checkpointFailure === 'throw') throw new Error('checkpoint persistence failed');
      if (options.checkpointFailure === 'stale') return { ok: false };
      session = { ...session, version: session.version + 1 };
      return { ok: true, nextVersion: session.version };
    },
  );
  const recordArtifactHandleSpy = vi.fn(async () => {
    await options.artifactGate;
    session = { ...session, version: session.version + 1 };
    return { ok: true as const, nextVersion: session.version };
  });

  session = {
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
    recordArtifactHandleAtomic: recordArtifactHandleSpy,
    releaseJobClaimAtomic: releaseJobClaimSpy,
  } as never;

  const abortController = new AbortController();
  const abortRegistry = {
    register: () => {},
    getSignal: (registeredJobId: string) => (activeAbortJobs.has(registeredJobId) ? abortController.signal : null),
    remove: abortRemoveSpy,
  } as unknown as AbortRegistry;

  const durableSpawner: ProviderDurableSpawner = {
    spawnCli: async () => {
      throw new Error('Durable spawner should not run in app-server quiesce test');
    },
  } as never;

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
    ensureResultArtifact: (artifactJobId: string) => {
      ensuredResultArtifacts.add(artifactJobId);
    },
  } as unknown as JobProgressStore;

  const writeResultArtifactWatcher = writeArtifactSpy;
  const runtime = fakeRuntime();
  const launchCoordinator = new LaunchCoordinator({ runtime: runtime as Runtime });
  const launchAdmission: JobAdmissionPort = launchCoordinator;
  const releaseLaunchSpy = vi.spyOn(launchCoordinator, 'releaseLaunch');
  const admission = launchAdmission.requestLaunch(
    jobId,
    'codex',
    { kind: 'provider-session', id: sessionId },
    'default',
  );
  if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected launch permit');
  expect(admission.permit.reservationId).not.toBe('');
  (runtime.storage as unknown as { writeAtomicSync: ReturnType<typeof vi.fn> }).writeAtomicSync =
    writeResultArtifactWatcher;

  type AppServerSpec = Parameters<DefaultProviderHostManager['openSession']>[0];
  const openedServerSpecs: AppServerSpec[] = [];
  const hostOpened = createDeferred<void>();
  const hostAcquisitionStarted = createDeferred<void>();
  const hostCloseSpy = vi.fn();
  const openServer = async (spec: AppServerSpec): Promise<AppServerSession> => {
    openedServerSpecs.push(spec);
    hostOpened.resolve();
    return {
      rpc: async () => ({}),
      subscribe: () => () => {},
      closed: new Promise(() => {}),
    } as unknown as AppServerSession;
  };

  const providerRegistry = new ProviderRegistry();
  const appServerHost = {
    openSession: async (spec: Parameters<typeof openServer>[0]) => {
      const session = await openServer(spec);
      hostAcquisitionStarted.resolve();
      await options.hostAcquisitionGate;
      return {
        session,
        hostRef: {
          provider: 'codex',
          fingerprint: '0'.repeat(64),
          instanceId: 'instance-1',
          leaseMode: 'shared' as const,
        },
        close: hostCloseSpy,
      };
    },
    attachSession: async () => null,
  };
  providerRegistry.connectAppServerHost(appServerHost);
  const orchestrator = new LaunchOrchestrator({
    abortRegistry,
    progressStore: progressStoreSpy,
    sessionManager,
    launchAdmission,
    providerOperationBinding: launchCoordinator,
    durableSpawner,
    providerRegistry,
    runtime,
    coordinatorCommit: (cb) => progressStoreSpy.commit(cb),
    backendNamespace: 'ns',
    bundleHash: 'bundle',
    settlementRefusalRecorder: options.settlementRefusalRecorder ?? { record: () => true },
    terminalMaterializer: {
      recordProviderTerminal: recordTerminalSpy as never,
    },
  });

  // Provider acquisition is owned by the bound app-server capability.
  const providerRunSpy = vi.fn(() => providerStream.iterable);
  const provider = defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
    name: 'codex',
    transport: 'app-server',
    run: providerRunSpy as never,
    prepareExecutionPlan: prepareFixtureAppServerExecutionPlan,
    appServer: {
      name: 'codex',
      planHost: (input) => {
        if (input.purpose !== 'execution') throw new Error('Codex fixture has no curation host.');
        return prepareFixtureHost(input, {
          provider: 'codex',
          command: 'codex',
          args: [],
          cwd: input.request.cwd,
          env: {},
          leaseMode: 'job-exclusive',
        });
      },
      compileStableHost: (host) => host.serverSpec,
    },
    recovery: {
      finalizeInterrupted: () => ({ kind: 'preserve' }),
      finalizeFromArtifacts: async () => ({ terminal: {} as never }),
    },
  })
    .binding(fixtureProviderBindingCodec('codex'))
    .artifacts(none('quiesce fixture owns no provider artifacts'))
    .build();
  providerRegistry.register(provider);
  const boundProviderResult = providerRegistry.rehydrateBinding(TEST_CODEX_BINDING);
  if (!boundProviderResult.ok) throw new Error('expected fixture provider binding');
  const boundProvider = boundProviderResult.value;
  const readinessStarted = createDeferred<void>();
  const launchProvider: BoundProvider =
    options.readinessGate === undefined
      ? boundProvider
      : Object.freeze({
          name: boundProvider.name,
          envelope: boundProvider.envelope,
          present: boundProvider.present,
          readiness: async (...args: Parameters<BoundProvider['readiness']>) => {
            readinessStarted.resolve();
            await options.readinessGate;
            if (options.readinessError !== undefined) throw options.readinessError;
            return boundProvider.readiness(...args);
          },
          compareIdentity: boundProvider.compareIdentity,
          decodeContinuity: boundProvider.decodeContinuity,
          preflight: boundProvider.preflight,
          prepareExecution: boundProvider.prepareExecution,
          appServer: boundProvider.appServer,
          recovery: boundProvider.recovery,
          artifacts: boundProvider.artifacts,
          curation: boundProvider.curation,
        });

  const request: ProviderRequest = {
    action: 'start',
    cwd: '/tmp/project',
    coralEnv: {},
  } as unknown as ProviderRequest;

  const start = (): void => {
    orchestrator.runAsync(launchProvider, sessionId, jobId, request, admission, 'default');
  };
  if (options.startImmediately !== false) {
    start();
  }

  const attachServer = async (): Promise<void> => {
    await hostOpened.promise;
    await providerStream.started;
  };

  void writeResultArtifactWatcher;
  void openedServerSpecs;

  return {
    orchestrator,
    recordTerminalSpy,
    appendProgressSpy,
    writeArtifactSpy,
    releaseLaunchSpy,
    abortRemoveSpy,
    hasAbortRegistration: () => activeAbortJobs.has(jobId),
    hasResultArtifact: () => ensuredResultArtifacts.has(jobId),
    releaseJobClaimSpy,
    checkpointSpy,
    recordArtifactHandleSpy,
    providerRunSpy,
    hostCloseSpy,
    launchCoordinator,
    providerStream,
    attachServer,
    readinessStarted: readinessStarted.promise,
    hostAcquisitionStarted: hostAcquisitionStarted.promise,
    start,
    openedServerSpecs,
    jobId,
    sessionId,
    currentSession: () => session,
  };
}

describe('LaunchOrchestrator handoff quiesce', () => {
  it('keeps jobs prepared after the global fence from entering app-server acquisition', async () => {
    const harness = await buildOrchestratorAroundProviderStream(undefined, { startImmediately: false });

    await harness.orchestrator.quiesceAppServerJobsForHandoff();
    harness.start();

    expect(harness.openedServerSpecs).toEqual([]);
    expect(harness.releaseLaunchSpy).not.toHaveBeenCalled();
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.abortRemoveSpy).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).toMatchObject({ pool: 'default' });
  });

  it('preserves an app-server job when successful readiness settles after the handoff fence', async () => {
    const readiness = createDeferred<void>();
    const harness = await buildOrchestratorAroundProviderStream(undefined, {
      readinessGate: readiness.promise,
    });
    await harness.readinessStarted;

    await harness.orchestrator.quiesceAppServerJobsForHandoff();
    readiness.resolve();

    const tracking = harness.orchestrator as unknown as { appServerJobs: Set<string> };
    await vi.waitFor(() => expect(tracking.appServerJobs.has(harness.jobId)).toBe(false));
    expect(harness.openedServerSpecs).toEqual([]);
    expect(harness.recordTerminalSpy).not.toHaveBeenCalled();
    expect(harness.releaseLaunchSpy).not.toHaveBeenCalled();
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.abortRemoveSpy).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).toMatchObject({ pool: 'default' });
  });

  it('closes a host acquired after the handoff fence without starting the provider operation', async () => {
    const hostAcquisition = createDeferred<void>();
    const harness = await buildOrchestratorAroundProviderStream(undefined, {
      hostAcquisitionGate: hostAcquisition.promise,
    });
    await harness.hostAcquisitionStarted;

    await harness.orchestrator.quiesceAppServerJobsForHandoff();
    hostAcquisition.resolve();

    const tracking = harness.orchestrator as unknown as { appServerJobs: Set<string> };
    await vi.waitFor(() => expect(tracking.appServerJobs.has(harness.jobId)).toBe(false));
    expect(harness.providerRunSpy).not.toHaveBeenCalled();
    expect(harness.hostCloseSpy).toHaveBeenCalledTimes(1);
    expect(harness.recordTerminalSpy).not.toHaveBeenCalled();
    expect(harness.releaseLaunchSpy).not.toHaveBeenCalled();
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
  });

  it('settles without waiting for an active provider stream', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    await harness.orchestrator.quiesceAppServerJobsForHandoff();
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.releaseLaunchSpy).not.toHaveBeenCalled();

    harness.providerStream.end();
  });

  it('checkpoints received BEFORE quiesce commit; checkpoints AFTER do not', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

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
    await harness.orchestrator.quiesceAppServerJobsForHandoff();

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

  it('waits for an in-flight checkpoint and rejects its post-write receipt at the handoff fence', async () => {
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const harness = await buildOrchestratorAroundProviderStream(checkpointGate);
    await harness.attachServer();
    const commit = vi.fn();
    const reject = vi.fn();
    const emitted = harness.providerStream.emit(
      attachContinuityCommit(
        {
          kind: 'continuity',
          conversationRef: 'thread-in-flight',
          resumable: true,
          providerContinuity: { provider: 'codex', threadId: 'thread-in-flight' },
        },
        { commit, reject },
      ),
    );
    await vi.waitFor(() => expect(harness.checkpointSpy).toHaveBeenCalledTimes(1));

    let quiesced = false;
    const quiesce = harness.orchestrator.quiesceAppServerJobsForHandoff().then(() => {
      quiesced = true;
    });
    await expectPending(quiesce);
    expect(quiesced).toBe(false);

    releaseCheckpoint();
    await quiesce;
    await emitted;
    expect(quiesced).toBe(true);
    await vi.waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    expect(commit).not.toHaveBeenCalled();
    harness.providerStream.end();
  });

  it('waits for an in-flight artifact CAS before completing the handoff fence', async () => {
    const artifactGate = createDeferred<void>();
    const harness = await buildOrchestratorAroundProviderStream(undefined, { artifactGate: artifactGate.promise });
    await harness.attachServer();

    const emitted = harness.providerStream.emit({
      kind: 'artifact_handle',
      handle: '/tmp/codex-thread.jsonl',
      identity: { kind: 'test-artifact', threadId: 'thread-in-flight' },
    });
    await vi.waitFor(() => expect(harness.recordArtifactHandleSpy).toHaveBeenCalledTimes(1));

    const quiesce = harness.orchestrator.quiesceAppServerJobsForHandoff();
    await expectPending(quiesce);
    artifactGate.resolve();
    await expect(quiesce).resolves.toBeUndefined();
    await emitted;
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.releaseLaunchSpy).not.toHaveBeenCalled();
    harness.providerStream.end();
  });

  it('terminal events on quiesced jobs do not record terminal, write artifact, or release admission/claim', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    await harness.orchestrator.quiesceAppServerJobsForHandoff();

    await harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'completed during handoff', outcome: { kind: 'completed' } },
    } as never);

    expect(harness.recordTerminalSpy).not.toHaveBeenCalled();
    expect(harness.hasResultArtifact()).toBe(false);
    expect(harness.releaseLaunchSpy).not.toHaveBeenCalled();
    expect(harness.abortRemoveSpy).not.toHaveBeenCalled();
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).not.toBeNull();

    harness.providerStream.end();
  });

  it('releases admission but preserves durable ownership when exact-turn interruption is unconfirmed', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    await harness.providerStream.emit({ kind: 'suspended', reason: 'interrupt_unconfirmed' });
    const tracking = harness.orchestrator as unknown as { appServerJobs: Set<string> };
    await vi.waitFor(() => expect(tracking.appServerJobs.has(harness.jobId)).toBe(false));

    expect(harness.recordTerminalSpy).not.toHaveBeenCalled();
    expect(harness.abortRemoveSpy).not.toHaveBeenCalled();
    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).toBeNull();
    expect(harness.currentSession().activeJobId).toBe(harness.jobId);
  });

  it.each(['stale', 'throw'] as const)(
    'releases admission but preserves durable ownership when a live provider checkpoint is %s',
    async (checkpointFailure) => {
      const harness = await buildOrchestratorAroundProviderStream(undefined, { checkpointFailure });
      await harness.attachServer();

      await harness.providerStream.emit({
        kind: 'continuity',
        conversationRef: 'thread-uncommitted',
        resumable: true,
        providerContinuity: { provider: 'codex', threadId: 'thread-uncommitted', turnId: 'turn-live' },
      });
      const tracking = harness.orchestrator as unknown as { appServerJobs: Set<string> };
      await vi.waitFor(() => expect(tracking.appServerJobs.has(harness.jobId)).toBe(false));

      expect(harness.recordTerminalSpy).not.toHaveBeenCalled();
      expect(harness.abortRemoveSpy).not.toHaveBeenCalled();
      expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
      expect(harness.launchCoordinator.reservationFor(harness.jobId)).toBeNull();
      expect(harness.currentSession().activeJobId).toBe(harness.jobId);
    },
  );

  it('waits for an in-flight terminal claim release before completing the handoff fence', async () => {
    let releaseClaim!: () => void;
    const releaseJobClaimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const harness = await buildOrchestratorAroundProviderStream(undefined, { releaseJobClaimGate });
    await harness.attachServer();

    const emitted = harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'completed before handoff', outcome: { kind: 'completed' } },
    } as never);
    await vi.waitFor(() => expect(harness.releaseJobClaimSpy).toHaveBeenCalledTimes(1));

    let quiesced = false;
    const quiesce = harness.orchestrator.quiesceAppServerJobsForHandoff().then(() => {
      quiesced = true;
    });
    await expectPending(quiesce);
    expect(quiesced).toBe(false);

    releaseClaim();
    await quiesce;
    await emitted;
    expect(quiesced).toBe(true);
    harness.providerStream.end();
  });

  it('admits terminal persistence and claim release into the same handoff fence turn', async () => {
    const releaseClaim = createDeferred<void>();
    const quiesceStarted = createDeferred<void>();
    const harness = await buildOrchestratorAroundProviderStream(undefined, {
      releaseJobClaimGate: releaseClaim.promise,
    });
    await harness.attachServer();
    let quiesce!: Promise<void>;
    harness.recordTerminalSpy.mockImplementationOnce(() => {
      quiesce = harness.orchestrator.quiesceAppServerJobsForHandoff();
      quiesceStarted.resolve();
    });

    const emitted = harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'completed at fence', outcome: { kind: 'completed' } },
    } as never);
    await quiesceStarted.promise;
    await expectPending(quiesce);
    expect(harness.releaseJobClaimSpy).toHaveBeenCalledTimes(1);

    releaseClaim.resolve();
    await expect(quiesce).resolves.toBeUndefined();
    await emitted;
  });

  it('settles the handoff fence when an in-flight terminal claim release rejects', async () => {
    const releaseClaim = createDeferred<void>();
    const harness = await buildOrchestratorAroundProviderStream(undefined, {
      releaseJobClaimGate: releaseClaim.promise,
      releaseJobClaimError: new Error('claim release failed'),
    });
    await harness.attachServer();

    const emitted = harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'completed before failed release', outcome: { kind: 'completed' } },
    } as never);
    await vi.waitFor(() => expect(harness.releaseJobClaimSpy).toHaveBeenCalledTimes(1));

    const quiesce = harness.orchestrator.quiesceAppServerJobsForHandoff();
    await expectPending(quiesce);

    releaseClaim.resolve();
    await expect(quiesce).resolves.toBeUndefined();
    await emitted;
    expect(harness.releaseJobClaimSpy).toHaveBeenCalledTimes(1);
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).toBeNull();
    expect(harness.currentSession().activeJobId).toBe(harness.jobId);
    expect(harness.hasResultArtifact()).toBe(true);
    expect(harness.hasAbortRegistration()).toBe(false);
    harness.providerStream.end();
  });

  it('releases admission but preserves the session claim when terminal persistence fails', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();
    harness.recordTerminalSpy.mockImplementationOnce(() => {
      throw new Error('terminal persistence failed');
    });

    await harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'not durably terminal', outcome: { kind: 'completed' } },
    } as never);
    const tracking = harness.orchestrator as unknown as { appServerJobs: Set<string> };
    await vi.waitFor(() => expect(tracking.appServerJobs.has(harness.jobId)).toBe(false));

    expect(harness.releaseJobClaimSpy).not.toHaveBeenCalled();
    expect(harness.abortRemoveSpy).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).toBeNull();
    expect(harness.currentSession().activeJobId).toBe(harness.jobId);
  });

  it('releases admission and reports recording-failed when terminal and quarantine writes both fail', async () => {
    const loggedErrors: string[] = [];
    const error = vi.spyOn(backendLog, 'error').mockImplementation((message) => {
      loggedErrors.push(String(message));
    });
    const harness = await buildOrchestratorAroundProviderStream(undefined, {
      settlementRefusalRecorder: { record: () => false },
    });
    await harness.attachServer();
    harness.recordTerminalSpy.mockImplementationOnce(() => {
      throw new Error('terminal persistence failed');
    });

    await harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'not durably terminal', outcome: { kind: 'completed' } },
    } as never);
    const tracking = harness.orchestrator as unknown as { appServerJobs: Set<string> };
    await vi.waitFor(() => expect(tracking.appServerJobs.has(harness.jobId)).toBe(false));

    expect(loggedErrors.some((message) => message.includes('Failed to record settlement refusal'))).toBe(true);
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).toBeNull();
    expect(harness.currentSession().activeJobId).toBe(harness.jobId);
    error.mockRestore();
  });

  it('releases admission when the exact-version terminal claim release is stale', async () => {
    const recordedRefusals: unknown[] = [];
    const harness = await buildOrchestratorAroundProviderStream(undefined, {
      releaseJobClaimResult: false,
      settlementRefusalRecorder: {
        record: (refusal) => {
          recordedRefusals.push(refusal);
          return true;
        },
      },
    });
    await harness.attachServer();

    await harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'terminal with stale claim', outcome: { kind: 'completed' } },
    } as never);
    const tracking = harness.orchestrator as unknown as { appServerJobs: Set<string> };
    await vi.waitFor(() => expect(tracking.appServerJobs.has(harness.jobId)).toBe(false));

    expect(harness.releaseJobClaimSpy).toHaveBeenCalledWith(harness.sessionId, {
      expectedActiveJobId: harness.jobId,
      expectedVersion: 1,
    });
    expect(harness.hasResultArtifact()).toBe(true);
    expect(harness.hasAbortRegistration()).toBe(false);
    expect(harness.launchCoordinator.reservationFor(harness.jobId)).toBeNull();
    expect(harness.currentSession().activeJobId).toBe(harness.jobId);
    expect(recordedRefusals).toEqual([
      {
        jobId: harness.jobId,
        cause: 'claim-already-reassigned',
        failure: `The session claim for terminal job ${harness.jobId} is owned by another job.`,
      },
    ]);
  });

  it('releases a terminal claim at the version returned by the last continuity CAS', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    await harness.providerStream.emit({
      kind: 'continuity',
      conversationRef: 'thread-versioned',
      resumable: true,
      providerContinuity: { provider: 'codex', threadId: 'thread-versioned' },
    });
    await harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'versioned terminal', outcome: { kind: 'completed' } },
    } as never);

    await vi.waitFor(() => expect(harness.releaseJobClaimSpy).toHaveBeenCalledTimes(1));
    expect(harness.releaseJobClaimSpy).toHaveBeenCalledWith(harness.sessionId, {
      expectedActiveJobId: harness.jobId,
      expectedVersion: 2,
    });
  });

  it('removes ordinary completed jobs from app-server lifecycle tracking', async () => {
    const harness = await buildOrchestratorAroundProviderStream();
    await harness.attachServer();

    await harness.providerStream.emit({
      kind: 'terminal',
      terminal: { content: 'completed normally', outcome: { kind: 'completed' } },
    } as never);
    await vi.waitFor(() => expect(harness.releaseJobClaimSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.releaseLaunchSpy).toHaveBeenCalledTimes(1));

    const tracking = harness.orchestrator as unknown as {
      appServerJobs: Set<string>;
      quiescedAppServerJobs: Set<string>;
      inFlightAppServerWrites: Map<string, Set<Promise<unknown>>>;
      appServerHandoffAborts: Map<string, AbortController>;
    };
    expect(tracking.appServerJobs.size).toBe(0);
    expect(tracking.quiescedAppServerJobs.size).toBe(0);
    expect(tracking.inFlightAppServerWrites.size).toBe(0);
    expect(tracking.appServerHandoffAborts.size).toBe(0);
    harness.providerStream.end();
  });
});
