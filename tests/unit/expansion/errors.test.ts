import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { UserInputError } from '#src/cli/commands/expansion.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { installErrorSchema, encodeInstallError } from '#src/cli/expansion/contract.js';

describe('encodeInstallError', () => {
  it('encodes CoralSetupError instances', () => {
    const encoded = encodeInstallError(
      new CoralSetupError({
        code: 'expansion_binary_corrupt',
        userMessage: 'Needle could not be activated.',
        remediation: 'Unequip needle and retry.',
        context: { name: 'needle' },
      }),
    );

    expect(encoded).toEqual({
      status: 'error',
      code: 'expansion_binary_corrupt',
      userMessage: 'Needle could not be activated.',
      remediation: 'Unequip needle and retry.',
      context: { name: 'needle' },
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
      remediation: 'Retry the command. If this persists, report the code because the installer response failed internal validation.',
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('encodes generic Error instances as unknown_error', () => {
    const encoded = encodeInstallError(new Error('install blew up'));

    expect(encoded).toEqual({
      status: 'error',
      code: 'unknown_error',
      userMessage: 'install blew up',
      remediation: 'Retry with --verbose or check the coordinator logs.',
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
      remediation: 'Retry with --verbose or check the coordinator logs.',
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });

  it('surfaces a nested CoralSetupError from the cause chain', () => {
    const inner = new CoralSetupError({
      code: 'expansion_runtime_unavailable',
      userMessage: 'Expansion runtime is unavailable.',
      remediation: 'Restart Coral and retry.',
      context: { name: 'needle' },
    });
    const middle = new Error('mid-layer failure', { cause: inner });
    const outer = new Error('top-level failure', { cause: middle });

    const encoded = encodeInstallError(outer);

    expect(encoded).toEqual({
      status: 'error',
      code: 'expansion_runtime_unavailable',
      userMessage: 'Expansion runtime is unavailable.',
      remediation: 'Restart Coral and retry.',
      context: { name: 'needle' },
    });
    expect(installErrorSchema.parse(encoded)).toEqual(encoded);
  });
});
