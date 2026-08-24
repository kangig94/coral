import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HandoffNoticeMod from '#src/cli/handoff-notice.js';
import type * as GenerationMutationMod from '#src/store/generation-mutation-coordination.js';
import type * as BackendStatusMod from '#src/transport/http/backend/status.js';
import type * as ProgramMod from '#src/cli/program.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-runner.js';
import type * as HandoffRoutingStatusMod from '#src/coordinator/handoff-routing-status.js';
import { filterForwardableCoralEnv } from '#src/infra/env-sanitize.js';

const mockState = vi.hoisted(() => ({
  getBackendStatusFull: vi.fn(),
  inspectGenerationReadiness: vi.fn(),
  renderHandoffNotice: vi.fn(),
  readHandoffRoutingStatusWithOwnerObservations: vi.fn(),
  resolvePluginRoot: vi.fn(),
  runHandoff: vi.fn(),
}));

vi.mock('#src/store/generation-mutation-coordination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GenerationMutationMod>();
  return { ...actual, inspectGenerationReadiness: mockState.inspectGenerationReadiness };
});

vi.mock('#src/transport/http/backend/status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendStatusMod>();
  return { ...actual, getBackendStatusFull: mockState.getBackendStatusFull };
});

vi.mock('#src/coordinator/handoff-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

vi.mock('#src/coordinator/handoff-routing-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRoutingStatusMod>();
  return {
    ...actual,
    readHandoffRoutingStatusWithOwnerObservations: mockState.readHandoffRoutingStatusWithOwnerObservations,
  };
});

vi.mock('#src/cli/handoff-notice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffNoticeMod>();
  return { ...actual, renderHandoffNotice: mockState.renderHandoffNotice };
});

vi.mock('#src/cli/plugin-root.js', () => ({
  resolvePluginRoot: mockState.resolvePluginRoot,
}));

const GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';
const PUBLICATION_INVOCATION_ID = '123e4567-e89b-42d3-a456-426614174000';

type HandoffOutcome = HandoffRunnerMod.HandoffOutcome;
type HandoffContinuationResult = HandoffRunnerMod.HandoffContinuationResult;
type ProgramModule = typeof ProgramMod;

function handoffSuccess(): HandoffOutcome {
  return { kind: 'handoff-success', version: '2.3.4' } as HandoffOutcome;
}

function terminalIncident(terminalDisposition: HandoffRoutingStatusMod.DirectTerminalDisposition) {
  return { phase: 'terminal' as const, invocationId: PUBLICATION_INVOCATION_ID, terminalDisposition };
}

function recorded(continuation: HandoffContinuationResult): HandoffRunnerMod.HandoffRunResult {
  return { kind: 'recorded', continuation, publicationIncidents: [] };
}

function commandWithAction(action: () => void): Command {
  const program = new Command();
  program.exitOverride();
  program.command('run').action(action);
  return program;
}

async function loadProgramFresh(): Promise<ProgramModule> {
  vi.resetModules();
  return import('#src/cli/program.js');
}

