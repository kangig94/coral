import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type KbCommitCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import { emitError } from '#src/cli/emit.js';
import { buildErrorEnvelope } from '#src/cli/errors.js';

const storeReset: StoreResetCommandOperations = {
  list: () => ({ incidents: [] }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
};

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('backend kb-commit quarantine command', () => {
  it('passes the explicit flavor and blocking commit ID to the local operator service', async () => {
    const quarantine = vi.fn<KbCommitCommandOperations['quarantine']>(async (_flavor, commitId) => ({
      commitId,
      quarantineDir: '/retained/kb-commit',
    }));
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, { storeReset, kbCommit: { quarantine } });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'kb-commit',
      'quarantine',
      '--flavor',
      'dev',
      '--commit',
      'blocking-commit',
    ]);

    expect(quarantine).toHaveBeenCalledExactlyOnceWith('dev', 'blocking-commit');
    expect(stdout).toBe("Quarantined KB commit 'blocking-commit' at /retained/kb-commit.\n");
  });

  it.each(['../../evil', '..', 'nested/commit', 'nested\\commit', ''])(
    'rejects unsafe commit ID %j as invalid usage before invoking the operator service',
    async (commitId) => {
      const quarantine = vi.fn<KbCommitCommandOperations['quarantine']>();
      const program = new Command();
      program.exitOverride();
      registerBackendCommands(program, { storeReset, kbCommit: { quarantine } });

      let refusal: unknown;
      try {
        await program.parseAsync([
          'node',
          'coral-cli',
          'backend',
          'kb-commit',
          'quarantine',
          '--flavor',
          'prod',
          '--commit',
          commitId,
        ]);
      } catch (error: unknown) {
        refusal = error;
      }

      expect(buildErrorEnvelope(refusal)).toMatchObject({
        envelope: { code: 'invalid_usage', message: expect.stringContaining('safe filesystem path segment') },
        exitCode: 2,
      });
      expect(stderr).toBe('');
      emitError(refusal);
      expect(stderr.match(/safe filesystem path segment/gu)).toHaveLength(1);
      expect(quarantine).not.toHaveBeenCalled();
    },
  );
});
