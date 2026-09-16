import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCoordinatorShutdownSignalHandler,
  handoffStartupToSelectedBuild,
  main,
} from '#src/coordinator/bootstrap.js';
import { StartupStoreHandoffError } from '#src/coordinator/lifecycle.js';
import { HandoffRunError } from '#src/coordinator/handoff-routing/runner.js';
import { backendLog } from '#src/infra/backend-log.js';
import type { ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-routing/runner.js';
import type * as NodeProcessMod from '#src/infra/node-process.js';

const mockState = vi.hoisted(() => ({
  runHandoff: vi.fn(),
  createCoordinatorServer: vi.fn(),
  processIncarnationProbeRegistrySize: vi.fn(),
  snapshotProcessIncarnationProbeSubjects: vi.fn(),
  terminateProcessIncarnationProbes: vi.fn(),
}));

vi.mock('#src/coordinator/handoff-routing/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

vi.mock('#src/coordinator/index.js', () => ({
  createCoordinatorServer: mockState.createCoordinatorServer,
}));

vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeProcessMod>();
  return {
    ...actual,
    processIncarnationProbeRegistrySize: () => mockState.processIncarnationProbeRegistrySize(),
    snapshotProcessIncarnationProbeSubjects: () => mockState.snapshotProcessIncarnationProbeSubjects(),
    terminateProcessIncarnationProbes: () => mockState.terminateProcessIncarnationProbes(),
  };
});

const target = Object.freeze({}) as ValidatedHandoffTarget;
const PUBLICATION_INVOCATION_ID = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  mockState.runHandoff.mockReset();
  mockState.createCoordinatorServer.mockReset();
  mockState.processIncarnationProbeRegistrySize.mockReset().mockReturnValue(0);
  mockState.snapshotProcessIncarnationProbeSubjects.mockReset().mockReturnValue([]);
  mockState.terminateProcessIncarnationProbes.mockReset().mockResolvedValue({ disposition: 'settled' });
});

it('makes a second shutdown signal demand a nonzero exit without bypassing the in-flight join', () => {
  const inFlightJoin = new Promise<void>(() => {});
  const shutdown = vi.fn(() => inFlightJoin);
  const recordExitCode = vi.fn();
  const onRepeatedSignal = vi.fn();
  const handle = createCoordinatorShutdownSignalHandler({ shutdown, recordExitCode, onRepeatedSignal });

  handle('sigterm');
  handle('sigint');

  expect(shutdown).toHaveBeenNthCalledWith(1, 'sigterm');
  expect(shutdown).toHaveBeenNthCalledWith(2, 'sigint');
  expect(recordExitCode).toHaveBeenCalledWith(1);
  expect(onRepeatedSignal).toHaveBeenCalledOnce();
});

