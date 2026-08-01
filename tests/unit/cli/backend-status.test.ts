import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type BackendStatusCommandOperations,
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

describe('backend status generation readiness', () => {
  it('prints the read-only foreign-generation notice directly in the CLI', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({
        kind: 'legacy-foreign',
        legacyPath: '/state/data',
        generatedPath: '/state/gen2/data',
        storedProductVersion: '0.9.16',
      }),
      getStatus: async () => ({ status: 'not_running' }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, storeReset, undefined, undefined, status);

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stderr).toBe(
      'Legacy Coral history remains at /state/data; its stored Coral version is 0.9.16. This generation will initialize empty state at /state/gen2/data without changing the legacy tree.\n',
    );
    expect(stdout).toContain('Backend not running.');
  });
});
