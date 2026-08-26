import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: () => ({
    paths: {
      coral: {
        coordinator: {
          startupDiagnosticFile: '/state/startup-diagnostic.json',
          socketPath: '/state/coordinator.sock',
        },
      },
    },
    storage,
  }),
}));
vi.mock('#src/infra/build-flavor.js', () => ({ resolveBuildFlavor: () => 'prod' }));
vi.mock('#src/infra/bundle-manifest.js', () => ({ readBundleHash: () => 'bundle-hash' }));
vi.mock('#src/infra/plugin-identity.js', () => ({ pluginRootNamespace: () => 'namespace' }));

import { serializeBootstrapError, writeBootstrapDiagnostic } from '#src/coordinator/bootstrap-diagnostics.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('serializeBootstrapError', () => {
  it('preserves a nested Error cause chain', () => {
    const error = new Error('coordinator startup failed', {
      cause: new Error('runtime initialization failed', {
        cause: new Error('database is locked'),
      }),
    });

    expect(serializeBootstrapError(error)).toMatchObject({
      kind: 'error',
      message: 'coordinator startup failed',
      cause: {
        kind: 'error',
        message: 'runtime initialization failed',
        cause: {
          kind: 'error',
          message: 'database is locked',
        },
      },
    });
  });

  it('stops serializing a cyclic cause after eight nested causes', () => {
    const error = new Error('cyclic failure');
    error.cause = error;

    let serialized = serializeBootstrapError(error);
    for (let causeDepth = 0; causeDepth < 8; causeDepth += 1) {
      expect(serialized).toMatchObject({ kind: 'error', message: 'cyclic failure' });
      expect(serialized.cause).toBeDefined();
      serialized = serialized.cause as Record<string, unknown>;
    }
    expect(serialized).toMatchObject({ kind: 'error', message: 'cyclic failure' });
    expect(serialized).not.toHaveProperty('cause');
  });
});

describe('writeBootstrapDiagnostic', () => {
  it('derives retryability from the documented setup-error code', () => {
    writeBootstrapDiagnostic('/plugin', 'startup_failed', documentedCoralSetupError('store_open_contended'), 75);
    writeBootstrapDiagnostic('/plugin', 'startup_failed', documentedCoralSetupError('store_open_unclassified'), 70);

    const retryable = JSON.parse(String(storage.writeFileSync.mock.calls[0]?.[1])) as Record<string, unknown>;
    const nonRetryable = JSON.parse(String(storage.writeFileSync.mock.calls[1]?.[1])) as Record<string, unknown>;
    expect(retryable.retryable).toBe(true);
    expect(nonRetryable.retryable).toBe(false);
  });

  it('records a clean-exit pending-signal abort as a retryable startup outcome', () => {
    const error = documentedCoralSetupError('handoff_pending_signal_aborted', {
      acceptedSignal: 'SIGKILL',
      targetPid: '4242',
      targetDescription: 'could not be verified as gone',
    });

    writeBootstrapDiagnostic('/plugin', 'startup_failed', error, 0);

    const diagnostic = JSON.parse(String(storage.writeFileSync.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      phase: 'startup_failed',
      state: 'stopped_with_diagnostic',
      retryable: true,
      exitCode: 0,
      error: {
        kind: 'coral_setup_error',
        code: 'handoff_pending_signal_aborted',
        userMessage: expect.stringContaining('SIGKILL for incumbent pid=4242'),
        remediation: expect.stringContaining('retry startup'),
      },
    });
  });
});
