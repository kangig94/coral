import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ABSENT_HANDOFF_RESULT_OBLIGATION,
  HANDOFF_CONTINUATION_REASON_OBLIGATIONS,
  HandoffRunError,
  liveIncumbentHealthSchema,
  consumeHandoffRunResult,
  resolveHandoffRoutingForOperation,
  routeAuthenticatedHealth,
  runHandoff as runHandoffResult,
  validateForeignHandoffTarget,
  type HandoffContinuationResult,
  type HandoffOperation,
  type HandoffRunResult,
  type RunHandoffOptions,
} from '#src/coordinator/handoff-routing/runner.js';
import { backendLog } from '#src/infra/backend-log.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type * as HandoffRoutingStatusMod from '#src/coordinator/handoff-routing/status.js';
import { handoffRoutingStatusStoreSchema } from '#src/coordinator/handoff-routing/status.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import type { TimePort } from '#src/infra/port-types.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { withValidatedHandoffTarget, type ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import { serializeWaitCursor } from '#src/jobs/wait.js';
import type * as RealRuntimeMod from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

type StrictBundleManifest = BundleManifestMod.StrictBundleManifest;
type StrictBundleIdentityFailure = BundleManifestMod.StrictBundleIdentityFailure;
type LiveIncumbentHealth = Parameters<typeof routeAuthenticatedHealth>[0];
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());

const mockState = vi.hoisted(() => ({
  createIpcClient: vi.fn(),
  createRealRuntime: vi.fn<typeof RealRuntimeMod.createRealRuntime>(),
  health: vi.fn(),
  probeCoordinator: vi.fn(),
  readBuildFlavor: vi.fn(),
  resolveStrictBundleIdentity: vi.fn(),
  spawn: vi.fn(),
  publishGenerationCoordinatedHandoffRoutingTransitions: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, spawn: mockState.spawn };
});

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
const roots: string[] = [];
const backendBundle = 'handoff runner backend fixture';
const cliBundle = 'handoff runner cli fixture';
const claudeAppserverBundle = 'handoff runner claude appserver fixture';
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '223e4567-e89b-42d3-a456-426614174000',
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
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

async function createHandoffRuntime(baseDir?: string): Promise<Runtime> {
  const { createRealRuntime } = await vi.importActual<typeof RealRuntimeMod>('#src/runtime/real.js');
  const actual = createRealRuntime('prod', baseDir === undefined ? undefined : { baseDir });
  return {
    ...actual,
    ids: { ...actual.ids, uuid: runtimeUuid },
    process: { ...actual.process, readProcessIncarnation },
    time: {
      ...actual.time,
      now: () => 1_700_000_000_000,
      monotonicNow: () => 0n,
      sleep: async () => {},
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: { unref?(): void } | null) => {
        clearTimeout(handle as unknown as NodeJS.Timeout);
      },
    },
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
          runDir: baseDir === undefined ? '/handoff/run' : actual.paths.coral.coordinator.runDir,
          socketPath,
        },
      },
    },
  };
}

function observedContinuation(result: HandoffRunResult): HandoffContinuationResult {
  return consumeHandoffRunResult(result, () => undefined);
}

async function runHandoff(
  operation: HandoffOperation,
  options?: RunHandoffOptions,
): Promise<HandoffContinuationResult> {
  return observedContinuation(await runHandoffResult(operation, options));
}

function createBundle(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-handoff-runner-'));
  roots.push(root);
  writeFileSync(join(root, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(root, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(root, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return root;
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

function configureNewerIncumbent(bundleDir = createBundle()): string {
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
  return bundleDir;
}

function cliOperation(...args: string[]): HandoffOperation {
  return { kind: 'cli-invocation', argv: ['node', 'coral-cli', ...args] };
}

function childThatExits(code: number | null, signal: NodeJS.Signals | null): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: SPAWNED_CHILD_PID }) as unknown as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => {
    child.emit('spawn');
    queueMicrotask(() => child.emit('exit', code, signal));
  });
  return child;
}

function childThatErrors(error: Error): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => child.emit('error', error));
  return child;
}

function childThatSpawnsThenErrors(error: Error): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: SPAWNED_CHILD_PID }) as unknown as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => {
    child.emit('spawn');
    queueMicrotask(() => child.emit('error', error));
  });
  return child;
}

function childThatStaysAlive(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { pid: SPAWNED_CHILD_PID }) as unknown as ChildProcess;
  child.unref = vi.fn();
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

