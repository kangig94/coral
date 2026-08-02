import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerBackendCommands,
  type BackendStatusCommandOperations,
  type StoreResetCommandOperations,
} from '#src/cli/commands/backend.js';
import { statusFromStartupDiagnostic } from '#src/transport/http/backend/status.js';

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

  it('prints a recent startup failure returned by the read-only status probe', async () => {
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => ({
        status: 'recent_failure',
        phase: 'startup_failed',
      }),
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, storeReset, undefined, undefined, status);

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stderr).toBe('');
    expect(stdout).toBe(
      [
        'Backend is not running after a recent coordinator failure.',
        'Phase: startup_failed',
        'Next step: inspect the coordinator log, fix the reported cause, then retry a coral-cli mutating command to relaunch it.',
        '',
      ].join('\n'),
    );
  });
});

describe('backend startup diagnostic classification', () => {
  const now = Date.parse('2026-08-02T12:00:00.000Z');

  it('classifies a recent failure without returning serialized exception text', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          pid: 4242,
          recordedAt: '2026-08-02T11:59:30.000Z',
          attemptId: 'attempt-1',
          exitCode: 1,
          error: {
            message: 'Coordinator startup failed',
            stack: 'not printed',
            cause: {
              message: 'Job recovery failed',
              cause: { message: 'Could not hydrate job-42' },
            },
          },
        },
        now,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
    });
  });

  it('carries the authored cause and remediation of a documented setup failure', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          pid: 4242,
          recordedAt: '2026-08-02T11:59:30.000Z',
          exitCode: 1,
          error: {
            kind: 'coral_setup_error',
            code: 'legacy_adoption_required',
            userMessage: 'Compatible legacy Coral history at /home/u/.coral/data must be adopted before this generation can initialize.',
            remediation: "Run 'coral-cli backend store-adopt --flavor prod', then retry the command that starts the backend.",
            // Context is deliberately not forwarded: only the two rendered
            // strings are authored per code and safe to show.
            context: { flavor: 'prod', legacyPath: '/home/u/.coral/data' },
          },
        },
        now,
      ),
    ).toEqual({
      status: 'recent_failure',
      phase: 'startup_failed',
      setupError: {
        code: 'legacy_adoption_required',
        userMessage: 'Compatible legacy Coral history at /home/u/.coral/data must be adopted before this generation can initialize.',
        remediation: "Run 'coral-cli backend store-adopt --flavor prod', then retry the command that starts the backend.",
      },
    });
  });

  it('does not render credentials from a serialized diagnostic cause', async () => {
    const secret = 'sk-proj-secret-value';
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
        error: {
          message: 'Coordinator startup failed',
          cause: { message: `Provider rejected credential ${secret}` },
        },
      },
      now,
    );
    if (classified === null) throw new Error('expected recent startup failure');
    const status: BackendStatusCommandOperations = {
      inspectReadiness: () => ({ kind: 'no-legacy' }),
      getStatus: async () => classified,
    };
    const program = new Command();
    program.exitOverride();
    registerBackendCommands(program, storeReset, undefined, undefined, status);

    await program.parseAsync(['node', 'coral-cli', 'backend', 'status']);

    expect(stdout).not.toContain(secret);
    expect(stdout).not.toContain('Provider rejected credential');
    expect(stdout).toContain('Next step: inspect the coordinator log');
  });

  it('treats a diagnostic left from days ago as a genuine absence', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          recordedAt: '2026-07-30T12:00:00.000Z',
          error: { message: 'old failure' },
        },
        now,
      ),
    ).toBeNull();
  });

  it('does not attribute a prior failure to a newer discovered daemon', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          recordedAt: '2026-08-02T11:59:30.000Z',
          error: { message: 'prior failure' },
        },
        now,
        Date.parse('2026-08-02T11:59:45.000Z'),
      ),
    ).toBeNull();
  });

  it('rejects a diagnostic whose pid differs from the discovered pid', () => {
    expect(
      statusFromStartupDiagnostic(
        {
          schemaVersion: 1,
          phase: 'startup_failed',
          state: 'stopped_with_diagnostic',
          retryable: false,
          pid: 5151,
          recordedAt: '2026-08-02T11:59:50.000Z',
          error: { message: 'new contender failed' },
        },
        now,
        Date.parse('2026-08-02T11:59:00.000Z'),
        4242,
      ),
    ).toBeNull();
  });
});
