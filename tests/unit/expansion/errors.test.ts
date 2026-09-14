import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { UserInputError, expansionExitCode } from '#src/cli/commands/expansion.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { installErrorSchema } from '#src/expansion/rpc-contract.js';
import { encodeInstallError } from '#src/cli/expansion/contract.js';
import { ChildPrincipalBindingError } from '#src/transport/ipc/child-principal-auth.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';

describe('encodeInstallError', () => {
  it('encodes CoralSetupError instances', () => {
    const encoded = encodeInstallError(
      new CoralSetupError({
        code: 'expansion_binary_corrupt',
        userMessage: 'Vector could not be activated.',
        remediation: 'Unequip vector and retry.',
        context: { name: 'vector' },
      }),
    );

    expect(encoded).toEqual({
      status: 'error',
      code: 'expansion_binary_corrupt',
      userMessage: 'Vector could not be activated.',
      remediation: 'Unequip vector and retry.',
      context: { name: 'vector' },
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('encodes UserInputError-wrapped ZodError instances as invalid_usage', () => {
    const parsed = z
      .object({
        name: z.string().min(1, 'must not be empty'),
      })
      .safeParse({ name: '' });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error('expected validation failure');
    }

    const encoded = encodeInstallError(UserInputError.fromZod(parsed.error));

    expect(encoded).toEqual({
      status: 'error',
      code: 'invalid_usage',
      userMessage: 'Expansion command validation failed: name: must not be empty',
      remediation: "Retry with valid expansion command arguments or run 'coral-cli expansion --help'.",
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('encodes bare ZodError instances as installer_payload_invalid', () => {
    const parsed = z
      .object({
        status: z.literal('installed'),
        method: z.string().min(1),
      })
      .safeParse({ status: 'installed', method: '' });

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error('expected validation failure');
    }

    const encoded = encodeInstallError(parsed.error);

    expect(encoded).toEqual({
      status: 'error',
      code: 'installer_payload_invalid',
      userMessage: 'Expansion installer returned an invalid payload.',
      remediation:
        'Retry the command. If this persists, report the code because the installer response failed internal validation.',
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('encodes generic Error instances as unknown_error', () => {
    const encoded = encodeInstallError(new Error('install blew up'));

    expect(encoded).toEqual({
      status: 'error',
      code: 'unknown_error',
      userMessage: 'install blew up',
      remediation: 'Retry once, then report the full JSON error and check the coordinator logs if it persists.',
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('preserves incomplete child credentials as an actionable authorization error', () => {
    const encoded = encodeInstallError(new ChildPrincipalBindingError());

    expect(encoded).toEqual({
      status: 'error',
      code: 'child_credentials_incomplete',
      userMessage: 'This nested Coral command has incomplete child credentials and was not sent.',
      remediation:
        'Return to the top-level Coral session and run the command there. Retry the parent workflow instead of editing CORAL_* environment variables.',
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('preserves coordinator capability denials and their structured detail', () => {
    const encoded = encodeInstallError(
      new IpcRpcError({
        code: -32_603,
        message: 'This nested Coral session cannot perform this command.',
        data: {
          code: 'missing_capability',
          message: 'This nested Coral session cannot perform this command.',
          detail: { requires: 'expansions:manage' },
        },
      }),
    );

    expect(encoded).toEqual({
      status: 'error',
      code: 'missing_capability',
      userMessage: 'This nested Coral session cannot perform this command.',
      remediation: 'Return to the top-level Coral session and run this expansion command there.',
      context: { requires: 'expansions:manage' },
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('encodes CommanderError instances as invalid_usage', () => {
    const encoded = encodeInstallError(
      new CommanderError(1, 'commander.unknownOption', "error: unknown option '--bad'"),
    );

    expect(encoded).toEqual({
      status: 'error',
      code: 'invalid_usage',
      userMessage: "Expansion command validation failed: unknown option '--bad'",
      remediation: "Retry with valid expansion command arguments or run 'coral-cli expansion --help'.",
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('encodes thrown string values as unknown_error', () => {
    const encoded = encodeInstallError('boom');

    expect(encoded).toEqual({
      status: 'error',
      code: 'unknown_error',
      userMessage: 'boom',
      remediation: 'Retry once, then report the full JSON error and check the coordinator logs if it persists.',
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('surfaces a nested CoralSetupError from the cause chain', () => {
    const inner = new CoralSetupError({
      code: 'expansion_runtime_unavailable',
      userMessage: 'Expansion runtime is unavailable.',
      remediation: 'Restart Coral and retry.',
      context: { name: 'vector' },
    });
    const middle = new Error('mid-layer failure', { cause: inner });
    const outer = new Error('top-level failure', { cause: middle });

    const encoded = encodeInstallError(outer);

    expect(encoded).toEqual({
      status: 'error',
      code: 'expansion_runtime_unavailable',
      userMessage: 'Expansion runtime is unavailable.',
      remediation: 'Restart Coral and retry.',
      context: { name: 'vector' },
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });
});

describe('expansionExitCode', () => {
  it('exits 0 for a non-error result', () => {
    expect(expansionExitCode({ status: 'uninstalled' })).toBe(0);
  });

  it.each([
    ['invalid_usage', 2],
    ['missing_capability', 77],
    ['child_credentials_incomplete', 77],
    ['unknown_expansion', 1],
    ['unmapped_code', 1],
  ] as const)('maps error code %s to exit %i', (code, exitCode) => {
    expect(expansionExitCode({ status: 'error', code, userMessage: 'unused', remediation: 'unused' })).toBe(exitCode);
  });

  // `coordinator_unreachable` and `coordinator_record_unreadable` are this file's live examples of
  // `NOT_OBSERVED_CORAL_SETUP_ERROR_CODES` members reaching `expansionExitCode` — see tests/unit/cli/errors.test.ts
  // for the general case.
  it.each(['coordinator_unreachable', 'coordinator_record_unreadable'] as const)('exits 75 for %s', (code) => {
    expect(
      expansionExitCode({
        status: 'error',
        code,
        userMessage: 'unused',
        remediation: 'unused',
      }),
    ).toBe(75);
  });

  // The artifact this file was missing: every test above pins what one function *says* about one code, never
  // that two commands say compatible things about one machine state. An unreadable discovery record is
  // observed identically by `expansion`, `backend status`, and `backend shutdown` — a script picking among the
  // three must see the same exit either way.
  it('gives the same exit code from expansion, backend status, and backend shutdown for one unreadable discovery record', async () => {
    const { BACKEND_STATUS_EXIT_CODES, SHUTDOWN_REFUSAL_EXIT_CODES } = await import('#src/cli/commands/backend.js');

    const expansionExit = expansionExitCode({
      status: 'error',
      code: 'coordinator_record_unreadable',
      userMessage: 'unused',
      remediation: 'unused',
    });
    const statusExit = BACKEND_STATUS_EXIT_CODES.undecodable_record;
    const shutdownExit = SHUTDOWN_REFUSAL_EXIT_CODES.unreadable_record;

    expect(expansionExit).toBe(statusExit);
    expect(shutdownExit).toBe(statusExit);
  });
});