function validatedTarget(bundleDir: string) {
  const validation = validateForeignHandoffTarget(bundleDir, manifest);
  if (validation.kind !== 'validated') {
    throw new Error(`Expected a validated target, received ${validation.kind}`);
  }
  return validation.target;
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
  mockState.publishGenerationCoordinatedHandoffRoutingTransitions
    .mockReset()
    .mockResolvedValue({ kind: 'committed', sequence: 1 });
  readProcessIncarnation.mockReset().mockReturnValue(testIncarnation('handoff-runner'));
  runtimeUuid.mockReset();
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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff-routing/runner', () => {
  it('requires recording incidents to be handled before returning observed work', () => {
    const recordedContinuation = {
      kind: 'run-current',
      reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
    } as const;
    const notApplicableContinuation = {
      kind: 'run-current',
      reason: { kind: 'handoff-not-applicable', reason: 'display-only' },
    } as const;
    const incidentContinuation = {
      kind: 'run-current',
      reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
    } as const;
    const incidents = [
      {
        phase: 'selection',
        invocationId: '123e4567-e89b-42d3-a456-426614174000',
        kind: 'not-published',
        cause: 'contended',
      },
    ] as const;

    const handleRecordingIncidents = vi.fn();

    expect(
      consumeHandoffRunResult(
        {
          kind: 'recorded',
          continuation: recordedContinuation,
          publicationIncidents: [],
        },
        handleRecordingIncidents,
      ),
    ).toEqual(recordedContinuation);
    expect(
      consumeHandoffRunResult(
        {
          kind: 'recording-not-applicable',
          continuationWithoutRecording: notApplicableContinuation,
        },
        handleRecordingIncidents,
      ),
    ).toEqual(notApplicableContinuation);
    expect(handleRecordingIncidents).not.toHaveBeenCalled();
    expect(
      consumeHandoffRunResult(
        {
          kind: 'recording-incidents',
          observedWork: incidentContinuation,
          publicationIncidents: incidents,
        },
        handleRecordingIncidents,
      ),
    ).toEqual(incidentContinuation);
    expect(handleRecordingIncidents).toHaveBeenCalledWith(incidents);
  });

  it('binds every continuation reason and the absent result to an obligation', () => {
    expect(HANDOFF_CONTINUATION_REASON_OBLIGATIONS).toEqual({
      'handoff-not-applicable': {
        requiredDurability: 'ephemeral-allowed',
        requiredRetention: 'until-superseded',
        severity: 'info',
        exitContribution: 0,
      },
      'handoff-abandoned': {
        requiredDurability: 'durable-status-required',
        requiredRetention: 'bounded-history',
        severity: 'warning',
        exitContribution: 75,
      },
    });
    expect(ABSENT_HANDOFF_RESULT_OBLIGATION).toEqual({
      requiredDurability: 'ephemeral-allowed',
      requiredRetention: 'until-superseded',
      severity: 'info',
      exitContribution: 0,
    });
  });

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

  it('should commit the full lifecycle for a live peer identity at the ingress maximum', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-runner-routing-'));
    roots.push(baseDir);
    const isolatedRuntime = await createHandoffRuntime(baseDir);
    mkdirSync(isolatedRuntime.paths.coral.coordinator.runDir, { recursive: true });
    mockState.createRealRuntime.mockReturnValue(isolatedRuntime);
    const status = await vi.importActual<typeof HandoffRoutingStatusMod>('#src/coordinator/handoff-routing/status.js');
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mockImplementation(
      status.publishGenerationCoordinatedHandoffRoutingTransitions,
    );

    const healthProducerSchema = liveIncumbentHealthSchema.innerType();
    const maximumVersionLength = healthProducerSchema.shape.version.maxLength;
    const maximumInstanceIdLength = healthProducerSchema.shape.instanceId.maxLength;
    if (maximumVersionLength === null || maximumInstanceIdLength === null) {
      throw new Error('Expected the live identity producer to be bounded.');
    }
    const versionPrefix = '1.0.0+';
    const maximumHealth = {
      status: 'ok',
      version: `${versionPrefix}${'x'.repeat(maximumVersionLength - versionPrefix.length)}`,
      bundleHash: 'f'.repeat(16),
      flavor: 'prod',
      namespace: 'handoff-runner',
      instanceId: '\u0800'.repeat(maximumInstanceIdLength),
      pid: 4242,
    } as const;
    const maximumIncumbent = {
      version: maximumHealth.version,
      bundleHash: maximumHealth.bundleHash,
      flavor: maximumHealth.flavor,
      instanceId: maximumHealth.instanceId,
    };
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: maximumHealth.pid,
        bundleHash: maximumHealth.bundleHash,
        flavor: maximumHealth.flavor,
        namespace: maximumHealth.namespace,
        bootToken: 'boot-token',
      },
    });
    mockState.health.mockResolvedValue(maximumHealth);
    let nextId = 0;
    runtimeUuid.mockImplementation(() => `maximum-peer-${++nextId}`);

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'recorded',
      continuation: {
        kind: 'run-current',
        reason: {
          kind: 'routing',
          basis: {
            kind: 'incumbent-identity-unavailable',
            incumbent: maximumIncumbent,
          },
        },
      },
      publicationIncidents: [],
    });
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[0]?.[2][0]).toMatchObject({
      kind: 'routing-selected',
      disposition: {
        kind: 'continue-current',
        basis: { kind: 'incumbent-identity-unavailable', incumbent: maximumIncumbent },
      },
    });
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
    });

    const path = join(
      isolatedRuntime.paths.coral.coordinator.runDir,
      `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
    );
    expect(status.readHandoffRoutingStatus(isolatedRuntime, path)).toMatchObject({
      kind: 'current',
      statuses: [
        {
          kind: 'terminal',
          selection: {
            disposition: {
              kind: 'continue-current',
              basis: { kind: 'incumbent-identity-unavailable', incumbent: maximumIncumbent },
            },
          },
          terminal: { disposition: { kind: 'continued-current' } },
        },
      ],
    });
  });

  it('should refuse pid-only selection authority and still record the terminal gap', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    readProcessIncarnation.mockReturnValue(null);

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'recording-incidents',
      observedWork: {
        kind: 'run-current',
        reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
      },
      publicationIncidents: [
        {
          phase: 'selection',
          invocationId: '123e4567-e89b-42d3-a456-426614174000',
          kind: 'refused',
          refusal: {
            reason: 'owner-identity-unavailable',
            remediation: 'retry-when-process-identity-is-readable',
            attemptedPhase: 'selection',
          },
        },
      ],
    });

    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).toHaveBeenCalledOnce();
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[0]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      selection: { kind: 'without-selection' },
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

  it('should retain selection not-published together with terminal uncertainty', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions
      .mockResolvedValueOnce({ kind: 'not-published', cause: 'contended' })
      .mockResolvedValueOnce({ kind: 'commit-outcome-unknown', cause: 'storage-corrupt', errcode: 26 });

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'recording-incidents',
      publicationIncidents: [
        { phase: 'selection', kind: 'not-published', cause: 'contended' },
        { phase: 'terminal', kind: 'commit-outcome-unknown', cause: 'storage-corrupt', errcode: 26 },
      ],
    });
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      selection: { kind: 'without-selection' },
    });
  });

  it('should retain the invalid-record validation category on a publication incident', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions
      .mockResolvedValueOnce({
        kind: 'not-published',
        cause: 'invalid-record',
        validation: { kind: 'envelope-body-disagreement' },
      })
      .mockResolvedValueOnce({ kind: 'committed', sequence: 2 });

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'recording-incidents',
      publicationIncidents: [
        {
          phase: 'selection',
          kind: 'not-published',
          cause: 'invalid-record',
          validation: { kind: 'envelope-body-disagreement' },
        },
      ],
    });
  });

  it('should surface generation maintenance refusals for both lifecycle publications', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mockResolvedValue({
      kind: 'not-published',
      cause: 'generation-maintenance',
    });
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'recording-incidents',
      publicationIncidents: [
        { phase: 'selection', kind: 'not-published', cause: 'generation-maintenance' },
        { phase: 'terminal', kind: 'not-published', cause: 'generation-maintenance' },
      ],
    });
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
  });

  it('should report a selection incident before spawning delegated work', async () => {
    const order: string[] = [];
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions
      .mockResolvedValueOnce({ kind: 'not-published', cause: 'contended' })
      .mockResolvedValueOnce({ kind: 'committed', sequence: 2 });
    mockState.spawn.mockImplementationOnce(() => {
      order.push('spawn');
      return childThatExits(0, null);
    });

    await runHandoffResult(cliOperation('run'), {
      pluginRoot: '/plugin/root',
      onSelectionPublicationIncident: () => order.push('selection-incident'),
    });

    expect(order).toEqual(['selection-incident', 'spawn']);
  });

  it('should preserve the original error object when both publications commit', async () => {
    const originalError = new Error('spawn rejected');
    mockState.spawn.mockImplementationOnce(() => childThatErrors(originalError));

    const thrown = await runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBe(originalError);
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
  });

  it('should identify a failed operation when its execution-failed terminal is not published', async () => {
    const originalError = new Error('spawn rejected');
    mockState.spawn.mockImplementationOnce(() => childThatErrors(originalError));
    mockState.publishGenerationCoordinatedHandoffRoutingTransitions
      .mockResolvedValueOnce({ kind: 'committed', sequence: 1 })
      .mockResolvedValueOnce({ kind: 'not-published', cause: 'capacity-exhausted' });

    const thrown = await runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(HandoffRunError);
    expect(thrown).toMatchObject({
      originalError,
      incidents: [
        {
          phase: 'terminal',
          invocationId: '123e4567-e89b-42d3-a456-426614174000',
          terminalDisposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
          kind: 'not-published',
          cause: 'capacity-exhausted',
        },
      ],
    });
  });

  it.each([
    ['resolve', ['resolve', '--invocation', '123e4567-e89b-42d3-a456-426614174000']],
    ['discard', ['discard']],
    ['quarantine list', ['quarantine', 'list']],
    ['quarantine clear', ['quarantine', 'clear', '--id', '123e4567-e89b-42d3-a456-426614174000']],
    ['an unclassified routing-status subcommand', ['future-command']],
  ])('should route and execute routing-status %s without opening a lifecycle', async (_name, args) => {
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));
    const result = await runHandoffResult(cliOperation('backend', 'routing-status', ...args), {
      pluginRoot: '/plugin/root',
    });

    expect(result).toMatchObject({
      kind: 'recording-not-applicable',
      continuationWithoutRecording: { kind: 'delegated' },
    });
    expect(mockState.health).toHaveBeenCalledOnce();
    expect(mockState.spawn).toHaveBeenCalledOnce();
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).not.toHaveBeenCalled();
  });

  it.each([
    [
      'invocation',
      ['--invocation', '123e4567-e89b-42d3-a456-426614174000', '--invocation', '223e4567-e89b-42d3-a456-426614174000'],
    ],
    [
      'force override',
      ['--invocation', '123e4567-e89b-42d3-a456-426614174000', '--force-unobservable', '--force-unobservable'],
    ],
  ])('should exclude malformed routing-status resolve %s options from lifecycle recording', async (_name, options) => {
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await expect(
      runHandoffResult(cliOperation('backend', 'routing-status', 'resolve', ...options), {
        pluginRoot: '/plugin/root',
      }),
    ).resolves.toMatchObject({ kind: 'recording-not-applicable' });

    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).not.toHaveBeenCalled();
  });

  it.each(['forged', 'consumed'])('should persist no selection for a %s target', async (authority) => {
    const target = authority === 'forged' ? ({} as ValidatedHandoffTarget) : validatedTarget(roots[0]);
    if (authority === 'consumed') withValidatedHandoffTarget(target);

    const thrown = await runHandoffResult(cliOperation('run'), {
      pluginRoot: '/plugin/root',
      activeSelectionTarget: target,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(HandoffRunError);
    expect(thrown).toMatchObject({
      originalError: { message: expect.stringContaining('was not produced') },
      incidents: [
        {
          phase: 'selection',
          kind: 'refused',
          refusal: { reason: 'invalid-target-authority', attemptedPhase: 'selection' },
        },
      ],
    });
    const transitions = mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls.map(
      (call) => call[2][0],
    );
    expect(transitions).not.toContainEqual(expect.objectContaining({ kind: 'routing-selected' }));
    expect(transitions).toContainEqual(
      expect.objectContaining({
        kind: 'execution-failed',
        selection: { kind: 'without-selection' },
        disposition: { kind: 'execution-failed', throwPhase: 'target-authority' },
      }),
    );
  });

  it.each([
    ['absent', undefined],
    ['zero', '0'],
  ])('should delegate when the guard is %s and propagate one', async (_label, guard) => {
    if (guard !== undefined) {
      process.env[GUARD_ENV] = guard;
    }
    const bundleDir = roots[0];
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    const result = await runHandoff(cliOperation('backend', 'status'), { pluginRoot: '/plugin/root' });

    expect(result).toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-success', version: manifest.version },
    });
    expect(mockState.spawn).toHaveBeenCalledWith(
      process.execPath,
      [join(bundleDir, 'coral-cli.cjs'), 'backend', 'status'],
      {
        cwd: '/handoff/cwd',
        env: { CORAL_BASE_ENV: 'preserved', [GUARD_ENV]: '1' },
        stdio: 'inherit',
      },
    );
    const selection = mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[0]?.[2][0];
    expect(selection).toMatchObject({
      kind: 'routing-selected',
      disposition: {
        kind: 'handoff-selected',
        source: 'live-incumbent',
        target: {
          build: {
            version: manifest.version,
            buildSetId: manifest.buildSetId,
            bundleHash: manifest.bundleHash,
            flavor: manifest.flavor,
          },
        },
      },
    });
    expect(selection.disposition.target).not.toHaveProperty('bundleDir');
  });

  it('should derive wait jobs argv from the job and seq cursor', async () => {
    const bundleDir = roots[0];
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await runHandoff(
      { kind: 'wait-jobs', jobId: 'job-1', serializedCursor: 'eyJhZnRlclNlcSI6N30' },
      { pluginRoot: '/plugin/root' },
    );

    expect(mockState.spawn).toHaveBeenCalledWith(
      process.execPath,
      [join(bundleDir, 'coral-cli.cjs'), 'wait', 'jobs', 'job-1', '--cursor', serializeWaitCursor({ afterSeq: 7 })],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('should return run-current without spawning when no incumbent is discoverable', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
    });

    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['-h'], ['--version']])(
    'should skip the incumbent probe for display-only invocation %s',
    async (flag) => {
      await expect(runHandoff(cliOperation(flag), { pluginRoot: '/plugin/root' })).resolves.toEqual({
        kind: 'run-current',
        reason: { kind: 'handoff-not-applicable', reason: 'display-only' },
      });

      expect(mockState.createRealRuntime).not.toHaveBeenCalled();
      expect(mockState.probeCoordinator).not.toHaveBeenCalled();
      expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).not.toHaveBeenCalled();
    },
  );

  it.each(['', '2', '01', ' 1 ', 'true'])('should reject invalid delegation guard value %j as usage', async (guard) => {
    process.env[GUARD_ENV] = guard;

    // Owned by the runner, not `cli/errors.ts` — importing that would close a cli -> coordinator -> cli
    // cycle. `buildErrorEnvelope` maps it to invalid_usage / exit 2 on the CLI side.
    await expect(runHandoff(cliOperation('run'))).rejects.toMatchObject({ name: 'HandoffGuardError' });
    await expect(runHandoff(cliOperation('run'))).rejects.toThrow(GUARD_ENV);
    expect(mockState.probeCoordinator).toHaveBeenCalledTimes(2);
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'execution-failed',
      disposition: { kind: 'execution-failed', throwPhase: 'double-delegation-guard' },
    });
  });

  it('should refuse a second delegation inside the routing authority', async () => {
    process.env[GUARD_ENV] = '1';

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).rejects.toThrow(
      /already delegated once/u,
    );
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'execution-failed',
      disposition: { kind: 'execution-failed', throwPhase: 'double-delegation-guard' },
    });
  });

  it('keeps backend-startup delegation pending past the former liveness point until authenticated readiness', async () => {
    process.env[GUARD_ENV] = 'not-a-cli-guard';
    const bundleDir = roots[0];
    const target = validatedTarget(bundleDir);
    let child: ChildProcess | undefined;
    let releasePoll: (() => void) | undefined;
    const pollDelays: number[] = [];
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          pollDelays.push(ms);
          releasePoll = resolve;
        }),
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatStaysAlive();
      return child;
    });

    // Startup delegates the same active-store selection again. Version precedence is strictly monotone, so
    // the selected build cannot classify the older caller as a target and bounce back.
    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, time },
    );
    await vi.waitFor(() => expect(child?.unref).toHaveBeenCalledOnce());

    expect(mockState.probeCoordinator).toHaveBeenCalled();
    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.spawn).toHaveBeenCalledWith(process.execPath, [join(bundleDir, 'coral-backend.cjs')], {
      cwd: '/handoff/cwd',
      env: { CORAL_BASE_ENV: 'preserved', [GUARD_ENV]: '1' },
      stdio: 'inherit',
      detached: true,
    });
    expect(pollDelays).toHaveLength(1);
    expect(pollDelays[0]).toBe(100);

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    configureNewerIncumbent(bundleDir);
    releasePoll?.();
    await expect(result).resolves.toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-success', version: manifest.version },
    });
  });

  it('refuses to continue-current for an aborted startup handoff', async () => {
    const bundleDir = roots[0];
    const target = validatedTarget(bundleDir);
    let child: ChildProcess | undefined;
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatStaysAlive();
      return child;
    });

    const aborted = AbortSignal.abort();
    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, signal: aborted },
    );
    await vi.waitFor(() => expect(child?.unref).toHaveBeenCalledOnce());

    await expect(result).resolves.toMatchObject({
      kind: 'delegated',
      outcome: {
        kind: 'handoff-startup-observation-aborted',
        version: manifest.version,
        child: { pid: SPAWNED_CHILD_PID, incarnation: testIncarnation('handoff-runner') },
        childDisposition: 'left-running-and-unobserved',
      },
    });

    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    await expect(
      runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root', activeSelectionTarget: target, signal: aborted }),
    ).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
    });
  });

  it('returns and records abandonment when startup observation is aborted', async () => {
    const target = validatedTarget(roots[0]);
    const controller = new AbortController();
    const sleep = vi.fn<TimePort['sleep']>(
      (_ms, options) =>
        new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve();
            return;
          }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    const time: TimePort = {
      ...runtime.time,
      sleep,
    };
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    // The child must be created inside the spawn call; one built earlier emits 'spawn' before the runner
    // can observe it.
    let child!: ChildProcess;
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatStaysAlive();
      return child;
    });

    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, signal: controller.signal, time },
    );
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: {
        kind: 'handoff-startup-observation-aborted',
        version: manifest.version,
        child: { pid: SPAWNED_CHILD_PID, incarnation: testIncarnation('handoff-runner') },
        childDisposition: 'left-running-and-unobserved',
      },
    });
    expect(mockState.probeCoordinator).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      disposition: {
        kind: 'delegated-startup-observation-aborted',
        version: manifest.version,
        child: { pid: SPAWNED_CHILD_PID, incarnation: testIncarnation('handoff-runner') },
        childDisposition: 'left-running-and-unobserved',
      },
    });
  });

  it('abandons the child on the identity read while it was live, not one read after the abort', async () => {
    const target = validatedTarget(roots[0]);
    const controller = new AbortController();
    const sleep = vi.fn<TimePort['sleep']>(
      (_ms, options) =>
        new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve();
            return;
          }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    let childIdentityReads = 0;
    // The abort must use the identity already held: a later read can answer null for a child that is still
    // running, and that answer must not be reachable from here.
    readProcessIncarnation.mockImplementation((pid) => {
      if (pid !== SPAWNED_CHILD_PID) return testIncarnation('handoff-runner');
      childIdentityReads += 1;
      return childIdentityReads === 1 ? testIncarnation('handoff-runner') : null;
    });
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementationOnce(() => childThatStaysAlive());

    const result = runHandoff(
      { kind: 'backend-startup' },
      {
        pluginRoot: '/plugin/root',
        activeSelectionTarget: target,
        signal: controller.signal,
        time: { ...runtime.time, sleep },
      },
    );
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: {
        kind: 'handoff-startup-observation-aborted',
        version: manifest.version,
        child: { pid: SPAWNED_CHILD_PID, incarnation: testIncarnation('handoff-runner') },
        childDisposition: 'left-running-and-unobserved',
      },
    });
    expect(childIdentityReads).toBe(1);
  });

  it('records a terminal and names the pid when the abandoned child cannot be attributed', async () => {
    const target = validatedTarget(roots[0]);
    const controller = new AbortController();
    const sleep = vi.fn<TimePort['sleep']>(
      (_ms, options) =>
        new Promise<void>((resolve) => {
          if (options?.signal?.aborted === true) {
            resolve();
            return;
          }
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    // No incarnation is readable for the child at any point, so a durable hold has no key to be filed under.
    readProcessIncarnation.mockImplementation((pid) =>
      pid === SPAWNED_CHILD_PID ? null : testIncarnation('handoff-runner'),
    );
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementationOnce(() => childThatStaysAlive());

    const result = runHandoffResult(
      { kind: 'backend-startup' },
      {
        pluginRoot: '/plugin/root',
        activeSelectionTarget: target,
        signal: controller.signal,
        time: { ...runtime.time, sleep },
      },
    );
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());
    controller.abort();

    const error = await result.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`pid ${SPAWNED_CHILD_PID}`);
    expect((error as Error).message).toContain('no routing-status hold can name it');
    expect((error as Error).message).toContain("Run 'coral-cli backend status'");
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'execution-failed',
      disposition: { kind: 'execution-failed', throwPhase: 'child-outcome-wait' },
    });
  });

  it('attaches terminal and abort observers once across repeated startup polls', async () => {
    const target = validatedTarget(roots[0]);
    const controller = new AbortController();
    let sleepCalls = 0;
    const sleep = vi.fn<TimePort['sleep']>((_ms, options) => {
      sleepCalls += 1;
      if (sleepCalls <= 20) return Promise.resolve();
      return new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    const race = vi.spyOn(Promise, 'race');
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementationOnce(() => childThatStaysAlive());

    const result = runHandoff(
      { kind: 'backend-startup' },
      {
        pluginRoot: '/plugin/root',
        activeSelectionTarget: target,
        signal: controller.signal,
        time: { ...runtime.time, sleep },
      },
    );
    await vi.waitFor(() => expect(sleepCalls).toBeGreaterThan(20));

    // `Promise.race` subscribes to every promise it is given, so racing per poll re-attaches the terminal
    // and abort observers on each pass.
    expect(race).not.toHaveBeenCalled();
    controller.abort();
    await expect(result).resolves.toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-startup-observation-aborted' },
    });
  });

  it('should produce the active-selection source before backend startup delegation', async () => {
    const target = validatedTarget(roots[0]);

    const resolution = await resolveHandoffRoutingForOperation(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target },
    );

    expect(resolution.routing).toEqual({ kind: 'handoff', target, source: 'active-selection' });
  });

  it.each<StrictBundleIdentityFailure>([
    'embedded_identity_unavailable',
    'adjacent_manifest_unavailable',
    'adjacent_manifest_invalid',
    'adjacent_manifest_mismatch',
  ])('should produce invoking-identity-unavailable with failure %s', (failure) => {
    mockState.resolveStrictBundleIdentity.mockReturnValue({ ok: false, reason: failure });

    expect(routeAuthenticatedHealth(liveHealth(roots[0]))).toEqual({
      kind: 'continue-current',
      basis: { kind: 'invoking-identity-unavailable', failure },
    });
  });

  it('should produce incumbent-identity-unavailable when authenticated health omits its target identity', () => {
    expect(routeAuthenticatedHealth(liveHealth())).toEqual({
      kind: 'continue-current',
      basis: {
        kind: 'incumbent-identity-unavailable',
        incumbent: {
          version: manifest.version,
          bundleHash: manifest.bundleHash,
          flavor: manifest.flavor,
          instanceId: 'incumbent-1',
        },
      },
    });
  });

  it('should prefer invoking-identity-unavailable when both authenticated identities are unavailable', () => {
    mockState.resolveStrictBundleIdentity.mockReturnValue({
      ok: false,
      reason: 'embedded_identity_unavailable',
    });

    expect(routeAuthenticatedHealth(liveHealth())).toEqual({
      kind: 'continue-current',
      basis: {
        kind: 'invoking-identity-unavailable',
        failure: 'embedded_identity_unavailable',
      },
    });
  });

  it('should reject backend startup without a validated active-selection target instead of probing live health', async () => {
    process.env[GUARD_ENV] = 'not-a-cli-guard';

    await expect(runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root' })).rejects.toThrow(
      'Backend startup handoff requires a validated active-store target.',
    );

    expect(mockState.probeCoordinator).not.toHaveBeenCalled();
    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should accept an immediate backend startup exit when a live coordinator answers', async () => {
    const target = validatedTarget(roots[0]);
    let child: ChildProcess | undefined;
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatExits(0, null);
      return child;
    });

    await expect(
      runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
    ).resolves.toMatchObject({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-success', version: manifest.version },
    });
    expect(mockState.probeCoordinator).toHaveBeenCalledOnce();
    expect(mockState.health).toHaveBeenCalledOnce();
    expect(child?.unref).toHaveBeenCalledOnce();
  });

  it('holds a coordinator that cannot prove this startup attempt until the spawned backend ends', async () => {
    const target = validatedTarget(roots[0]);
    const releasePolls: Array<() => void> = [];
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: () => new Promise<void>((resolve) => releasePolls.push(resolve)),
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    let child!: ChildProcess;
    mockState.spawn.mockImplementation(() => {
      child = childThatStaysAlive();
      return child;
    });

    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, time },
    );
    void result.catch(() => undefined);
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));

    const foreignBundleDir = createBundle();
    const foreignManifest = { ...manifest, version: '2.0.0', bundleHash: 'f'.repeat(16) };
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: foreignManifest.bundleHash,
        flavor: foreignManifest.flavor,
        namespace: 'handoff-runner',
        bootToken: 'foreign-boot-token',
      },
    });
    mockState.health.mockResolvedValue({
      ...liveHealth(foreignBundleDir),
      version: foreignManifest.version,
      bundleHash: foreignManifest.bundleHash,
      manifest: foreignManifest,
    });
    for (const release of releasePolls.splice(0)) release();
    await vi.waitFor(() => expect(mockState.health).toHaveBeenCalled());

    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('exit', 23, null);
    for (const release of releasePolls.splice(0)) release();
    await expect(result).resolves.toMatchObject({ outcome: { kind: 'handoff-exit', exitCode: 23 } });
  });

  it('holds matching build health from a different plugin-root namespace until the spawned backend ends', async () => {
    const bundleDir = roots[0];
    const target = validatedTarget(bundleDir);
    const releasePolls: Array<() => void> = [];
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: () => new Promise<void>((resolve) => releasePolls.push(resolve)),
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    let child!: ChildProcess;
    mockState.spawn.mockImplementation(() => {
      child = childThatStaysAlive();
      return child;
    });

    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, time },
    );
    void result.catch(() => undefined);
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));

    const foreignNamespace = 'foreign-plugin-root';
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: foreignNamespace,
        bootToken: 'foreign-boot-token',
      },
    });
    mockState.health.mockResolvedValue(liveHealth(bundleDir, foreignNamespace));
    for (const release of releasePolls.splice(0)) release();
    await vi.waitFor(() => expect(mockState.health).toHaveBeenCalled());

    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('exit', 23, null);
    for (const release of releasePolls.splice(0)) release();
    await expect(result).resolves.toMatchObject({ outcome: { kind: 'handoff-exit', exitCode: 23 } });
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
        namespace: pluginRootNamespace(dirname(roots[0])),
        bootToken: 'boot-token',
      },
    });
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await expect(runHandoff(cliOperation('backend', 'status'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'delegated',
    });
    expect(mockState.health, 'an unanswered pid probe must not stand in for asking the incumbent').toHaveBeenCalled();
  });

  // The other half: with no record there is nothing to ask with, so `run-current` is the only available answer.
  //
  // This one does not hold the guard, and cannot. Deleting the `unreadable-record` return leaves
  // `probe.record` on a variant that has no `record`, so the mutant does not compile — there is no program for
  // a test to fail against. It was briefly rewritten on the belief that it should fail there; the belief was
  // wrong, and the rewrite would have been a test asserting the type-checker. What it does hold is the end of
  // the path: this variant reaches `run-current` with nothing asked, which is the disposition the variant
  // exists to produce and is not implied by the shape of the union.
  it('should not ask health when the discovery record itself could not be decoded', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'unobservable', reason: 'unreadable-record' });

    await expect(runHandoff(cliOperation('backend', 'status'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'unreadable-record' },
      },
    });
    expect(mockState.health, 'there is no socket path or boot token to ask with').not.toHaveBeenCalled();
  });

  // F1: a connect failure, a timed-out round-trip, and a reply this build cannot validate are three different
  // events, and none of them is `probeCoordinator` observing absence — folding all four into one `null` is the
  // defect this pair (plus the schema-rejection test below) exists to catch. Mutating either arm of
  // `LiveIncumbentReading`'s production back to `null`, or the routing switch back to `=== null`, keeps this
  // green only if the warning assertion is also deleted — which is the point: the outcome alone cannot tell
  // the two `not-observed` reasons apart, so the signal a caller (and this test) can actually check is the log.
  it('should return run-current and warn when authenticated health cannot be reached', async () => {
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: 'handoff-runner',
        bootToken: 'boot-token',
      },
    });
    mockState.health.mockRejectedValue(new Error('ECONNREFUSED'));
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'health-request-failed' },
      },
    });

    expect(
      mockState.spawn,
      'a round-trip that never completed must not be read as an observed incumbent',
    ).not.toHaveBeenCalled();
    expect(
      warnSpy,
      'an unresolved probe must be visible, not silently identical to an observed absence',
    ).toHaveBeenCalled();
  });

  it('should return run-current and warn when authenticated health fails schema validation', async () => {
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: 'handoff-runner',
        bootToken: 'boot-token',
      },
    });
    // Missing every field `liveIncumbentHealthSchema` requires beyond `status` — a reply, not a refusal.
    mockState.health.mockResolvedValue({ status: 'ok' });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' },
      },
    });

    expect(
      mockState.spawn,
      'a reply this build cannot validate must not be read as an observed incumbent',
    ).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('should route a non-canonical peer identity to the ingress rejection basis', async () => {
    const healthProducerSchema = liveIncumbentHealthSchema.innerType();
    const maximumInstanceIdLength = healthProducerSchema.shape.instanceId.maxLength;
    if (maximumInstanceIdLength === null) throw new Error('Expected the live identity producer to be bounded.');
    mockState.health.mockResolvedValue({
      ...liveHealth(),
      instanceId: 'x'.repeat(maximumInstanceIdLength + 1),
    });

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: {
        kind: 'routing',
        basis: { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' },
      },
    });
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[0]?.[2][0]).toMatchObject({
      disposition: {
        kind: 'continue-current',
        basis: { kind: 'incumbent-unresolved', cause: 'health-shape-rejected' },
      },
    });
  });

  it('should not warn when the probe itself observed absence', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
    });

    expect(mockState.health).not.toHaveBeenCalled();
    expect(
      warnSpy,
      'a decisive absence is not the same event as an unresolved probe and must not share its signal',
    ).not.toHaveBeenCalled();
  });

  // `draining` and `identity-mismatch` are positive observations — something answered and decoded — not the
  // same disposition as an unresolved probe or a decisive absence, so each gets its own warning wording.
  // Reusing another reason's wording, or dropping the warning, keeps `run-current` unchanged and is only
  // caught by the assertion on the message text itself.
  it('should return run-current and warn with draining-specific wording when the live incumbent reports draining', async () => {
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: 'handoff-runner',
        bootToken: 'boot-token',
      },
    });
    mockState.health.mockResolvedValue({
      status: 'draining',
      version: manifest.version,
      bundleHash: manifest.bundleHash,
      flavor: manifest.flavor,
      namespace: 'handoff-runner',
      instanceId: 'incumbent-1',
      pid: 4242,
    });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'routing', basis: { kind: 'incumbent-unusable', cause: 'draining' } },
    });

    expect(mockState.spawn, 'a draining incumbent answered but is not a usable handoff target').not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('draining'));
    expect(warnSpy, 'must not reuse the unresolved-probe wording for a reply that did decode').not.toHaveBeenCalledWith(
      expect.stringContaining('did not resolve'),
    );
  });

  it('should return run-current and warn with identity-specific wording when the live incumbent answers as a different coordinator', async () => {
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: 'handoff-runner',
        bootToken: 'boot-token',
      },
    });
    mockState.health.mockResolvedValue({
      status: 'ok',
      version: manifest.version,
      bundleHash: manifest.bundleHash,
      flavor: manifest.flavor,
      namespace: 'handoff-runner',
      instanceId: 'incumbent-1',
      pid: 9999,
    });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'routing', basis: { kind: 'incumbent-unusable', cause: 'identity-mismatch' } },
    });

    expect(
      mockState.spawn,
      'a foreign coordinator answered but is not the incumbent the discovery record named',
    ).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different coordinator identity'));
    expect(warnSpy, 'must not reuse the draining wording for a mismatched-identity reply').not.toHaveBeenCalledWith(
      expect.stringContaining('draining'),
    );
  });

  it.each([
    { childExitCode: 0, handoffExitCode: 1 },
    { childExitCode: 23, handoffExitCode: 23 },
  ])(
    'should report an immediate backend startup exit with code $handoffExitCode for child code $childExitCode when no coordinator is live',
    async ({ childExitCode, handoffExitCode }) => {
      const target = validatedTarget(roots[0]);
      let child: ChildProcess | undefined;
      mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
      mockState.spawn.mockImplementationOnce(() => {
        child = childThatExits(childExitCode, null);
        return child;
      });

      await expect(
        runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
      ).resolves.toEqual({
        kind: 'delegated',
        version: manifest.version,
        outcome: { kind: 'handoff-exit', exitCode: handoffExitCode },
      });
      expect(child?.unref).toHaveBeenCalledOnce();
    },
  );

  it('should report a signalled backend startup child as terminal before readiness', async () => {
    const target = validatedTarget(roots[0]);
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementationOnce(() => childThatExits(null, 'SIGTERM'));

    await expect(
      runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
    ).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-signal', signal: 'SIGTERM' },
    });
  });

  it('should propagate a backend startup child error without waiting for exit', async () => {
    const target = validatedTarget(roots[0]);
    const failure = new Error('backend lifecycle error');
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementationOnce(() => childThatSpawnsThenErrors(failure));

    await expect(
      runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
    ).rejects.toBe(failure);
  });

  it('keeps both delegators pending until the final backend publishes authenticated readiness', async () => {
    const firstTarget = validatedTarget(roots[0]);
    const secondTarget = validatedTarget(roots[0]);
    const releasePolls: Array<() => void> = [];
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: () => new Promise<void>((resolve) => releasePolls.push(resolve)),
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn.mockImplementation(() => childThatStaysAlive());

    const first = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: firstTarget, time },
    );
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));
    const second = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: secondTarget, time },
    );
    void second.catch(() => undefined);
    await vi.waitFor(() => expect(releasePolls).toHaveLength(2));

    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    configureNewerIncumbent(roots[0]);
    for (const release of releasePolls.splice(0)) release();

    await expect(second).resolves.toMatchObject({ outcome: { kind: 'handoff-success' } });
    await expect(first).resolves.toMatchObject({ outcome: { kind: 'handoff-success' } });
  });

  it('keeps concurrent backend startup attempts isolated until each child terminates', async () => {
    const firstTarget = validatedTarget(roots[0]);
    const secondTarget = validatedTarget(roots[0]);
    let firstChild: ChildProcess | undefined;
    let secondChild: ChildProcess | undefined;
    const releasePolls: Array<() => void> = [];
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: () => new Promise<void>((resolve) => releasePolls.push(resolve)),
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.spawn
      .mockImplementationOnce(() => {
        firstChild = childThatStaysAlive();
        return firstChild;
      })
      .mockImplementationOnce(() => {
        secondChild = childThatStaysAlive();
        return secondChild;
      });

    const first = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: firstTarget, time },
    );
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));
    const second = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: secondTarget, time },
    );
    void second.catch(() => undefined);
    await vi.waitFor(() => expect(releasePolls).toHaveLength(2));
    const spawnedFirstChild = firstChild;
    const spawnedSecondChild = secondChild;
    if (spawnedFirstChild === undefined || spawnedSecondChild === undefined) {
      throw new Error('Expected both delegated backend children to spawn.');
    }
    spawnedSecondChild.emit('exit', 17, null);

    await expect(second).resolves.toMatchObject({ outcome: { kind: 'handoff-exit', exitCode: 17 } });

    let firstSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    spawnedFirstChild.emit('exit', 23, null);

    await expect(first).resolves.toMatchObject({ outcome: { kind: 'handoff-exit', exitCode: 23 } });
  });

  it('accepts the desired build from another attempt only after the exact child terminates', async () => {
    const target = validatedTarget(roots[0]);
    const currentAttemptId = 'current-attempt';
    const attemptRuntime: Runtime = {
      ...runtime,
      env: {
        ...runtime.env,
        get: (key) => (key === 'CORAL_STARTUP_ATTEMPT_ID' ? currentAttemptId : runtime.env.get(key)),
        fullSnapshot: () => ({
          ...runtime.env.fullSnapshot(),
          CORAL_STARTUP_ATTEMPT_ID: currentAttemptId,
        }),
      },
    };
    const releasePolls: Array<() => void> = [];
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: () => new Promise<void>((resolve) => releasePolls.push(resolve)),
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    let child!: ChildProcess;
    mockState.createRealRuntime.mockReturnValue(attemptRuntime);
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
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));

    const bundleDir = configureNewerIncumbent(roots[0]);
    mockState.health.mockResolvedValue({
      ...liveHealth(bundleDir, pluginRootNamespace(dirname(bundleDir))),
      env: { CORAL_STARTUP_ATTEMPT_ID: 'other-attempt' },
    });
    for (const release of releasePolls.splice(0)) release();
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));

    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('exit', 0, null);

    await expect(result).resolves.toMatchObject({ outcome: { kind: 'handoff-success' } });
  });

  it('does not read an empty attempt id as proof that this attempt is serving', async () => {
    const target = validatedTarget(roots[0]);
    const attemptRuntime: Runtime = {
      ...runtime,
      env: {
        ...runtime.env,
        get: (key) => (key === 'CORAL_STARTUP_ATTEMPT_ID' ? '' : runtime.env.get(key)),
        fullSnapshot: () => ({ ...runtime.env.fullSnapshot(), CORAL_STARTUP_ATTEMPT_ID: '' }),
      },
    };
    const releasePolls: Array<() => void> = [];
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: () => new Promise<void>((resolve) => releasePolls.push(resolve)),
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    let child!: ChildProcess;
    mockState.createRealRuntime.mockReturnValue(attemptRuntime);
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: 'handoff-runner',
        bootToken: 'boot-token',
      },
    });
    // An unrelated coordinator under another namespace, exporting the same empty attempt id.
    mockState.health.mockResolvedValue({ ...liveHealth(), env: { CORAL_STARTUP_ATTEMPT_ID: '' } });
    mockState.spawn.mockImplementation(() => {
      child = childThatStaysAlive();
      return child;
    });

    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, time },
    );
    void result.catch(() => undefined);
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));

    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (const release of releasePolls.splice(0)) release();
    await vi.waitFor(() => expect(releasePolls).toHaveLength(1));
    expect(settled).toBe(false);

    child.emit('exit', 0, null);

    await expect(result).resolves.toMatchObject({ outcome: { kind: 'handoff-exit', exitCode: 1 } });
  });

  // The same confirmation site, reached through the other `not-observed` reason: a discovery record exists
  // and health could not be resolved from it. Reporting success here would be exactly the finalization this
  // branch's design rules forbid — an early exit-shaped outcome plus a probe that could not confirm life is
  // not evidence the backend is up. `liveCoordinator.kind === 'observed'` is what this test would catch a
  // regression to `!== null` (or similar) from failing to guard: both compile, only one refuses correctly.
  it('should report an immediate backend startup exit, not a false success, when health cannot be reached', async () => {
    const target = validatedTarget(roots[0]);
    let child: ChildProcess | undefined;
    mockState.probeCoordinator.mockReturnValue({
      kind: 'live',
      record: {
        socketPath,
        pid: 4242,
        bundleHash: manifest.bundleHash,
        flavor: manifest.flavor,
        namespace: 'handoff-runner',
        bootToken: 'boot-token',
      },
    });
    mockState.health.mockRejectedValue(new Error('ECONNREFUSED'));
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatExits(1, null);
      return child;
    });

    await expect(
      runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
    ).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-exit', exitCode: 1 },
    });
    expect(child?.unref).toHaveBeenCalledOnce();
  });

  it('should reject a byte mismatch at the final re-hash without spawning', async () => {
    const bundleDir = roots[0];
    vi.mocked(process.stdout.write).mockImplementationOnce(((
      _chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      writeFileSync(join(bundleDir, 'coral-cli.cjs'), 'changed after validation', 'utf8');
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).rejects.toThrow(
      'bytes changed before execution',
    );
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'execution-failed',
      disposition: { kind: 'execution-failed', throwPhase: 'executable-check' },
    });
  });

  it('should degrade an undrainable stdout to run-current without throwing', async () => {
    vi.useFakeTimers();
    let markDrainStarted: (() => void) | undefined;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });
    vi.mocked(process.stdout.write).mockImplementationOnce((() => {
      markDrainStarted?.();
      return false;
    }) as typeof process.stdout.write);

    const result = runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' });
    await drainStarted;
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
    });
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should isolate a failed stdout drain from a later handoff attempt', async () => {
    vi.mocked(process.stdout.write)
      .mockImplementationOnce(((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.(new Error('EPIPE'));
        return true;
      }) as typeof process.stdout.write)
      .mockImplementationOnce(((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
        callback?.();
        return true;
      }) as typeof process.stdout.write);
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
    });
    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-success' },
    });
    expect(mockState.spawn).toHaveBeenCalledOnce();
  });

  it('should reject an invalid continuation operation before probing', async () => {
    const invalid = { kind: 'wait-jobs', jobId: '', serializedCursor: '' } as HandoffOperation;

    await expect(runHandoff(invalid)).rejects.toThrow();
    expect(mockState.probeCoordinator).not.toHaveBeenCalled();
  });

  it('should report child exit and signal outcomes through the delegated result', async () => {
    mockState.spawn
      .mockImplementationOnce(() => childThatExits(23, null))
      .mockImplementationOnce(() => childThatExits(null, 'SIGTERM'));

    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-exit', exitCode: 23 },
    });
    await expect(runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toEqual({
      kind: 'delegated',
      version: manifest.version,
      outcome: { kind: 'handoff-signal', signal: 'SIGTERM' },
    });
  });

  it('should reject a child spawn failure', async () => {
    const failure = new Error('spawn failed');
    mockState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', failure));
      return child;
    });

    const thrown = await runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' }).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBe(failure);
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'execution-failed',
      disposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
    });
  });

  it('should preserve child outcome errors and record their wait phase', async () => {
    const failure = new Error('outcome failed');
    mockState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => {
        child.emit('spawn');
        queueMicrotask(() => child.emit('error', failure));
      });
      return child;
    });

    const thrown = await runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' }).catch(
      (error: unknown) => error,
    );
    expect(thrown).toBe(failure);
    expect(mockState.publishGenerationCoordinatedHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'execution-failed',
      disposition: { kind: 'execution-failed', throwPhase: 'child-outcome-wait' },
    });
  });

  it('should reject a backend startup spawn failure before the child reports spawn', async () => {
    const target = validatedTarget(roots[0]);
    mockState.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('error', new Error('backend spawn failed')));
      return child;
    });

    await expect(
      runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
    ).rejects.toThrow('backend spawn failed');
  });
});
