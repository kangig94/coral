import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type KbCommitCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';

const storeReset: StoreResetCommandOperations = {
  list: () => ({ incidents: [] }),
  report: async () => {
    throw new Error('not used');
  },
};

let stdout = '';

beforeEach(() => {
  stdout = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write);
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
    registerBackendCommands(program, storeReset, { quarantine });

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
});