describe('backend bootstrap store handoff', () => {
  it('should map StartupStoreHandoffError through backend-startup handoff success', async () => {
    const error = new StartupStoreHandoffError(target);
    mockState.runHandoff.mockResolvedValue({
      kind: 'recorded',
      continuation: {
        kind: 'delegated-startup',
        version: '2.0.0',
        observation: { kind: 'serving' },
      },
      publicationIncidents: [],
    });

    await expect(handoffStartupToSelectedBuild('/plugin/root', error)).resolves.toEqual({ kind: 'started' });
    expect(mockState.runHandoff).toHaveBeenCalledWith(
      { kind: 'backend-startup' },
      {
        pluginRoot: '/plugin/root',
        activeSelectionTarget: target,
        onSelectionPublicationIncident: expect.any(Function),
      },
    );
  });

  it.each([
    {
      childEnding: { code: 23, signal: null },
      message: 'Selected backend exited during startup handoff with code 23 without taking over as the coordinator.',
      exitCode: 23,
    },
    {
      childEnding: { code: null, signal: 'SIGTERM' },
      message: 'Selected backend ended during startup handoff from signal SIGTERM.',
      exitCode: 1,
    },
    // Exiting 0 without serving is an ordinary failure to become the backend, so this process still exits
    // nonzero — while the record keeps the child's own 0, which is why nothing forces it here.
    {
      childEnding: { code: 0, signal: null },
      message: 'Selected backend exited during startup handoff with code 0 without taking over as the coordinator.',
      exitCode: 1,
    },
  ])('should map an unserved startup to bootstrap failure: $message', async ({ childEnding, message, exitCode }) => {
    mockState.runHandoff.mockResolvedValue({
      kind: 'recorded',
      continuation: { kind: 'delegated-startup', version: '2.0.0', observation: { kind: 'not-serving', childEnding } },
      publicationIncidents: [],
    });

    const result = await handoffStartupToSelectedBuild('/plugin/root', new StartupStoreHandoffError(target));

    expect(result).toMatchObject({ kind: 'failed', exitCode, error: { message } });
  });

  // The disposition `main` needs to keep away from `writeBootstrapDiagnostic`: a startup nobody observed is
  // not a startup that failed. Folding it into `failed` — the shape this replaces — hands the diagnostic,
  // sentinel and audit event a failure that was never observed.
  it('should report an unobserved startup as undetermined rather than failed', async () => {
    mockState.runHandoff.mockResolvedValue({
      kind: 'recording-incidents',
      observedWork: {
        kind: 'delegated-startup',
        version: '2.0.0',
        observation: { kind: 'undetermined', cause: 'health-request-failed' },
      },
      publicationIncidents: [
        {
          phase: 'terminal',
          invocationId: PUBLICATION_INVOCATION_ID,
          kind: 'refused',
          refusal: {
            reason: 'startup-readiness-unobserved',
            remediation: 'inspect-backend-status-before-repair',
            attemptedPhase: 'terminal',
          },
        },
      ],
    });
    vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await expect(handoffStartupToSelectedBuild('/plugin/root', new StartupStoreHandoffError(target))).resolves.toEqual({
      kind: 'undetermined',
      cause: 'health-request-failed',
    });
  });

  it('should preserve a handoff execution error for bootstrap diagnostics', async () => {
    const handoffError = new Error('spawn rejected');
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);
    mockState.runHandoff.mockRejectedValue(
      new HandoffRunError(handoffError, [
        {
          phase: 'terminal',
          invocationId: PUBLICATION_INVOCATION_ID,
          terminalDisposition: { kind: 'execution-failed', throwPhase: 'child-spawn' },
          kind: 'not-published',
          cause: 'contended',
        },
      ]),
    );

    await expect(handoffStartupToSelectedBuild('/plugin/root', new StartupStoreHandoffError(target))).resolves.toEqual({
      kind: 'failed',
      error: handoffError,
      exitCode: 1,
    });
    expect(warn).toHaveBeenCalledWith(
      'Backend startup handoff routing-status publication incident: ' +
        `{"phase":"terminal","invocationId":"${PUBLICATION_INVOCATION_ID}","terminalDisposition":{"kind":"execution-failed","throwPhase":"child-spawn"},"kind":"not-published","cause":"contended"}`,
    );
  });

  it('should log selection telemetry before startup work and finalization telemetry after it', async () => {
    const order: string[] = [];
    vi.spyOn(backendLog, 'warn').mockImplementation((message) => {
      const incident = JSON.parse(message.slice(message.indexOf('{'))) as { phase: 'selection' | 'terminal' };
      order.push(incident.phase);
    });
    mockState.runHandoff.mockImplementation(async (_operation, options) => {
      options.onSelectionPublicationIncident({
        phase: 'selection',
        invocationId: PUBLICATION_INVOCATION_ID,
        kind: 'not-published',
        cause: 'contended',
      });
      order.push('startup-work');
      return {
        kind: 'recording-incidents',
        observedWork: {
          kind: 'delegated-startup',
          version: '2.0.0',
          observation: { kind: 'serving' },
        },
        publicationIncidents: [
          {
            phase: 'selection',
            invocationId: PUBLICATION_INVOCATION_ID,
            kind: 'not-published',
            cause: 'contended',
          },
          {
            phase: 'terminal',
            invocationId: PUBLICATION_INVOCATION_ID,
            terminalDisposition: { kind: 'delegated-success', version: '2.0.0' },
            kind: 'commit-outcome-unknown',
            cause: 'io-failed',
            errcode: 5,
          },
        ],
      };
    });

    await expect(handoffStartupToSelectedBuild('/plugin/root', new StartupStoreHandoffError(target))).resolves.toEqual({
      kind: 'started',
    });
    expect(order).toEqual(['selection', 'startup-work', 'terminal']);
  });
});

describe('backend bootstrap probe cleanup', () => {
  it('renders every actionable pid and lease key when exit remains held', async () => {
    let onStopped!: () => void;
    mockState.createCoordinatorServer.mockImplementation((options: { onStopped(): void }) => {
      onStopped = options.onStopped;
      return {
        start: async () => ({ host: '127.0.0.1', port: 43123 }),
        shutdown: async () => undefined,
      };
    });
    mockState.processIncarnationProbeRegistrySize.mockReturnValue(2);
    mockState.snapshotProcessIncarnationProbeSubjects.mockReturnValue([
      { pid: 5_151 },
      { key: 'coordinator-probe:job-23' },
    ]);
    const cleanupFailure = new Error('probe termination crashed');
    mockState.terminateProcessIncarnationProbes.mockRejectedValueOnce(cleanupFailure).mockResolvedValueOnce({
      disposition: 'hold',
      unsettled: [
        {
          child: {} as never,
          pid: 5_151,
          reason: 'close-unobserved',
          exit: 'child-close',
        },
        {
          child: null,
          pid: undefined,
          key: 'coordinator-probe:job-23',
          reason: 'probe-unsettled',
          exit: 'probe-settlement',
        },
      ],
      untilSettled: new Promise<void>(() => undefined),
    });
    const errorLog = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const exitProcess = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await expect(main()).resolves.toBe(0);
    onStopped();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errorLog).toHaveBeenCalledWith(
      'Coordinator process-incarnation probe cleanup failed; exit remains held; registered subjects: ' +
        'pid=5151; key=coordinator-probe:job-23',
      cleanupFailure,
    );
    onStopped();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(errorLog).toHaveBeenCalledWith(
      'Coordinator exit remains held by unsettled process-incarnation probes: ' +
        'pid=5151 reason=close-unobserved exit=child-close; ' +
        'key=coordinator-probe:job-23 reason=probe-unsettled exit=probe-settlement',
    );
    expect(exitProcess).not.toHaveBeenCalled();
  });
});
