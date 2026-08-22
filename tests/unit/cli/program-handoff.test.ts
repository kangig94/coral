import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HandoffNoticeMod from '#src/cli/handoff-notice.js';
import type * as GenerationMutationMod from '#src/store/generation-mutation-coordination.js';
import type * as BackendStatusMod from '#src/transport/http/backend/status.js';
import type * as ProgramMod from '#src/cli/program.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-runner.js';
import { filterForwardableCoralEnv } from '#src/infra/env-sanitize.js';

const mockState = vi.hoisted(() => ({
  getBackendStatusFull: vi.fn(),
  inspectGenerationReadiness: vi.fn(),
  renderHandoffNotice: vi.fn(),
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

vi.mock('#src/cli/handoff-notice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffNoticeMod>();
  return { ...actual, renderHandoffNotice: mockState.renderHandoffNotice };
});

vi.mock('#src/cli/plugin-root.js', () => ({
  resolvePluginRoot: mockState.resolvePluginRoot,
}));

const GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';

type HandoffOutcome = HandoffRunnerMod.HandoffOutcome;
type ProgramModule = typeof ProgramMod;

function handoffSuccess(): HandoffOutcome {
  return { kind: 'handoff-success', version: '2.3.4' } as HandoffOutcome;
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
    mockState.runHandoff.mockResolvedValue({
      kind: 'run-current',
      reason: {
        kind: 'routing',
        basis: {
          kind: 'invoking-build-not-older',
          comparison: 'newer-version',
          invoking: { version: '2.0.0', buildSetId: 'invoking', bundleHash: 'invoking-hash', flavor: 'prod' },
          incumbent: { version: '1.0.0', buildSetId: 'incumbent', bundleHash: 'incumbent-hash', flavor: 'prod' },
        },
      },
    });
    const { buildProgram, parseProgramWithHandoff } = await loadProgramFresh();
    const program = buildProgram();

    await parseProgramWithHandoff(program, ['node', 'coral-cli', 'backend', 'status']);

    expect(stdout.join('')).toBe(
      [
        'Handoff: continuing current build — invoking build 2.0.0 is newer than incumbent 1.0.0.',
        'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.',
        '',
      ].join('\n'),
    );
    expect(process.exitCode).toBe(75);
  });

  it('should complete the run-current decision once before dispatching the current command', async () => {
    const order: string[] = [];
    mockState.runHandoff.mockImplementation(async () => {
      order.push('preflight');
      return { kind: 'run-current', reason: { kind: 'routing', basis: { kind: 'incumbent-absent' } } };
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
      { pluginRoot: '/plugin/root' },
    );
  });

  it('should return a successful delegated outcome and render its notice without local dispatch', async () => {
    const success = handoffSuccess();
    mockState.runHandoff.mockResolvedValue({ kind: 'delegated', outcome: success });
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
    mockState.runHandoff.mockResolvedValue({ kind: 'delegated', outcome: handoffOutcome });
    const { parseProgramWithHandoff } = await loadProgramFresh();
    const dispatch = vi.fn();

    const outcome = await parseProgramWithHandoff(commandWithAction(dispatch), ['node', 'coral-cli', 'run']);

    expect(outcome).toEqual(handoffOutcome);
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockState.renderHandoffNotice).not.toHaveBeenCalled();
  });
});
