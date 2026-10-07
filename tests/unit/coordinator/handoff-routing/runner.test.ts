import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeHandoffRunResult,
  type routeAuthenticatedHealth,
  runHandoff as runHandoffResult,
  type HandoffContinuationResult,
  type HandoffOperation,
  type HandoffRunResult,
  type RunHandoffOptions,
} from '#src/coordinator/handoff-routing/runner.js';
import { WaitBuildMismatchError } from '#src/coordinator/handoff-routing/wait-invocation.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type { ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type * as HandoffRoutingStatusMod from '#src/coordinator/handoff-routing/status.js';
import { handoffRoutingStatusStoreSchema } from '#src/coordinator/handoff-routing/status.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import type { TimePort } from '#src/infra/port-types.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import type * as RealRuntimeMod from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

type StrictBundleManifest = BundleManifestMod.StrictBundleManifest;
type LiveIncumbentHealth = Parameters<typeof routeAuthenticatedHealth>[0];
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());

const mockState = vi.hoisted(() => ({
  target: {},
  inspectTarget: vi.fn(),
  executionTarget: vi.fn(),
  createIpcClient: vi.fn(),
  createRealRuntime: vi.fn<typeof RealRuntimeMod.createRealRuntime>(),
  health: vi.fn(),
  probeCoordinator: vi.fn(),
  readBuildFlavor: vi.fn(),
  resolveStrictBundleIdentity: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  publishGenerationCoordinatedHandoffRoutingTransitions: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, spawn: mockState.spawn, execFile: mockState.execFile };
});

vi.mock('#src/infra/plugin-identity.js', () => ({ pluginRootNamespace: () => 'handoff-runner' }));

vi.mock('#src/infra/handoff-target.js', () => ({
  createForeignTargetValidator: () => () => ({ kind: 'validated', target: mockState.target }),
  inspectValidatedHandoffTarget: mockState.inspectTarget,
  withValidatedHandoffTarget: mockState.executionTarget,
}));

vi.mock('#src/infra/backend-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendDiscoveryMod>();
  return { ...actual, probeCoordinator: mockState.probeCoordinator };
});

vi.mock('#src/infra/bundle-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BundleManifestMod>();
  return {
    ...actual,
    readBuildFlavor: mockState.readBuildFlavor,
    resolveStrictBundleIdentity: mockState.resolveStrictBundleIdentity,
  };
});

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: mockState.createRealRuntime,
}));

vi.mock('#src/coordinator/handoff-routing/status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRoutingStatusMod>();
  return {
    ...actual,
    publishGenerationCoordinatedHandoffRoutingTransitions:
      mockState.publishGenerationCoordinatedHandoffRoutingTransitions,
  };
});

vi.mock('#src/transport/ipc/client.js', () => ({
  createIpcClient: mockState.createIpcClient,
}));

const GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';
const SPAWNED_CHILD_PID = 4242;
const originalGuard = process.env[GUARD_ENV];
const bundleDir = '/handoff/target/bridge';
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '223e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};
const invokingManifest: StrictBundleManifest = {
  ...manifest,
  version: '1.0.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
};
const socketPath = join(tmpdir(), 'coral-handoff-runner.sock');
const runtimeUuid = vi.fn(() => '123e4567-e89b-42d3-a456-426614174000');
const readProcessIncarnation = vi.fn<(pid: number, platform: NodeJS.Platform) => ProcessIncarnation | null>(() =>
  testIncarnation('handoff-runner'),
);
let runtime: Runtime;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createHandoffRuntime(): Promise<Runtime> {
  const { createRealRuntime } = await vi.importActual<typeof RealRuntimeMod>('#src/runtime/real.js');
  const actual = createRealRuntime('prod');
  const time = new VirtualTime(1_700_000_000_000);
  return {
    ...actual,
    ids: { ...actual.ids, uuid: runtimeUuid },
    process: { ...actual.process, readProcessIncarnation },
    storage: { ...actual.storage, existsSync: () => true, readFileSync: () => '--print-wait-invocation-contract' },
    time,
    env: {
      ...actual.env,
      pid: () => 101,
      platform: () => 'linux',
      cwd: () => '/handoff/cwd',
      fullSnapshot: () => ({ CORAL_BASE_ENV: 'preserved' }),
    },
    paths: {
      ...actual.paths,
      coral: {
        ...actual.paths.coral,
        coordinator: {
          ...actual.paths.coral.coordinator,
          runDir: '/handoff/run',
          socketPath,
        },
      },
    },
  };
}

