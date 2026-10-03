import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerBackendCommands, type BackendStatusCommandOperations } from '#src/cli/commands/backend.js';
import { statusFromStartupDiagnostic } from '#src/cli/backend-status.js';
import type { BackendStatusFull } from '#src/cli/backend-status.js';
import { executeRenderedCommand } from '#tests/helpers/rendered-command.js';

function health(
  phase: 'starting' | 'kernel-ready' | 'running',
): Extract<BackendStatusFull, { status: 'ok' }>['health'] {
  return {
    status: phase === 'running' ? 'ok' : 'starting',
    version: '0.10.17',
    bundleHash: 'test',
    instanceId: 'test',
    uptimeMs: 10,
    active: 0,
    activeJobs: 0,
    inflightRequests: 0,
    queueDepth: 0,
    kernel: { phase, readyAt: phase === 'starting' ? null : 1 },
    textProjectionState: 'idle',
    components: [],
    skippedProviderProxySetRows: 0,
    skippedProviderProxySetTokens: [],
  };
}

it.each(['starting', 'kernel-ready', 'running'] as const)(
  'reports authenticated %s health with its readiness exit',
  async (phase) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride();
    const getStatus = vi.fn(async () => ({ status: 'ok' as const, health: health(phase) }));
    registerBackendCommands(program, {
      backendStatus: {
        inspectReadiness: () => ({ kind: 'no-legacy' }),
        getStatus,
        getLiveHandoffResult: () => null,
        getRoutingStatus: async () => ({ kind: 'absent' }),
        readProviderProxySetHolderStatusDirect: async () => [],
      },
    });
    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);
    expect(process.exitCode).toBe(phase === 'running' ? 0 : 75);
    const output = stdout.mock.calls.map(([text]) => String(text)).join('');
    if (phase === 'running') {
      expect(output).not.toContain('retry in about 1 s');
    } else {
      expect(output).toContain('Backend starting');
      expect(output).toContain('Startup recovery is incomplete; retry in about 1 s.');
      expect(await executeRenderedCommand(program, output, { label: 'command', includes: 'backend status' })).toEqual([
        'coral-cli',
        'backend',
        'status',
      ]);
      expect(getStatus).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(75);
    }
  },
);

it('keeps a successful backend start at zero even when its status report needs a retry', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const program = new Command().exitOverride();
  registerBackendCommands(program, {
    backendStatus: {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'ok', health: health('kernel-ready') }),
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect: async () => [],
    },
    backendLifecycle: { start: async () => {} },
  });
  await program.parseAsync(['node', 'coral-cli', 'backend', 'start']);
  expect(process.exitCode).toBe(0);
});

it('keeps a stronger publication failure at 70 when authenticated health is starting', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const program = new Command().exitOverride();
  registerBackendCommands(program, {
    backendStatus: {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({ status: 'ok', health: health('starting') }),
      getLiveHandoffResult: () => ({
        continuation: { kind: 'run-current', reason: { kind: 'handoff-not-applicable', reason: 'display-only' } },
        publicationIncidents: [
          {
            kind: 'not-published',
            cause: 'invalid-record',
            validation: { kind: 'schema-violation' },
            phase: 'selection',
            invocationId: 'test',
          },
        ],
      }),
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect: async () => [],
    },
  });
  await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);
  expect(process.exitCode).toBe(70);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it.each([
  { status: 'unreachable', cause: 'no_response', detail: 'timed out' },
  { status: 'unreachable', cause: 'responded', detail: 'health shape rejected' },
  { status: 'undecodable_record', reason: 'shape-rejected', path: '/test/discovery.json' },
] satisfies BackendStatusFull[])('keeps $status separate from authenticated starting guidance', async (status) => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const program = new Command().exitOverride();
  registerBackendCommands(program, {
    backendStatus: {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => status,
      getLiveHandoffResult: () => null,
      getRoutingStatus: async () => ({ kind: 'absent' }),
      readProviderProxySetHolderStatusDirect: async () => [],
    },
  });
  await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);
  expect(process.exitCode).toBe(75);
  expect(stdout.mock.calls.map(([text]) => String(text)).join('')).not.toContain('retry in about 1 s');
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
