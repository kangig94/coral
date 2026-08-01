import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type StoreAdoptCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';

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

describe('backend store-adopt command', () => {
  it('requires and passes the explicit flavor to the operator adoption service', async () => {
    const adopt = vi.fn<StoreAdoptCommandOperations['adopt']>(async (flavor) => ({
      kind: 'adopted',
      flavor,
      source: '/coral/data-dev',
      destination: '/coral/gen2/data-dev',
      adoptedAt: '2026-08-01T01:02:03.004Z',
      sourceState: 'adoptable',
    }));
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, storeReset, undefined, { adopt });

    await program.parseAsync(['node', 'coral-cli', 'backend', 'store-adopt', '--flavor', 'dev']);

    expect(adopt).toHaveBeenCalledExactlyOnceWith('dev');
    expect(stdout).toBe(
      'Adopted legacy dev store from /coral/data-dev to /coral/gen2/data-dev. Retry the command that starts the backend.\n',
    );
  });
});