function observedContinuation(result: HandoffRunResult<HandoffContinuationResult>): HandoffContinuationResult {
  return consumeHandoffRunResult(result, () => undefined);
}

async function runHandoff(
  operation: HandoffOperation,
  options?: RunHandoffOptions,
): Promise<HandoffContinuationResult> {
  const result =
    operation.kind === 'backend-startup'
      ? await runHandoffResult(operation, options)
      : await runHandoffResult(operation, options);
  return observedContinuation(result);
}

function liveHealth(bundleDir?: string, namespace = 'handoff-runner'): LiveIncumbentHealth {
  return {
    status: 'ok',
    version: manifest.version,
    bundleHash: manifest.bundleHash,
    flavor: manifest.flavor,
    namespace,
    instanceId: 'incumbent-1',
    pid: 4242,
    ...(bundleDir === undefined ? {} : { manifest, bundleDir }),
  };
}

function configureNewerIncumbent(): void {
  const namespace = pluginRootNamespace(dirname(bundleDir));
  mockState.probeCoordinator.mockReturnValue({
    kind: 'live',
    record: {
      socketPath,
      pid: 4242,
      bundleHash: manifest.bundleHash,
      flavor: manifest.flavor,
      namespace,
      bootToken: 'boot-token',
    },
  });
  mockState.health.mockResolvedValue(liveHealth(bundleDir, namespace));
}

function cliOperation(...args: string[]): Extract<HandoffOperation, { kind: 'cli-invocation' }> {
  return { kind: 'cli-invocation', argv: ['node', 'coral-cli', ...args] };
}

function childThatExits(code: number | null, signal: NodeJS.Signals | null): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: SPAWNED_CHILD_PID }) as unknown as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => {
    child.emit('spawn');
    queueMicrotask(() => {
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    });
  });
  return child;
}

function childThatStaysAlive(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: SPAWNED_CHILD_PID }) as unknown as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

beforeAll(async () => {
  runtime = await createHandoffRuntime();
});

