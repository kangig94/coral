import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRecoveryQuarantineCommandOperations,
  registerBackendCommands,
  type RecoveryQuarantineCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import { encodeRecoveryQuarantineKey, type RecoveryQuarantineEntry } from '#src/recovery/quarantine.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { PROVIDER_OPERATION_RECORD_VERSION } from '#src/store/provider-operation-record.js';
import * as ipcEnsure from '#src/transport/ipc/ensure.js';
import { executeRenderedCommand } from '#tests/helpers/rendered-command.js';

const storeReset: StoreResetCommandOperations = {
  list: () => ({ epochs: [], holders: [], residues: [], legacyIncidents: [], truncated: false }),
  report: async () => {
    throw new Error('not used');
  },
  discard: async () => {
    throw new Error('not used');
  },
  release: async () => {
    throw new Error('not used');
  },
};
const key =
  `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
  '00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:' +
  '00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000004';
const revision = `sha256:${'a'.repeat(64)}`;
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

function listedEntry(allowReadable: boolean): RecoveryQuarantineEntry {
  return {
    boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
    subject: { key, revision: { kind: 'fingerprint', value: revision } },
    state: 'active',
    stage: 'hydrate',
    retry: null,
    continuation: null,
    errorMessage: 'Row requires explicit discard.',
    detail: 'Discard this exact revision.',
    remedy: {
      kind: 'recovery-quarantine-discard',
      command: {
        kind: 'discard-provider-operation',
        key,
        revision: `fingerprint:${revision}`,
        allowReadable,
      },
    },
    detectedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function programWith(entry: RecoveryQuarantineEntry): Command {
  const recoveryQuarantine: RecoveryQuarantineCommandOperations = {
    ...createRecoveryQuarantineCommandOperations(),
    list: () => [entry],
  };
  const program = new Command();
  program.exitOverride();
  registerBackendCommands(program, { storeReset, recoveryQuarantine });
  return program;
}

async function listing(program: Command): Promise<string> {
  await program.parseAsync(['node', 'coral-cli', 'backend', 'recovery-quarantine', 'list']);
  const rendered = stdout;
  stdout = '';
  return rendered;
}

describe('backend recovery-quarantine commands', () => {
  it('should send the exact listed unreadable row revision to the destructive discard operation', async () => {
    const request = vi.fn().mockResolvedValue({ key, revision, kind: 'discarded' });
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({ request } as never);
    const program = programWith(listedEntry(false));

    await executeRenderedCommand(program, await listing(program), {
      label: 'discard',
      includes: encodeRecoveryQuarantineKey(key),
    });

    expect(request).toHaveBeenCalledExactlyOnceWith(
      'coordinator.recovery_quarantine.discard_provider_operation',
      { key, revision },
      expect.any(Object),
    );
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('should require consent, then execute the complete readable-discard remedy from the listing', async () => {
    const request = vi.fn().mockResolvedValue({ key, revision, allowReadable: true, kind: 'discarded' });
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({ request } as never);
    const program = programWith(listedEntry(true));
    const rendered = await listing(program);

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'discard-provider-operation',
      '--key',
      encodeRecoveryQuarantineKey(key),
      '--revision',
      `fingerprint:${revision}`,
    ]);

    expect(request).not.toHaveBeenCalled();
    expect(stderr).toContain('Readable provider-operation discard requires explicit consent');
    expect(process.exitCode).toBe(2);
    stderr = '';
    process.exitCode = undefined;

    await executeRenderedCommand(program, rendered, { label: 'discard', includes: encodeRecoveryQuarantineKey(key) });

    expect(request).toHaveBeenCalledExactlyOnceWith(
      'coordinator.recovery_quarantine.discard_provider_operation',
      { key, revision, allowReadable: true },
      expect.any(Object),
    );
    expect(stderr).toBe('');
    expect(process.exitCode).toBe(0);
  });
});
