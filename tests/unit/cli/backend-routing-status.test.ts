import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerBackendCommands, type HandoffRoutingStatusCommandOperations } from '#src/cli/commands/backend.js';
import { parseHandoffRepairOperation } from '#src/coordinator/handoff-repair-operation.js';

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
    ['duplicate separated invocation', ['--invocation', INVOCATION_ID, '--invocation', INVOCATION_ID]],
    ['duplicate mixed invocation', [`--invocation=${INVOCATION_ID}`, '--invocation', INVOCATION_ID]],
    ['duplicate force', ['--invocation', INVOCATION_ID, '--force-unobservable', '--force-unobservable']],
    ['missing invocation', []],
    ['missing separated value', ['--invocation']],
    ['option as separated value', ['--invocation', '--force-unobservable']],
    ['terminator', ['--invocation', INVOCATION_ID, '--']],
    ['unknown option', ['--invocation', INVOCATION_ID, '--unknown']],
    ['unknown operand', ['--invocation', INVOCATION_ID, 'extra']],
    ['noncanonical invocation', ['--invocation', INVOCATION_ID.toUpperCase()]],
  ])('rejects %s', (_name, options) => {
    expect(
      parseHandoffRepairOperation(['node', 'coral-cli', 'backend', 'routing-status', 'resolve', ...options]),
    ).toBeNull();
  });

  it('is bidirectionally equivalent to the registered Commander action', async () => {
    const cases = [
      ['--invocation', INVOCATION_ID],
      [`--invocation=${INVOCATION_ID}`],
      ['--force-unobservable', '--invocation', INVOCATION_ID],
      ['--invocation', INVOCATION_ID, '--force-unobservable'],
      ['--invocation', INVOCATION_ID, '--invocation', INVOCATION_ID],
      [`--invocation=${INVOCATION_ID}`, '--invocation', INVOCATION_ID],
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
      const captured: unknown[] = [];
      const routingStatus: HandoffRoutingStatusCommandOperations = {
        resolve: async (request) => {
          captured.push(request);
          return {
            kind: 'resolved',
            invocationId: request.invocationId,
            reason: 'owner-absent',
            sequence: 1,
          };
        },
      };
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeErr: () => undefined });
      registerBackendCommands(program, { routingStatus });
      await program.parseAsync(argv).catch(() => undefined);
      expect(captured, options.join(' ')).toEqual(parsed === null ? [] : [parsed]);
      process.exitCode = undefined;
    }
  });
});
