import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handoffStartupToSelectedBuild } from '#src/coordinator/bootstrap.js';
import { StartupStoreHandoffError } from '#src/coordinator/lifecycle.js';
import type { ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-runner.js';

const mockState = vi.hoisted(() => ({
  runHandoff: vi.fn(),
}));

vi.mock('#src/coordinator/handoff-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

const target = Object.freeze({}) as ValidatedHandoffTarget;

beforeEach(() => {
  mockState.runHandoff.mockReset();
});

describe('backend bootstrap store handoff', () => {
  it('should map StartupStoreHandoffError through backend-startup handoff success', async () => {
    const error = new StartupStoreHandoffError(target);
    mockState.runHandoff.mockResolvedValue({
      kind: 'delegated',
      outcome: { kind: 'handoff-success', version: '2.0.0' },
    });

    await expect(handoffStartupToSelectedBuild('/plugin/root', error)).resolves.toEqual({ kind: 'started' });
    expect(mockState.runHandoff).toHaveBeenCalledWith(
      { kind: 'backend-startup' },
      { pluginRoot: '/plugin/root', activeSelectionTarget: target },
    );
  });

  it.each([
    {
      continuation: { kind: 'run-current' },
      message: 'Validated active-store startup handoff did not start the selected backend.',
    },
    {
      continuation: { kind: 'delegated', outcome: { kind: 'handoff-exit', exitCode: 23 } },
      message: 'Selected backend exited during startup handoff with code 23.',
    },
    {
      continuation: { kind: 'delegated', outcome: { kind: 'handoff-signal', signal: 'SIGTERM' } },
      message: 'Selected backend exited during startup handoff from signal SIGTERM.',
    },
  ])('should map a non-success continuation to bootstrap failure: $message', async ({ continuation, message }) => {
    mockState.runHandoff.mockResolvedValue(continuation);

    const result = await handoffStartupToSelectedBuild('/plugin/root', new StartupStoreHandoffError(target));

    expect(result).toMatchObject({ kind: 'failed', error: { message } });
  });

  it('should preserve a handoff execution error for bootstrap diagnostics', async () => {
    const handoffError = new Error('spawn rejected');
    mockState.runHandoff.mockRejectedValue(handoffError);

    await expect(handoffStartupToSelectedBuild('/plugin/root', new StartupStoreHandoffError(target))).resolves.toEqual({
      kind: 'failed',
      error: handoffError,
    });
  });
});
