import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBackendCommands, type HandoffRoutingStatusCommandOperations } from '#src/cli/commands/backend.js';
import { formatHandoffRoutingResolveResult } from '#src/cli/format/backend.js';
import { parseHandoffRepairOperation } from '#src/coordinator/handoff-repair-operation.js';
import type { HandoffRoutingResolveResult } from '#src/coordinator/handoff-routing-status.js';

const INVOCATION_ID = '123e4567-e89b-42d3-a456-426614174000';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('backend routing-status resolve grammar', () => {
  it.each([
    ['separated', ['backend', 'routing-status', 'resolve', '--invocation', INVOCATION_ID]],
    ['equals', ['backend', 'routing-status', 'resolve', `--invocation=${INVOCATION_ID}`]],
    [
      'force after invocation',
      ['backend', 'routing-status', 'resolve', '--invocation', INVOCATION_ID, '--force-unobservable'],
    ],
    [
      'force before invocation',
      ['backend', 'routing-status', 'resolve', '--force-unobservable', `--invocation=${INVOCATION_ID}`],
    ],
  ])('parses %s syntax', (_name, tokens) => {
    expect(parseHandoffRepairOperation(['node', 'coral-cli', ...tokens])).toEqual({
      kind: 'routing-status-resolve',
      invocationId: INVOCATION_ID,
      forceUnobservable: tokens.includes('--force-unobservable'),
    });
  });

  it.each([
    ['missing invocation', []],
    ['missing separated value', ['--invocation']],
    ['option as separated value', ['--invocation', '--force-unobservable']],
    ['unknown option', ['--invocation', INVOCATION_ID, '--unknown']],
    ['unknown operand', ['--invocation', INVOCATION_ID, 'extra']],
    ['noncanonical invocation', ['--invocation', INVOCATION_ID.toUpperCase()]],
    ['duplicate separated invocation', ['--invocation', INVOCATION_ID, '--invocation', INVOCATION_ID]],
    [
      'duplicate mixed invocation',
      [`--invocation=${INVOCATION_ID}`, '--invocation', '223e4567-e89b-42d3-a456-426614174000'],
    ],
    ['duplicate force', ['--invocation', INVOCATION_ID, '--force-unobservable', '--force-unobservable']],
  ])('rejects %s', (_name, options) => {
    expect(
      parseHandoffRepairOperation(['node', 'coral-cli', 'backend', 'routing-status', 'resolve', ...options]),
    ).toBeNull();
  });

  it('is bidirectionally equivalent to the registered Commander action', async () => {
    const secondInvocationId = '223e4567-e89b-42d3-a456-426614174000';
    const cases = [
      ['--invocation', INVOCATION_ID],
      [`--invocation=${INVOCATION_ID}`],
      ['--force-unobservable', '--invocation', INVOCATION_ID],
      ['--invocation', INVOCATION_ID, '--force-unobservable'],
      ['--invocation', INVOCATION_ID, '--invocation', INVOCATION_ID],
      [`--invocation=${INVOCATION_ID}`, '--invocation', secondInvocationId],
      ['--invocation', INVOCATION_ID, '--force-unobservable', '--force-unobservable'],
      [],
      ['--invocation'],
      ['--invocation', '--force-unobservable'],
      ['--invocation', INVOCATION_ID, '--'],
      ['--invocation', INVOCATION_ID, '--unknown'],
      ['--invocation', INVOCATION_ID, 'extra'],
      ['--invocation', INVOCATION_ID.toUpperCase()],
    ];

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    for (const options of cases) {
      const argv = ['node', 'coral-cli', 'backend', 'routing-status', 'resolve', ...options];
      const parsed = parseHandoffRepairOperation(argv);
      const requests: unknown[] = [];
      const routingStatus: HandoffRoutingStatusCommandOperations = {
        resolve: async (request) => {
          requests.push(request);
          return {
            kind: 'resolved',
            invocationId: request.invocationId,
            reason: 'owner-absent',
            sequence: 1,
          };
        },
        discard: () => ({ kind: 'refused', status: { kind: 'absent' } }),
      };
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => undefined });
      registerBackendCommands(program, { routingStatus });
      await program.parseAsync(argv).catch(() => undefined);
      expect(requests, options.join(' ')).toEqual(parsed === null ? [] : [parsed]);
      process.exitCode = undefined;
    }
  });

  it('documents the force override safety precondition in command help', () => {
    const program = new Command();
    registerBackendCommands(program, {
      routingStatus: {
        resolve: async () => {
          throw new Error('not used');
        },
        discard: async () => ({ kind: 'refused', status: { kind: 'absent' } }),
      },
    });
    const backend = program.commands.find((command) => command.name() === 'backend');
    const routingStatus = backend?.commands.find((command) => command.name() === 'routing-status');
    const resolve = routingStatus?.commands.find((command) => command.name() === 'resolve');

    const help = resolve?.helpInformation();
    expect(help).toContain('Default: false; requires external owner verification');
    expect(help).toContain('cannot override deadline-expired');
  });

  it.each<Readonly<{ result: HandoffRoutingResolveResult; exitCode: 0 | 1 | 75 }>>([
    {
      result: { kind: 'resolved', invocationId: INVOCATION_ID, reason: 'owner-absent', sequence: 1 },
      exitCode: 0,
    },
    { result: { kind: 'already-terminal', invocationId: INVOCATION_ID }, exitCode: 0 },
    { result: { kind: 'stale', invocationId: INVOCATION_ID }, exitCode: 1 },
    { result: { kind: 'live-owner', invocationId: INVOCATION_ID }, exitCode: 1 },
    {
      result: { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'deadline-expired' },
      exitCode: 75,
    },
    {
      result: { kind: 'status-unavailable', status: { kind: 'unreadable', reason: 'invalid-shape' } },
      exitCode: 75,
    },
    {
      result: { kind: 'not-published', outcome: { kind: 'not-published', cause: 'contended' } },
      exitCode: 75,
    },
  ])('maps $result.kind to command exit $exitCode', async ({ result, exitCode }) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const routingStatus: HandoffRoutingStatusCommandOperations = {
      resolve: async () => result,
      discard: async () => ({ kind: 'refused', status: { kind: 'absent' } }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatus });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'routing-status',
      'resolve',
      '--invocation',
      INVOCATION_ID,
    ]);

    expect(process.exitCode).toBe(exitCode);
    expect(exitCode === 0 ? stdout : stderr).toHaveBeenCalledWith(`${formatHandoffRoutingResolveResult(result)}\n`);
  });

  it.each<readonly [HandoffRoutingResolveResult, string]>([
    [{ kind: 'stale', invocationId: INVOCATION_ID }, 'copy an invocation still shown as unresolved'],
    [{ kind: 'already-terminal', invocationId: INVOCATION_ID }, 'No resolution is needed'],
    [{ kind: 'live-owner', invocationId: INVOCATION_ID }, 'wait for the owner to finish'],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'incarnation-unavailable' },
      'verify the owner externally',
    ],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'probe-not-available' },
      'verify the owner externally',
    ],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'probe-failed' },
      'verify the owner externally',
    ],
    [
      { kind: 'unauthorized-unobservable', invocationId: INVOCATION_ID, cause: 'deadline-expired' },
      'cannot override an expired observation budget',
    ],
    [{ kind: 'status-unavailable', status: { kind: 'unreadable', reason: 'invalid-json' } }, 'discard command'],
    [{ kind: 'status-unavailable', status: { kind: 'unsupported-generation', generation: 2 } }, 'discard command'],
    [
      { kind: 'status-unavailable', status: { kind: 'undeterminable', cause: 'io-failed', errcode: 5 } },
      'without discarding',
    ],
    [{ kind: 'not-published', outcome: { kind: 'not-published', cause: 'contended' } }, 'retry this resolve command'],
    [
      { kind: 'not-published', outcome: { kind: 'not-published', cause: 'generation-maintenance' } },
      'wait for generation maintenance to finish',
    ],
    [
      { kind: 'not-published', outcome: { kind: 'not-published', cause: 'capacity-exhausted' } },
      'storage-capacity condition',
    ],
    [
      { kind: 'not-published', outcome: { kind: 'not-published', cause: 'rejected-transition' } },
      'do not assume resolution occurred',
    ],
    [
      { kind: 'not-published', outcome: { kind: 'undeterminable', cause: 'io-failed', errcode: 5 } },
      'could not determine whether it committed',
    ],
    [
      { kind: 'not-published', outcome: { kind: 'undeterminable', cause: 'unreadable', errcode: 26 } },
      'if the journal is unreadable',
    ],
    [
      { kind: 'not-published', outcome: { kind: 'undeterminable', cause: 'unsupported-generation', errcode: 1 } },
      'if the generation is unsupported',
    ],
  ])('renders an outcome-specific successor for $0.kind', (result, expected) => {
    expect(formatHandoffRoutingResolveResult(result)).toContain(expected);
  });

  it('dispatches operator discard and reports its retained address', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const routingStatus: HandoffRoutingStatusCommandOperations = {
      resolve: async () => {
        throw new Error('not used');
      },
      discard: () => ({
        kind: 'discarded',
        artifactPath: '/state/run/handoff-routing.1.db',
        quarantinePath: '/state/run/handoff-routing-quarantine/handoff-routing.1.db.event-id',
        previousStatus: { kind: 'unreadable', reason: 'invalid-shape' },
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatus });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'routing-status', 'discard']);

    expect(stdout).toHaveBeenCalledWith(
      'Quarantined routing status from /state/run/handoff-routing.1.db at /state/run/handoff-routing-quarantine/handoff-routing.1.db.event-id.\n',
    );
    expect(process.exitCode).toBe(0);
  });

  it.each([
    [{ kind: 'absent' } as const, 'Next step: no action is needed.'],
    [
      {
        kind: 'current',
        generation: 1,
        statuses: [],
        retirementHistoryTruncated: {
          kind: 'retirement-history-truncated',
          expiredIdentityCount: 0,
          causes: {
            'selection-evicted-at-capacity': 0,
            'completed-pair-compaction': 0,
            'operator-resolved': 0,
          },
          minSelectionSequence: null,
          maxSelectionSequence: null,
          earliestSelectedAt: null,
          latestSelectedAt: null,
        },
      } as const,
      'Next step: run coral-cli backend status and follow whatever successor it shows.',
    ],
    [
      { kind: 'undeterminable', cause: 'io-failed', errcode: 5 } as const,
      'Next step: retry coral-cli backend status without discarding',
    ],
  ])('renders the refusal successor for a $kind journal', async (status, expected) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const routingStatus: HandoffRoutingStatusCommandOperations = {
      resolve: async () => {
        throw new Error('not used');
      },
      discard: async () => ({ kind: 'refused', status }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { routingStatus });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'routing-status', 'discard']);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(expected));
    expect(process.exitCode).toBe(75);
  });
});
