import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handoffStartupToSelectedBuild } from '#src/coordinator/bootstrap.js';
import { StartupStoreHandoffError } from '#src/coordinator/lifecycle.js';
import { HandoffRunError } from '#src/coordinator/handoff-routing/runner.js';
import { backendLog } from '#src/infra/backend-log.js';
import type { ValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import type * as HandoffRunnerMod from '#src/coordinator/handoff-routing/runner.js';

const mockState = vi.hoisted(() => ({
  runHandoff: vi.fn(),
}));

vi.mock('#src/coordinator/handoff-routing/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffRunnerMod>();
  return { ...actual, runHandoff: mockState.runHandoff };
});

const target = Object.freeze({}) as ValidatedHandoffTarget;
const PUBLICATION_INVOCATION_ID = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  mockState.runHandoff.mockReset();
});

describe('backend bootstrap store handoff', () => {
  it('should map StartupStoreHandoffError through backend-startup handoff success', async () => {
    const error = new StartupStoreHandoffError(target);
    mockState.runHandoff.mockResolvedValue({
      kind: 'recorded',
      continuation: {
        kind: 'delegated',
        version: '2.0.0',
        outcome: { kind: 'handoff-success', version: '2.0.0' },
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
      continuation: {
        kind: 'recorded',
        continuation: { kind: 'delegated', version: '2.0.0', outcome: { kind: 'handoff-exit', exitCode: 23 } },
        publicationIncidents: [],
      },
      message: 'Selected backend exited during startup handoff with code 23.',
    },
    {
      continuation: {
        kind: 'recorded',
        continuation: {
          kind: 'delegated',
          version: '2.0.0',
          outcome: { kind: 'handoff-signal', signal: 'SIGTERM' },
        },
        publicationIncidents: [],
      },
      message: 'Selected backend exited during startup handoff from signal SIGTERM.',
    },
  ])('should map a non-success continuation to bootstrap failure: $message', async ({ continuation, message }) => {
    mockState.runHandoff.mockResolvedValue(continuation);

    const result = await handoffStartupToSelectedBuild('/plugin/root', new StartupStoreHandoffError(target));

    expect(result).toMatchObject({ kind: 'failed', error: { message } });
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
          kind: 'delegated',
          version: '2.0.0',
          outcome: { kind: 'handoff-success', version: '2.0.0' },
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
            kind: 'undeterminable',
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
