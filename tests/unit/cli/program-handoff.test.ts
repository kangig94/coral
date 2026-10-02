import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HandoffNoticeMod from '#src/cli/handoff-notice.js';
import type * as GenerationMutationMod from '#src/store/generation-mutation-coordination.js';
import type * as BackendStatusMod from '#src/cli/backend-status.js';
import type * as ProgramMod from '#src/cli/program.js';
import type * as BackendCommandMod from '#src/cli/commands/backend.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-routing/runner.js';
import type * as HandoffRoutingStatusMod from '#src/coordinator/handoff-routing/status.js';
import { filterForwardableCoralEnv } from '#src/infra/env-sanitize.js';
import { executeRenderedCommand } from '#tests/helpers/rendered-command.js';

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

vi.mock('#src/cli/backend-status.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendStatusMod>();
  return { ...actual, getBackendStatusFull: mockState.getBackendStatusFull };
});

vi.mock('#src/cli/commands/backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendCommandMod>();
  const createBackendStatusCommandOperations: typeof actual.createBackendStatusCommandOperations = (...args) => ({
    ...actual.createBackendStatusCommandOperations(...args),
    readProviderProxySetHolderStatusDirect: async () => [],
  });
  return { ...actual, createBackendStatusCommandOperations };
});

vi.mock('#src/coordinator/handoff-routing/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

vi.mock('#src/coordinator/handoff-routing/status.js', async (importOriginal) => {
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

type HandoffOutcome = HandoffRunnerMod.HandoffOutcome;
type HandoffContinuationResult = HandoffRunnerMod.DelegatingHandoffContinuation;
type ProgramModule = typeof ProgramMod;

function handoffSuccess(): HandoffOutcome {
  return { kind: 'handoff-success', version: '2.3.4' } as HandoffOutcome;
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

function shutdownCommandProgram(dispatched: string[]): Command {
  const program = new Command();
  program.exitOverride();
  program
    .command('backend')
    .command('shutdown')
    .action(() => {
      dispatched.push('shutdown');
    });
  return program;
}

async function loadProgramFresh(): Promise<ProgramModule> {
  vi.resetModules();
  return import('#src/cli/program.js');
}

beforeEach(() => {
  process.exitCode = undefined;
  mockState.getBackendStatusFull.mockReset().mockResolvedValue({ status: 'no_record_no_socket' });
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

    const rendered = stdout.join('');
    expect(rendered).toBe(
      [
        'No coordinator discovery record and no coordinator socket at the current expected address were found. Run the start command below; it attempts startup.\ncommand=coral-cli backend start',
        'Handoff: continuing current build — invoking build 0.10.8 is newer than incumbent 0.10.6.',
        'Handoff hold: run the shutdown command below, then the start command below it; that attempts startup or handoff from this installation.',
        'command=coral-cli backend shutdown',
        'command=coral-cli backend start',
        '',
      ].join('\n'),
    );
    const dispatched: string[] = [];
    await executeRenderedCommand(shutdownCommandProgram(dispatched), rendered, {
      label: 'command',
      includes: 'backend shutdown',
    });
    expect(dispatched).toEqual(['shutdown']);
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
});
