import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerBackendCommands, type BackendStatusCommandOperations } from '#src/cli/commands/backend.js';
import { statusFromStartupDiagnostic } from '#src/cli/backend-status.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it('reports a failed start as an error without reading status or reporting success', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const getStatus = vi.fn<BackendStatusCommandOperations['getStatus']>();
  const backendStatus: BackendStatusCommandOperations = {
    inspectReadiness: () => ({ kind: 'no-legacy' }),
    getStatus,
    getLiveHandoffResult: () => null,
    getRoutingStatus: async () => ({ kind: 'absent' }),
    readProviderProxySetHolderStatusDirect: async () => [],
  };
  const program = new Command().exitOverride();
  registerBackendCommands(program, {
    backendStatus,
    backendLifecycle: {
      start: async () => {
        throw new Error('coordinator did not become ready');
      },
    },
  });

  await program.parseAsync(['node', 'coral-cli', 'backend', 'start']);

  expect(getStatus).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('coordinator did not become ready'));
  expect(process.exitCode).toBe(70);
});

it('keeps credentials and store paths out of startup diagnostics', async () => {
  const secret = 'sk-proj-secret-value';
  const storePath = '/private/operator/store.db';
  const classified = statusFromStartupDiagnostic(
    {
      schemaVersion: 1,
      phase: 'startup_failed',
      state: 'stopped_with_diagnostic',
      retryable: false,
      pid: 4242,
      recordedAt: '2026-08-02T11:59:30.000Z',
      attemptId: 'attempt-1',
      exitCode: 1,
      error: { message: `Could not open ${storePath}`, cause: { message: `Provider rejected ${secret}` } },
    },
    Date.parse('2026-08-02T12:00:00.000Z'),
    () => null,
  );
  expect(classified).not.toBeNull();
  if (classified === null) throw new Error('expected recent startup failure');
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const backendStatus: BackendStatusCommandOperations = {
    inspectReadiness: () => ({ kind: 'no-legacy' }),
    getStatus: async () => classified,
    getLiveHandoffResult: () => null,
    getRoutingStatus: async () => ({ kind: 'absent' }),
    readProviderProxySetHolderStatusDirect: async () => [],
  };
  const program = new Command().exitOverride();
  registerBackendCommands(program, { backendStatus });

  await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

  const output = [...stdout.mock.calls, ...stderr.mock.calls].map(([chunk]) => String(chunk)).join('');
  expect(output).not.toContain(secret);
  expect(output).not.toContain(storePath);
  expect(output).toContain('startup_failed');
});
