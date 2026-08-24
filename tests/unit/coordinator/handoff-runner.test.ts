import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ABSENT_HANDOFF_RESULT_OBLIGATION,
  HANDOFF_CONTINUATION_REASON_OBLIGATIONS,
  HandoffRunError,
  liveIncumbentHealthSchema,
  projectHandoffRunResult,
  resolveHandoffRoutingForOperation,
  routeAuthenticatedHealth,
  runHandoff as runHandoffResult,
  validateForeignHandoffTarget,
  type HandoffContinuationResult,
  type HandoffOperation,
  type HandoffRunResult,
  type RunHandoffOptions,
} from '#src/coordinator/handoff-runner.js';
import { backendLog } from '#src/infra/backend-log.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type * as HandoffRoutingStatusMod from '#src/coordinator/handoff-routing-status.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import type { TimePort } from '#src/infra/port-types.js';
import { withValidatedHandoffTarget, type ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import { serializeWaitCursor } from '#src/jobs/wait.js';
import type * as RealRuntimeMod from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

type StrictBundleManifest = BundleManifestMod.StrictBundleManifest;
type StrictBundleIdentityFailure = BundleManifestMod.StrictBundleIdentityFailure;
type LiveIncumbentHealth = Parameters<typeof routeAuthenticatedHealth>[0];

const mockState = vi.hoisted(() => ({
  createIpcClient: vi.fn(),
  createRealRuntime: vi.fn<typeof RealRuntimeMod.createRealRuntime>(),
  health: vi.fn(),
  probeCoordinator: vi.fn(),
  readBuildFlavor: vi.fn(),
  resolveStrictBundleIdentity: vi.fn(),
  spawn: vi.fn(),
  publishHandoffRoutingTransitions: vi.fn(),
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

vi.mock('#src/coordinator/handoff-routing-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRoutingStatusMod>();
  return {
    ...actual,
    publishGenerationCoordinatedHandoffRoutingTransitions: mockState.publishHandoffRoutingTransitions,
  };
});

vi.mock('#src/transport/ipc/client.js', () => ({
  createIpcClient: mockState.createIpcClient,
}));

const GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';
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
  return projectHandoffRunResult(result).continuation;
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

function liveHealth(bundleDir?: string): LiveIncumbentHealth {
  return {
    status: 'ok',
    version: manifest.version,
    bundleHash: manifest.bundleHash,
    flavor: manifest.flavor,
    namespace: 'handoff-runner',
    instanceId: 'incumbent-1',
    pid: 4242,
    ...(bundleDir === undefined ? {} : { manifest, bundleDir }),
  };
}

function configureNewerIncumbent(bundleDir = createBundle()): string {
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
  mockState.health.mockResolvedValue(liveHealth(bundleDir));
  return bundleDir;
}

function cliOperation(...args: string[]): HandoffOperation {
  return { kind: 'cli-invocation', argv: ['node', 'coral-cli', ...args] };
}

function childThatExits(code: number | null, signal: NodeJS.Signals | null): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
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

function childThatStaysAlive(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
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
  mockState.publishHandoffRoutingTransitions.mockReset().mockResolvedValue({ kind: 'committed', sequence: 1 });
  readProcessIncarnation.mockReset().mockReturnValue(testIncarnation('handoff-runner'));
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

describe('handoff-runner', () => {
  it('projects every recording state onto its observed work and incidents', () => {
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
    const incidents = [{ phase: 'selection', kind: 'not-published', cause: 'contended' }] as const;

    expect(
      projectHandoffRunResult({
        kind: 'recorded',
        continuation: recordedContinuation,
        publicationIncidents: [],
      }),
    ).toEqual({ continuation: recordedContinuation, publicationIncidents: [] });
    expect(
      projectHandoffRunResult({
        kind: 'recording-not-applicable',
        continuationWithoutRecording: notApplicableContinuation,
      }),
    ).toEqual({ continuation: notApplicableContinuation, publicationIncidents: [] });
    expect(
      projectHandoffRunResult({
        kind: 'recording-incidents',
        observedWork: incidentContinuation,
        publicationIncidents: incidents,
      }),
    ).toEqual({ continuation: incidentContinuation, publicationIncidents: incidents });
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
    mockState.publishHandoffRoutingTransitions
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

    const selection = mockState.publishHandoffRoutingTransitions.mock.calls[0]?.[2][0];
    const terminal = mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0];
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[0]?.[1]).toBe('/handoff/run/handoff-routing.1.db');
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
    const status = await vi.importActual<typeof HandoffRoutingStatusMod>('#src/coordinator/handoff-routing-status.js');
    mockState.publishHandoffRoutingTransitions.mockImplementation(
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
    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[0]?.[2][0]).toMatchObject({
      kind: 'routing-selected',
      disposition: {
        kind: 'continue-current',
        basis: { kind: 'incumbent-identity-unavailable', incumbent: maximumIncumbent },
      },
    });
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      selection: { kind: 'with-selection-sequence', selectionSequence: 1 },
    });

    const path = join(
      isolatedRuntime.paths.coral.coordinator.runDir,
      `handoff-routing.${status.HANDOFF_ROUTING_STATUS_GENERATION}.db`,
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
          kind: 'refused',
          refusal: {
            reason: 'owner-identity-unavailable',
            remediation: 'retry-when-process-identity-is-readable',
            attemptedPhase: 'selection',
          },
        },
      ],
    });

    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledOnce();
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[0]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      selection: { kind: 'without-selection' },
    });
  });

  it('should retain selection uncertainty together with terminal refusal', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishHandoffRoutingTransitions.mockResolvedValueOnce({
      kind: 'undeterminable',
      cause: 'io-failed',
      errcode: 5,
    });

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'recording-incidents',
      publicationIncidents: [
        { phase: 'selection', kind: 'undeterminable', cause: 'io-failed', errcode: 5 },
        {
          phase: 'terminal',
          kind: 'refused',
          refusal: { reason: 'selection-publication-undeterminable', attemptedPhase: 'terminal' },
        },
      ],
    });
    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledOnce();
  });

  it('should retain selection not-published together with terminal uncertainty', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishHandoffRoutingTransitions
      .mockResolvedValueOnce({ kind: 'not-published', cause: 'contended' })
      .mockResolvedValueOnce({ kind: 'undeterminable', cause: 'unreadable', errcode: 26 });

    await expect(runHandoffResult(cliOperation('run'), { pluginRoot: '/plugin/root' })).resolves.toMatchObject({
      kind: 'recording-incidents',
      publicationIncidents: [
        { phase: 'selection', kind: 'not-published', cause: 'contended' },
        { phase: 'terminal', kind: 'undeterminable', cause: 'unreadable', errcode: 26 },
      ],
    });
    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
      selection: { kind: 'without-selection' },
    });
  });

  it('should retain the invalid-record validation category on a publication incident', async () => {
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    mockState.publishHandoffRoutingTransitions
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
    mockState.publishHandoffRoutingTransitions.mockResolvedValue({
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
    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
  });

  it('should report a selection incident before spawning delegated work', async () => {
    const order: string[] = [];
    mockState.publishHandoffRoutingTransitions
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
    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['resolve', ['resolve', '--invocation', '123e4567-e89b-42d3-a456-426614174000']],
    ['discard', ['discard']],
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
    expect(mockState.publishHandoffRoutingTransitions).not.toHaveBeenCalled();
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
  ])('should keep lifecycle recording enabled for duplicate %s options', async (_name, options) => {
    mockState.spawn.mockImplementationOnce(() => childThatExits(0, null));

    await expect(
      runHandoffResult(cliOperation('backend', 'routing-status', 'resolve', ...options), {
        pluginRoot: '/plugin/root',
      }),
    ).resolves.toMatchObject({ kind: 'recorded' });

    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[0]?.[2][0]).toMatchObject({
      kind: 'routing-selected',
    });
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'continuation-finalized',
    });
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
    const transitions = mockState.publishHandoffRoutingTransitions.mock.calls.map((call) => call[2][0]);
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
    const selection = mockState.publishHandoffRoutingTransitions.mock.calls[0]?.[2][0];
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
      expect(mockState.publishHandoffRoutingTransitions).not.toHaveBeenCalled();
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
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
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
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
      kind: 'execution-failed',
      disposition: { kind: 'execution-failed', throwPhase: 'double-delegation-guard' },
    });
  });

  it('should bypass the CLI guard for monotone backend startup delegation and confirm liveness without exit', async () => {
    process.env[GUARD_ENV] = 'not-a-cli-guard';
    const bundleDir = roots[0];
    const target = validatedTarget(bundleDir);
    let child: ChildProcess | undefined;
    const confirmationTimer = {};
    const confirmationDelays: number[] = [];
    let confirmAlive: (() => void) | undefined;
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: async () => {},
      setTimeout: vi.fn((fn: () => void, ms: number) => {
        confirmationDelays.push(ms);
        confirmAlive = fn;
        return confirmationTimer;
      }),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => confirmationTimer),
      clearInterval: vi.fn(),
    };
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

    expect(mockState.probeCoordinator).not.toHaveBeenCalled();
    expect(mockState.health).not.toHaveBeenCalled();
    expect(mockState.spawn).toHaveBeenCalledWith(process.execPath, [join(bundleDir, 'coral-backend.cjs')], {
      cwd: '/handoff/cwd',
      env: { CORAL_BASE_ENV: 'preserved', [GUARD_ENV]: '1' },
      stdio: 'inherit',
      detached: true,
    });
    expect(time.setTimeout).toHaveBeenCalledOnce();
    expect(confirmationDelays).toHaveLength(1);
    expect(Number.isFinite(confirmationDelays[0])).toBe(true);
    expect(confirmationDelays[0]).toBeGreaterThan(0);

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    confirmAlive?.();
    await expect(result).resolves.toMatchObject({
      kind: 'delegated',
      outcome: { kind: 'handoff-success', version: manifest.version },
    });
    expect(time.clearTimeout).toHaveBeenCalledWith(confirmationTimer);
  });

  it('refuses to continue-current for a startup handoff whose stdout drain would fail', async () => {
    const bundleDir = roots[0];
    const target = validatedTarget(bundleDir);
    let child: ChildProcess | undefined;
    let confirmAlive: (() => void) | undefined;
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: async () => {},
      setTimeout: vi.fn((fn: () => void) => {
        confirmAlive = fn;
        return {};
      }),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    mockState.spawn.mockImplementationOnce(() => {
      child = childThatStaysAlive();
      return child;
    });

    const aborted = AbortSignal.abort();
    const result = runHandoff(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target, time, signal: aborted },
    );
    await vi.waitFor(() => expect(child?.unref).toHaveBeenCalledOnce());
    confirmAlive?.();

    await expect(result).resolves.toMatchObject({ kind: 'delegated' });

    // The same signal abandons a CLI handoff, which is what makes the assertion above about the operation
    // rather than about the signal.
    mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
    await expect(
      runHandoff(cliOperation('run'), { pluginRoot: '/plugin/root', activeSelectionTarget: target, signal: aborted }),
    ).resolves.toEqual({
      kind: 'run-current',
      reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
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
        namespace: 'handoff-runner',
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
    expect(mockState.publishHandoffRoutingTransitions).toHaveBeenCalledTimes(2);
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[0]?.[2][0]).toMatchObject({
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

  it.each([0, 23])(
    'should report an immediate backend startup exit with code %s when no coordinator is live',
    async (code) => {
      const target = validatedTarget(roots[0]);
      let child: ChildProcess | undefined;
      mockState.probeCoordinator.mockReturnValue({ kind: 'absent' });
      mockState.spawn.mockImplementationOnce(() => {
        child = childThatExits(code, null);
        return child;
      });

      await expect(
        runHandoff({ kind: 'backend-startup' }, { pluginRoot: '/plugin/root', activeSelectionTarget: target }),
      ).resolves.toEqual({
        kind: 'delegated',
        version: manifest.version,
        outcome: { kind: 'handoff-exit', exitCode: code },
      });
      expect(child?.unref).toHaveBeenCalledOnce();
    },
  );

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
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
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
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
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
    expect(mockState.publishHandoffRoutingTransitions.mock.calls[1]?.[2][0]).toMatchObject({
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
