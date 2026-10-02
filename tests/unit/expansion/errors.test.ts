import { describe, expect, it } from 'vitest';

import { expansionExitCode } from '#src/cli/commands/expansion.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { encodeInstallError } from '#src/cli/expansion/contract.js';

describe('encodeInstallError', () => {
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
  });
});

describe('expansionExitCode', () => {
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
