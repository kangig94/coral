import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecoveryQuarantineCommandOperations, registerBackendCommands } from '#src/cli/commands/backend.js';
import { RecoveryQuarantineClearError } from '#src/recovery/source-registry.js';
import { buildTransportErrorResponse } from '#src/transport/error-response.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import * as ipcEnsure from '#src/transport/ipc/ensure.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('backend recovery-quarantine clear refusals', () => {
  it.each([
    ['retry-in-progress', 'recovery_quarantine_retry_in_progress'],
    ['continuation-not-active', 'recovery_quarantine_continuation_pending'],
    ['retention-not-admitted', 'recovery_quarantine_retention_not_admitted'],
  ] as const)('renders %s from the coordinator', async (code, publicCode) => {
    const response = buildTransportErrorResponse(new RecoveryQuarantineClearError(code, 'private diagnostic'));
    const request = vi
      .fn()
      .mockRejectedValue(new IpcRpcError({ code: -32603, message: response.message, data: response.data }));
    vi.spyOn(ipcEnsure, 'ensure').mockResolvedValue({ request } as never);
    let stderr = '';
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, {
      recoveryQuarantine: { ...createRecoveryQuarantineCommandOperations(), list: () => [] },
    });

    await program.parseAsync([
      'node',
      'coral-cli',
      'backend',
      'recovery-quarantine',
      'clear',
      '--boundary',
      'session-retention-work',
      '--key',
      'session:job',
      '--revision',
      'revision',
    ]);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      'coordinator.recovery_quarantine.clear',
      { boundary: 'session-retention-work', key: 'session:job', revision: 'revision' },
      expect.any(Object),
    );
    expect(stderr).toBe(
      `${response.message} [code=${publicCode}]\nremediation: ${String(response.body.remediation)}\n`,
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    if (code === 'retention-not-admitted') {
      expect(stderr).toContain('admitted automatically once the coordinator is serving');
      expect(stderr).toContain('Retry the same clear after startup finishes');
      expect(stderr).not.toContain('coral-cli');
    }
  });
});
