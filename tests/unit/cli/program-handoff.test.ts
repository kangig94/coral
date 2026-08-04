import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HandoffRunnerMod from '#src/coordinator/handoff-runner.js';
import type * as ProgramMod from '#src/cli/program.js';
import type * as HandoffNoticeMod from '#src/cli/handoff-notice.js';
import type { BackendRoutingResult } from '#src/infra/backend-routing.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import { filterForwardableCoralEnv } from '#src/infra/env-sanitize.js';
import type { ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import type * as RuntimeMod from '#src/runtime/real.js';

const mockState = vi.hoisted(() => ({
  createRealRuntime: vi.fn(),
  ensure: vi.fn(),
  probeCoordinator: vi.fn(),
  renderHandoffNotice: vi.fn(),
  resolveCliHandoffPreflightRouting: vi.fn(),
  runHandoff: vi.fn(),
}));

vi.mock('#src/coordinator/handoff-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return {
    ...actual,
    resolveCliHandoffPreflightRouting: mockState.resolveCliHandoffPreflightRouting,
    runHandoff: mockState.runHandoff,
  };
});

vi.mock('#src/infra/backend-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendDiscoveryMod>();
  return { ...actual, probeCoordinator: mockState.probeCoordinator };
});

vi.mock('#src/transport/ipc/ensure.js', () => ({ ensure: mockState.ensure }));

vi.mock('#src/runtime/real.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeMod>();
  return { ...actual, createRealRuntime: mockState.createRealRuntime };
});

vi.mock('#src/cli/handoff-notice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffNoticeMod>();
  return { ...actual, renderHandoffNotice: mockState.renderHandoffNotice };
});

const GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';
const originalGuard = process.env[GUARD_ENV];
const originalFlavor = process.env.CORAL_FLAVOR;
const target = Object.freeze({}) as unknown as ValidatedHandoffTarget;
const runtime = Object.freeze({ marker: 'runtime' });

type HandoffOutcome = HandoffRunnerMod.HandoffOutcome;
type ProgramModule = typeof ProgramMod;

function useCurrentRouting(): BackendRoutingResult {
  return { kind: 'use-current', evidence: { source: 'current-build' } };
}

function resetNewerInvalidRouting(): BackendRoutingResult {
  return {
    kind: 'reset-newer-invalid',
    evidence: { failure: 'manifest-missing' },
  } as unknown as BackendRoutingResult;
}

function handoffRouting(): BackendRoutingResult {
  return { kind: 'handoff', target, source: 'live-incumbent' };
}

function handoffSuccess(): HandoffOutcome {
  return { kind: 'handoff-success', version: '2.3.4' } as unknown as HandoffOutcome;
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
  delete process.env[GUARD_ENV];
  delete process.env.CORAL_FLAVOR;
  mockState.createRealRuntime.mockReset().mockReturnValue(runtime);
  mockState.ensure.mockReset();
  mockState.probeCoordinator.mockReset();
  mockState.renderHandoffNotice.mockReset();
  mockState.resolveCliHandoffPreflightRouting.mockReset();
  mockState.runHandoff.mockReset();
});

afterEach(() => {
  if (originalGuard === undefined) {
    delete process.env[GUARD_ENV];
  } else {
    process.env[GUARD_ENV] = originalGuard;
  }
  if (originalFlavor === undefined) {
    delete process.env.CORAL_FLAVOR;
  } else {
    process.env.CORAL_FLAVOR = originalFlavor;
  }
});

