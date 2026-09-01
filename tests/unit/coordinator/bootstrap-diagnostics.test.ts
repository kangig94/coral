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
import { HandoffEscalationError } from '#src/coordinator/handoff.js';
import { documentedCoralSetupError, serializeCoralSetupError } from '#src/runtime/errors.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('serializeBootstrapError', () => {
  it('keeps a setup error cause in the private diagnostic without adding it to the public projection', () => {
    const secret = 'private bind failure';
    const error = new HandoffEscalationError(
      {
        code: 'handoff_accepted_signal_target_alive_after_failure',
        context: { stage: 'after-accepted-signal-failure', pid: 4242, signal: 'SIGTERM' },
      },
      { cause: new Error(secret) },
    );

    expect(serializeBootstrapError(error)).toMatchObject({
      kind: 'coral_setup_error',
      code: 'handoff_accepted_signal_target_alive_after_failure',
      cause: { kind: 'error', message: secret },
    });
    const publicProjection = serializeCoralSetupError(error);
    expect(publicProjection).not.toHaveProperty('cause');
    expect(JSON.stringify(publicProjection)).not.toContain(secret);
  });

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
});