beforeEach(() => {
  delete process.env[GUARD_ENV];
  mockState.createIpcClient.mockReset().mockReturnValue({ health: mockState.health });
  mockState.createRealRuntime.mockReset().mockReturnValue(runtime);
  mockState.health.mockReset();
  mockState.probeCoordinator.mockReset();
  mockState.readBuildFlavor.mockReset().mockReturnValue('prod');
  mockState.resolveStrictBundleIdentity.mockReset().mockReturnValue({ ok: true, manifest: invokingManifest });
  mockState.spawn.mockReset();
  mockState.execFile.mockReset();
  mockState.publishGenerationCoordinatedHandoffRoutingTransitions
    .mockReset()
    .mockResolvedValue({ kind: 'committed', sequence: 1 });
  readProcessIncarnation.mockReset().mockReturnValue(testIncarnation('handoff-runner'));
  runtimeUuid.mockReset();
  mockState.inspectTarget.mockReturnValue({ build: manifest });
  mockState.executionTarget.mockReturnValue({ bundleDir, manifest, assertExecutable: vi.fn() });
  configureNewerIncumbent();
  vi.spyOn(process.stdout, 'write').mockImplementation(((
    _chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ) => {
    callback?.();
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  if (originalGuard === undefined) {
    delete process.env[GUARD_ENV];
  } else {
    process.env[GUARD_ENV] = originalGuard;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('handoff-routing/runner', () => {
  it.each(['timeout', 'abort'] as const)(
    'terminates a hung wait capability probe gracefully on %s and never escalates unknown life',
    async (trigger) => {
      for (const liveness of ['alive', 'unknown'] as const) {
        vi.useFakeTimers();
        vi.spyOn(runtime.time, 'setTimeout').mockImplementation((callback, delay) => setTimeout(callback, delay));
        vi.spyOn(runtime.time, 'clearTimeout').mockImplementation((handle) => clearTimeout(handle as NodeJS.Timeout));
        const observe = vi.spyOn(runtime.process, 'observeLiveness').mockReturnValue(liveness);
        const controller = new AbortController();
        const child = childThatStaysAlive();
        child.kill = vi.fn((signal) => {
          if (signal === 'SIGKILL') child.emit('close', null, signal);
          return true;
        });
        const started = deferred();
        mockState.execFile.mockImplementation(() => {
          started.resolve();
          return child;
        });
        const result = runHandoff(cliOperation('wait', 'jobs', 'a'), {
          pluginRoot: '/plugin/root',
          waitInvocation: {
            mode: 'bounded',
            signal: controller.signal,
            originalCommand: 'coral-cli wait jobs a',
            remainingMs: () => 10000,
            cleanupRemainingMs: () => 1000,
            saveContinuation: vi.fn(),
          },
        });
        void result.catch(() => undefined);
        await started.promise;
        if (trigger === 'abort') controller.abort();
        else await vi.advanceTimersByTimeAsync(10000);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
        await vi.advanceTimersByTimeAsync(749);
        expect(child.kill).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(observe).toHaveBeenCalledWith(SPAWNED_CHILD_PID);
        expect(vi.mocked(child.kill).mock.calls.map(([signal]) => signal)).toEqual(
          liveness === 'alive' ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM'],
        );
        await expect(result).rejects.toThrow('could not be observed within the invocation budget');
        expect(mockState.spawn).not.toHaveBeenCalled();
        observe.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('should commit selection before execution and finalize with its committed sequence', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions
      .mockResolvedValueOnce({ kind: 'committed', sequence: 41 })
      .mockResolvedValueOnce({ kind: 'committed', sequence: 42 });

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'recorded',
      continuation: {
        kind: 'run-current',
        reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
      },
      publicationIncidents: [],
    });

    const selection = mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[0]?.[2][0];
    const terminal = mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0];
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[0]?.[1]).toBe(
      `/handoff/run/handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
    );
    expect(selection).toMatchObject({
      kind: 'routing-selected',
      owner: { pid: 101, incarnation: testIncarnation('handoff-runner') },
      disposition: { kind: 'continue-current', basis: { kind: 'incumbent-absent' } },
    });
    expect(terminal).toMatchObject({
      kind: 'continuation-finalized',
      invocationId: selection.invocationId,
      selection: { kind: 'with-selection-sequence', selectionSequence: 41 },
      disposition: {
        kind: 'continued-current',
        reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
      },
    });
  });

  it('should retain selection uncertainty together with terminal refusal', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mockResolvedValueOnce({
      kind: 'commit-outcome-unknown',
      cause: 'io-failed',
      errcode: 5,
    });

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'recording-incidents',
      publicationIncidents: [
        { phase: 'selection', kind: 'commit-outcome-unknown', cause: 'io-failed', errcode: 5 },
        {
          phase: 'terminal',
          kind: 'refused',
          refusal: { reason: 'selection-publication-outcome-unknown', attemptedPhase: 'terminal' },
        },
      ],
    });
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).toHaveBeenCalledOnce();
  });

  it('refuses a pre-terminal ok as proof of startup once the coordinator is gone', async () => {
    const namespace = pluginRootNamespace(dirname(bundleDir));
    const healthStarted = deferred();
    const target = mockState.target as ValidatedHandoffTarget;
    let answerFirstProbe!: (health: LiveIncumbentHealth) => void;
    mockState.health.mockImplementationOnce(
      () =>
        new Promise<LiveIncumbentHealth>((resolve) => {
          answerFirstProbe = resolve;
          healthStarted.resolve();
        }),
    );
    let child!: ChildProcess;
    mockState.spawn.mockImplementation(() => {
      child = childThatStaysAlive();
      return child;
    });

    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target },
    );
    void result.catch(() => undefined);
    await healthStarted.promise;
    expect(mockState.health).toHaveBeenCalledOnce();

    // The coordinator dies while that first probe is still in flight, so the reply it eventually gives
    // describes a coordinator that no longer exists.
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    child.emit('exit', 7, null);
    answerFirstProbe(liveHealth(bundleDir, namespace));

    await expect(result).resolves.toMatchObject({
      kind: 'delegated-startup',
      observation: { kind: 'not-serving', childEnding: { code: 7, signal: null } },
    });
  });

  // The behaviour `5ad55ded` exists to produce, and the one nothing asserted: an unobservable pid is not an
  // absent one. Flipping the guard back to `probe.kind !== 'live'` reintroduces the false absence and left the
  // whole suite green before this test — established by mutation, not assumed.
  it('should still ask health when the incumbent pid could not be observed', async () => {
    mockState.probeCoordinator.mockReturnValue({
      kind: 'unobservable',
      reason: 'unreadable-process',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: pluginRootNamespace(dirname(bundleDir)),
        bootToken: 'boot-token',
      },
    });
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await expect(runHandoff(cliOperation('backend', 'status'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'delegated',
    });
    expect(mockState.health, 'an unanswered pid probe must not stand in for asking the incumbent').toHaveBeenCalled();
  });

  // The hook spawn path leaves no attempt id, so the whole chain used to be anonymous: a second hop put a
  // third build on the address, its identity matched neither end, and a startup that worked was recorded as
  // `delegated-exit{0}` with a `startup_failed` diagnostic beside it. Minting one here is what makes the
  // grandchild attributable; without it this observation is `not-serving` and the terminal is an exit.
  it('attributes a two-hop delegation when this process inherited no attempt id', async () => {
    const target = mockState.target as ValidatedHandoffTarget;
    const mintedAttemptId = 'minted-attempt';
    const transitiveNamespace = 'transitively-delegated-plugin-root';
    const anonymousRuntime: Runtime = {
      ...runtime,
      env: {
        ...runtime.env,
        get: (key) => (key === 'CORAL_STARTUP_ATTEMPT_ID' ? undefined : runtime.env.get(key)),
      },
    };
    const polling = deferred();
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: () => {
        polling.resolve();
        return new Promise<void>(() => undefined);
      },
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    let child!: ChildProcess;
    runtimeUuid.mockReturnValue(mintedAttemptId);
    mockState.createRealRuntime.mockReturnValue(anonymousRuntime);
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementation(() => {
      child = childThatStaysAlive();
      return child;
    });

    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, time },
    );
    void result.catch(() => undefined);
    await polling.promise;

    // The id only proves lineage if the child it was minted for actually receives it and passes it on.
    expect(mockState.spawn.mock.calls[0]?.[2]?.env).toMatchObject({ CORAL_STARTUP_ATTEMPT_ID: mintedAttemptId });

    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: transitiveNamespace,
        bootToken: 'boot-token',
      },
    });
    mockState.health.mockResolvedValue({
      ...liveHealth(undefined, transitiveNamespace),
      env: { CORAL_STARTUP_ATTEMPT_ID: mintedAttemptId },
    });

    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    await expect(result).resolves.toMatchObject({
      kind: 'delegated-startup',
      version: manifest.version,
      observation: { kind: 'serving' },
    });
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      disposition: { kind: 'delegated-success', version: manifest.version },
    });
  });
});

it('refuses a wait whose newer target fails the wait contract probe, writing no shared routing record', async () => {
  mockState.execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(Object.assign(new Error('unsupported contract'), { code: 2 }), ''));
    return childThatExits(2, null);
  });
  const result = runHandoffResult(cliOperation('wait', 'jobs', 'a'), {
    pluginRoot: '/plugin/root',
    waitInvocation: {
      mode: 'bounded',
      signal: new AbortController().signal,
      originalCommand: 'coral-cli wait jobs a',
      remainingMs: () => 10000,
      cleanupRemainingMs: () => 11000,
      saveContinuation: vi.fn(),
    },
  });
  await expect(result).rejects.toBeInstanceOf(WaitBuildMismatchError);
  await expect(result).rejects.toMatchObject({ code: 'wait_build_mismatch', exitCode: 1 });
  expect(mockState.spawn).not.toHaveBeenCalled();
  expect(mockState.execFile.mock.calls[0][2].env).toEqual({
    CORAL_BASE_ENV: 'preserved',
    CORAL_CLI_HANDOFF_DELEGATED: '1',
  });
  expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).not.toHaveBeenCalled();
});

it('keeps the monitor IPC listener through close when delivery follows exit', async () => {
  const save = vi.fn();
  mockState.execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify({ version: 1, monitorOnly: true })));
    return childThatExits(0, null);
  });
  mockState.spawn.mockImplementation(() => {
    const child = childThatStaysAlive();
    queueMicrotask(() =>
      queueMicrotask(() => {
        child.emit('exit', 0, null);
        queueMicrotask(() => {
          child.emit('message', {
            type: 'wait-delivery',
            continuation: 'exact continuation',
            complete: true,
            delivered: true,
            exitCode: 42,
          });
          child.emit('close', 0, null);
        });
      }),
    );
    return child;
  });
  await runHandoff(cliOperation('wait', 'jobs', 'a'), {
    pluginRoot: '/plugin/root',
    waitInvocation: {
      mode: 'bounded',
      signal: new AbortController().signal,
      originalCommand: 'coral-cli wait jobs a',
      remainingMs: () => 5000,
      cleanupRemainingMs: () => 5000,
      saveContinuation: save,
    },
  });
  expect(save).toHaveBeenCalledExactlyOnceWith('exact continuation', true, true, 42);
});

it('refuses a wait routed to a released CLI without the contract flag before any dispatch, and never runs it here', async () => {
  vi.spyOn(runtime.storage, 'readFileSync').mockReturnValue('released CLI without a monitor contract');
  mockState.execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '{}'));
    return childThatExits(0, null);
  });
  const result = runHandoff(cliOperation('wait', 'jobs', 'a'), {
    pluginRoot: '/plugin/root',
    waitInvocation: {
      mode: 'bounded',
      signal: new AbortController().signal,
      originalCommand: 'coral-cli wait jobs a',
      remainingMs: () => 5000,
      cleanupRemainingMs: () => 5000,
      saveContinuation: vi.fn(),
    },
  });
  await expect(result).rejects.toBeInstanceOf(WaitBuildMismatchError);
  await expect(result).rejects.toMatchObject({
    remediation: 'Restart the session so the current Coral plugin loads; the coordinator follows the installed build.',
  });
  expect(mockState.execFile).not.toHaveBeenCalled();
  expect(mockState.spawn).not.toHaveBeenCalled();
  expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).not.toHaveBeenCalled();

  mockState.spawn.mockImplementation(() => childThatExits(0, null));
  await expect(runHandoff(cliOperation('jobs', 'list'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
    kind: 'delegated',
  });
  expect(mockState.execFile).not.toHaveBeenCalled();
  expect(mockState.spawn).toHaveBeenCalledOnce();
});

it('uses the remaining launch-follow invocation budget for its contract probe', async () => {
  vi.useFakeTimers();
  const probeChild = childThatStaysAlive();
  probeChild.kill = vi.fn(() => true);
  const started = deferred();
  mockState.execFile.mockImplementation((_file, _args, _options, callback) => {
    setTimeout(() => callback(null, JSON.stringify({ version: 1, monitorOnly: true })), 1500);
    started.resolve();
    return probeChild;
  });
  mockState.spawn.mockImplementation(() => childThatExits(0, null));
  const result = runHandoff(
    { kind: 'wait-jobs', jobId: 'a', serializedCursor: 'AA' },
    {
      pluginRoot: '/plugin/root',
      waitProbeRemainingMs: () => 4200,
    },
  );
  void result.catch(() => undefined);
  await started.promise;
  (runtime.time as VirtualTime).tick(1500);
  await vi.advanceTimersByTimeAsync(1500);
  expect(probeChild.kill).not.toHaveBeenCalled();
  await expect(result).resolves.toMatchObject({ kind: 'delegated', outcome: { kind: 'handoff-success' } });
});

it('delegates a launch follow as a wait jobs invocation carrying its cursor, and hands the caller its child', async () => {
  mockState.execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify({ version: 1, monitorOnly: true })));
    return childThatExits(0, null);
  });
  const children: unknown[] = [];
  mockState.spawn.mockImplementation(() => {
    const child = childThatExits(75, null);
    children.push(child);
    return child;
  });
  const onDelegatedChild = vi.fn();
  const result = runHandoff(
    { kind: 'wait-jobs', jobId: 'a', serializedCursor: 'saved-cursor' },
    { pluginRoot: '/plugin/root', waitProbeRemainingMs: () => 10_000, onDelegatedChild },
  );
  await expect(result).resolves.toMatchObject({ kind: 'delegated', outcome: { kind: 'handoff-exit', exitCode: 75 } });
  expect(mockState.spawn).toHaveBeenCalledOnce();
  expect(mockState.spawn.mock.calls[0][1].slice(1)).toEqual(['wait', 'jobs', 'a', '--cursor', 'saved-cursor']);
  expect(mockState.spawn.mock.calls[0][2].stdio).toBe('inherit');
  expect(onDelegatedChild).toHaveBeenCalledExactlyOnceWith(children[0]);
  await runHandoff(
    { kind: 'wait-jobs', jobId: 'a' },
    { pluginRoot: '/plugin/root', waitProbeRemainingMs: () => 10_000 },
  );
  expect(mockState.spawn.mock.calls[1][1].slice(1)).toEqual(['wait', 'jobs', 'a']);
});