beforeEach(() => {
  process.exitCode = undefined;
  mockState.getBackendStatusFull.mockReset().mockResolvedValue({ status: 'not_running' });
  mockState.inspectGenerationReadiness.mockReset().mockReturnValue({ kind: 'no-legacy' });
  mockState.renderHandoffNotice.mockReset();
  mockState.readHandoffRoutingStatusWithOwnerObservations.mockReset().mockResolvedValue({ kind: 'absent' });
  mockState.resolvePluginRoot.mockReset().mockReturnValue('/plugin/root');
  mockState.runHandoff.mockReset();
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('program', () => {
  it('should omit a live handoff line when the production status action runs before preflight', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write);
    const { buildProgram } = await loadProgramFresh();

    await buildProgram().parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout.join('')).toBe(
      'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.\n',
    );
  });

  it('should expose the completed preflight to the production status action', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write);
    mockState.runHandoff.mockResolvedValue(
      recorded({
        kind: 'run-current',
        reason: {
          kind: 'routing',
          basis: {
            kind: 'invoking-build-not-older',
            comparison: 'newer-version',
            invoking: { version: '0.10.8', buildSetId: 'invoking', bundleHash: 'invoking-hash', flavor: 'prod' },
            incumbent: { version: '0.10.6', buildSetId: 'incumbent', bundleHash: 'incumbent-hash', flavor: 'prod' },
          },
        },
      }),
    );
    const { buildProgram, parseProgramWithHandoff } = await loadProgramFresh();
    const program = buildProgram();

    await parseProgramWithHandoff(program, ['node', 'coral-cli', 'backend', 'status']);

    expect(stdout.join('')).toBe(
      [
        'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.',
        'Handoff: continuing current build — invoking build 0.10.8 is newer than incumbent 0.10.6.',
        'Next step: run coral-cli backend shutdown, then rerun a mutating command to relaunch from this installation.',
        '',
      ].join('\n'),
    );
    expect(process.exitCode).toBe(75);
  });

  it('should retain a local status publication incident through production dispatch', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockState.runHandoff.mockResolvedValue({
      kind: 'recording-incidents',
      observedWork: {
        kind: 'run-current',
        reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } },
      },
      publicationIncidents: [
        {
          phase: 'selection',
          invocationId: PUBLICATION_INVOCATION_ID,
          kind: 'not-published',
          cause: 'contended',
        },
      ],
    });
    const { buildProgram, parseProgramWithHandoff } = await loadProgramFresh();

    await parseProgramWithHandoff(buildProgram(), ['node', 'coral-cli', 'backend', 'status']);

    expect(process.exitCode).toBe(75);
  });

  it('should complete the run-current decision once before dispatching the current command', async () => {
    const order: string[] = [];
    mockState.runHandoff.mockImplementation(async () => {
      order.push('preflight');
      return recorded({ kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } });
    });
    const { parseProgramWithHandoff, runCliHandoffPreflight } = await loadProgramFresh();
    const program = commandWithAction(() => order.push('dispatch'));

    const outcome = await parseProgramWithHandoff(program, ['node', 'coral-cli', 'run']);
    const repeated = await runCliHandoffPreflight(['node', 'coral-cli', 'ignored']);

    expect(outcome).toBeNull();
    expect(repeated).toBeNull();
    expect(order).toEqual(['preflight', 'dispatch']);
    expect(mockState.runHandoff).toHaveBeenCalledOnce();
    expect(mockState.runHandoff).toHaveBeenCalledWith(
      { kind: 'cli-invocation', argv: ['node', 'coral-cli', 'run'] },
      { pluginRoot: '/plugin/root', onSelectionPublicationIncident: expect.any(Function) },
    );
  });

  it('should return a successful delegated outcome and render its notice without local dispatch', async () => {
    const success = handoffSuccess();
    mockState.runHandoff.mockResolvedValue(recorded({ kind: 'delegated', version: '2.3.4', outcome: success }));
    const { parseProgramWithHandoff, runCliHandoffPreflight } = await loadProgramFresh();
    const dispatch = vi.fn();
    const argv = ['node', 'coral-cli', 'backend', 'status'];

    const outcome = await parseProgramWithHandoff(commandWithAction(dispatch), argv);
    const repeated = await runCliHandoffPreflight(['node', 'coral-cli', 'ignored']);

    expect(outcome).toBe(success);
    expect(repeated).toBe(success);
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockState.runHandoff).toHaveBeenCalledOnce();
    expect(mockState.runHandoff).toHaveBeenCalledWith({ kind: 'cli-invocation', argv }, { pluginRoot: '/plugin/root' });
    expect(mockState.renderHandoffNotice).toHaveBeenCalledOnce();
    expect(mockState.renderHandoffNotice).toHaveBeenCalledWith(success);
    expect(filterForwardableCoralEnv({ [GUARD_ENV]: '1' })).toEqual({ [GUARD_ENV]: '1' });
  });

  it.each<HandoffOutcome>([
    { kind: 'handoff-exit', exitCode: 23 },
    { kind: 'handoff-signal', signal: 'SIGTERM' },
  ])('should return $kind without a notice or local dispatch', async (handoffOutcome) => {
    mockState.runHandoff.mockResolvedValue(recorded({ kind: 'delegated', version: '2.3.4', outcome: handoffOutcome }));
    const { parseProgramWithHandoff } = await loadProgramFresh();
    const dispatch = vi.fn();

    const outcome = await parseProgramWithHandoff(commandWithAction(dispatch), ['node', 'coral-cli', 'run']);

    expect(outcome).toEqual(handoffOutcome);
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockState.renderHandoffNotice).not.toHaveBeenCalled();
  });

  it.each([
    {
      childOutcome: { kind: 'handoff-success' as const, version: '2.3.4' },
      publicationIncidents: [
        {
          ...terminalIncident({ kind: 'delegated-success', version: '2.3.4' }),
          kind: 'not-published',
          cause: 'contended',
        },
      ] as const,
      expectedExit: 75,
    },
    {
      childOutcome: { kind: 'handoff-success' as const, version: '2.3.4' },
      publicationIncidents: [
        {
          ...terminalIncident({ kind: 'delegated-success', version: '2.3.4' }),
          kind: 'not-published',
          cause: 'contended',
        },
        {
          ...terminalIncident({ kind: 'delegated-success', version: '2.3.4' }),
          kind: 'not-published',
          cause: 'invalid-record',
          validation: { kind: 'schema-violation' },
        },
      ] as const,
      expectedExit: 70,
    },
    {
      childOutcome: { kind: 'handoff-exit' as const, exitCode: 69 },
      publicationIncidents: [
        {
          ...terminalIncident({ kind: 'delegated-exit', version: '2.3.4', exitCode: 69 }),
          kind: 'not-published',
          cause: 'contended',
        },
      ] as const,
      expectedExit: 69,
    },
    {
      childOutcome: { kind: 'handoff-exit' as const, exitCode: 70 },
      publicationIncidents: [
        {
          ...terminalIncident({ kind: 'delegated-exit', version: '2.3.4', exitCode: 70 }),
          kind: 'not-published',
          cause: 'contended',
        },
      ] as const,
      expectedExit: 70,
    },
    {
      childOutcome: { kind: 'handoff-exit' as const, exitCode: 77 },
      publicationIncidents: [
        {
          ...terminalIncident({ kind: 'delegated-exit', version: '2.3.4', exitCode: 77 }),
          kind: 'not-published',
          cause: 'contended',
        },
      ] as const,
      expectedExit: 77,
    },
  ])(
    'should preserve delegated status exit arbitration at $expectedExit',
    async ({ childOutcome, publicationIncidents, expectedExit }) => {
      let stderr = '';
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      }) as typeof process.stderr.write);
      mockState.runHandoff.mockResolvedValue({
        kind: 'recording-incidents',
        observedWork: { kind: 'delegated', version: '2.3.4', outcome: childOutcome },
        publicationIncidents,
      });
      const { parseProgramWithHandoff } = await loadProgramFresh();

      const outcome = await parseProgramWithHandoff(commandWithAction(vi.fn()), [
        'node',
        'coral-cli',
        'backend',
        'status',
      ]);

      expect(outcome).toEqual(
        expectedExit === 75 ? { kind: 'handoff-exit', exitCode: 75 } : { kind: 'handoff-exit', exitCode: expectedExit },
      );
      expect(stderr).toContain(
        `Handoff routing-status terminal publication for invocation ${PUBLICATION_INVOCATION_ID} was not published (contended).`,
      );
      expect(stderr).toContain(
        `Next step: rerun coral-cli backend status; if routing invocation ${PUBLICATION_INVOCATION_ID} is still unresolved, run coral-cli backend routing-status resolve --invocation ${PUBLICATION_INVOCATION_ID}. The operation finished; do not rerun it.`,
      );
    },
  );

  it('should append delegated status publication notices after the child exits', async () => {
    const order: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((() => {
      order.push('parent-notice');
      return true;
    }) as typeof process.stderr.write);
    mockState.runHandoff.mockImplementation(async () => {
      order.push('child-exit');
      return {
        kind: 'recording-incidents',
        observedWork: {
          kind: 'delegated',
          version: '2.3.4',
          outcome: { kind: 'handoff-success', version: '2.3.4' },
        },
        publicationIncidents: [
          {
            phase: 'selection',
            invocationId: PUBLICATION_INVOCATION_ID,
            kind: 'not-published',
            cause: 'contended',
          },
        ],
      };
    });
    const { parseProgramWithHandoff } = await loadProgramFresh();

    await parseProgramWithHandoff(commandWithAction(vi.fn()), ['node', 'coral-cli', 'backend', 'status']);

    expect(order).toEqual(['child-exit', 'parent-notice']);
  });
});
