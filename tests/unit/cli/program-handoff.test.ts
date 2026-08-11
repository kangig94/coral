import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HandoffNoticeMod from '#src/cli/handoff-notice.js';
import type * as ProgramMod from '#src/cli/program.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-runner.js';
import { filterForwardableCoralEnv } from '#src/infra/env-sanitize.js';

const mockState = vi.hoisted(() => ({
  renderHandoffNotice: vi.fn(),
  resolvePluginRoot: vi.fn(),
  runHandoff: vi.fn(),
}));

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
  mockState.renderHandoffNotice.mockReset();
  mockState.resolvePluginRoot.mockReset().mockReturnValue('/plugin/root');
  mockState.runHandoff.mockReset();
});

describe('program', () => {
  it('should complete the run-current decision once before dispatching the current command', async () => {
    const order: string[] = [];
    mockState.runHandoff.mockImplementation(async () => {
      order.push('preflight');
      return { kind: 'run-current' };
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