describe('program', () => {
  it.each([
    ['use-current', useCurrentRouting],
    ['reset-newer-invalid', resetNewerInvalidRouting],
  ])('should complete the %s pre-flight before dispatching the current command', async (_kind, routing) => {
    const order: string[] = [];
    mockState.resolveCliHandoffPreflightRouting.mockImplementation(async () => {
      order.push('preflight');
      return routing();
    });
    const { parseProgramWithHandoff, runCliHandoffPreflight } = await loadProgramFresh();
    const program = commandWithAction(() => order.push('dispatch'));

    const outcome = await parseProgramWithHandoff(program, ['node', 'coral-cli', 'run']);
    const repeated = await runCliHandoffPreflight(['node', 'coral-cli', 'ignored']);

    expect(outcome).toBeNull();
    expect(repeated).toBeNull();
    expect(order).toEqual(['preflight', 'dispatch']);
    expect(mockState.resolveCliHandoffPreflightRouting).toHaveBeenCalledOnce();
    expect(mockState.runHandoff).not.toHaveBeenCalled();
  });

  it('should not ensure or spawn a coordinator when no live incumbent is discoverable', async () => {
    const actualRunner = await vi.importActual<typeof HandoffRunnerMod>('#src/coordinator/handoff-runner.js');
    mockState.probeCoordinator.mockReturnValue(null);
    mockState.resolveCliHandoffPreflightRouting.mockImplementation(actualRunner.resolveCliHandoffPreflightRouting);
    const { parseProgramWithHandoff } = await loadProgramFresh();
    const dispatch = vi.fn();

    const outcome = await parseProgramWithHandoff(commandWithAction(dispatch), ['node', 'coral-cli', 'run']);

    expect(outcome).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(mockState.probeCoordinator).toHaveBeenCalledOnce();
    expect(mockState.ensure).not.toHaveBeenCalled();
    expect(mockState.runHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', undefined],
    ['zero', '0'],
  ])('should delegate once when the CLI guard is %s and propagate one', async (_label, guard) => {
    if (guard !== undefined) {
      process.env[GUARD_ENV] = guard;
    }
    const success = handoffSuccess();
    mockState.resolveCliHandoffPreflightRouting.mockResolvedValue(handoffRouting());
    mockState.runHandoff.mockResolvedValue(success);
    const { CLI_HANDOFF_GUARD_ENV, parseProgramWithHandoff, runCliHandoffPreflight } = await loadProgramFresh();
    const dispatch = vi.fn();

    const outcome = await parseProgramWithHandoff(commandWithAction(dispatch), [
      'node',
      'coral-cli',
      'backend',
      'status',
    ]);
    const repeated = await runCliHandoffPreflight(['node', 'coral-cli', 'ignored']);

    expect(CLI_HANDOFF_GUARD_ENV).toBe(GUARD_ENV);
    expect(outcome).toBe(success);
    expect(repeated).toBe(success);
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockState.resolveCliHandoffPreflightRouting).toHaveBeenCalledOnce();
    expect(mockState.runHandoff).toHaveBeenCalledOnce();
    expect(mockState.runHandoff).toHaveBeenCalledWith({
      runtime,
      target,
      operation: {
        entrypoint: 'cli',
        args: ['backend', 'status'],
        envAdditions: { [GUARD_ENV]: '1' },
      },
    });
    expect(mockState.runHandoff.mock.calls[0]?.[0]).not.toHaveProperty('releaseCanonicalSocket');
    expect(mockState.renderHandoffNotice).toHaveBeenCalledOnce();
    expect(mockState.renderHandoffNotice).toHaveBeenCalledWith(success);
    expect(filterForwardableCoralEnv({ [CLI_HANDOFF_GUARD_ENV]: '1' })).toEqual({ [GUARD_ENV]: '1' });
  });

  it.each<HandoffOutcome>([
    { kind: 'handoff-exit', exitCode: 23 },
    { kind: 'handoff-signal', signal: 'SIGTERM' },
  ])('should return $kind without a notice or local dispatch', async (handoffOutcome) => {
    mockState.resolveCliHandoffPreflightRouting.mockResolvedValue(handoffRouting());
    mockState.runHandoff.mockResolvedValue(handoffOutcome);
    const { parseProgramWithHandoff } = await loadProgramFresh();
    const dispatch = vi.fn();

    const outcome = await parseProgramWithHandoff(commandWithAction(dispatch), ['node', 'coral-cli', 'run']);

    expect(outcome).toEqual(handoffOutcome);
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockState.renderHandoffNotice).not.toHaveBeenCalled();
  });

  it('should reject a second delegated CLI handoff', async () => {
    process.env[GUARD_ENV] = '1';
    mockState.resolveCliHandoffPreflightRouting.mockResolvedValue(handoffRouting());
    const { runCliHandoffPreflight } = await loadProgramFresh();

    await expect(runCliHandoffPreflight()).rejects.toThrow(/already delegated once/u);
    await expect(runCliHandoffPreflight()).rejects.toThrow(/coral-cli backend status/u);

    expect(mockState.resolveCliHandoffPreflightRouting).toHaveBeenCalledOnce();
    expect(mockState.runHandoff).not.toHaveBeenCalled();
  });

  it.each(['', '2', '01', ' 1 ', 'true'])('should reject invalid CLI guard value %j at ingress', async (guard) => {
    process.env[GUARD_ENV] = guard;
    const { runCliHandoffPreflight } = await loadProgramFresh();

    // A raw ZodError would reach the user as a `code=internal` dump of issue JSON that never names the
    // variable; the guard must fail as invalid usage that says what to set instead.
    // Matched by name, not `instanceof`: `loadProgramFresh` resets modules, so the class the fresh program
    // throws is a different realm's `UsageError` than a static import would hold.
    await expect(runCliHandoffPreflight()).rejects.toMatchObject({ name: 'UsageError' });
    await expect(runCliHandoffPreflight()).rejects.toThrow(GUARD_ENV);

    expect(mockState.resolveCliHandoffPreflightRouting).not.toHaveBeenCalled();
    expect(mockState.runHandoff).not.toHaveBeenCalled();
  });

  it.each([['--help'], ['-h'], ['--version']])(
    'should not probe an incumbent for the display-only invocation %s',
    async (flag) => {
      const { runCliHandoffPreflight } = await loadProgramFresh();

      // `--help` produces no backend work, so delegating it buys nothing and would charge users an incumbent
      // health probe on the path they expect to be instant.
      await expect(runCliHandoffPreflight(['node', 'coral-cli', flag])).resolves.toBeNull();

      expect(mockState.resolveCliHandoffPreflightRouting).not.toHaveBeenCalled();
      expect(mockState.runHandoff).not.toHaveBeenCalled();
    },
  );
});
