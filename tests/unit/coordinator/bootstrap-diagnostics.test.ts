import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  readFileSync: vi.fn(),
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
  storage.readFileSync.mockImplementation(() => {
    throw Object.assign(new Error('missing diagnostic'), { code: 'ENOENT' });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A documented startup refusal already on disk, recorded just now by a different pid unless overridden. */
function recordedSetupRefusal(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    phase: 'startup_failed',
    state: 'stopped_with_diagnostic',
    retryable: false,
    pid: process.pid + 1,
    recordedAt: new Date().toISOString(),
    error: {
      kind: 'coral_setup_error',
      code: 'handoff_manual_policy',
      userMessage: 'authored refusal',
      remediation: 'authored recovery',
    },
    ...overrides,
  });
}

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

  // The guard may not depend on CORAL_STARTUP_ATTEMPT_ID: an ancestor and the build it delegates to carry the
  // same one, so it separates neither of them from the other, and a spawn exporting none leaves both sides
  // absent. Either way the refusal the delegated build recorded keeps its code and remediation.
  it.each<[string, string | undefined]>([
    ['a spawn that exported an attempt id', 'delegated-attempt'],
    ['a spawn that exported none', undefined],
  ])(
    'keeps the setup refusal a delegated build recorded when an ancestor from %s fails generically',
    (_path, attemptId) => {
      vi.stubEnv('CORAL_STARTUP_ATTEMPT_ID', attemptId);
      storage.readFileSync.mockReturnValue(recordedSetupRefusal({ attemptId }));

      expect(writeBootstrapDiagnostic('/plugin', 'startup_failed', new Error('generic ancestor error'), 1)).toBe(
        '/state/startup-diagnostic.json',
      );

      expect(storage.writeFileSync).not.toHaveBeenCalled();
      expect(storage.renameSync).not.toHaveBeenCalled();
    },
  );

  // Reading the existing record can fail for reasons that are neither "no record" nor "unusable record":
  // EACCES, EISDIR, EIO. The guard exists to keep a record that is better than this one, and a record that
  // cannot be read is not known to be one — while a generic startup failure writes no sentinel, so declining
  // to write here would leave the failure this process did observe on no durable surface at all.
  it('records its own generic failure when the existing diagnostic cannot be read', () => {
    vi.stubEnv('CORAL_STARTUP_ATTEMPT_ID', undefined);
    storage.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    expect(writeBootstrapDiagnostic('/plugin', 'startup_failed', new Error('generic ancestor error'), 1)).toBe(
      '/state/startup-diagnostic.json',
    );

    const written = JSON.parse(String(storage.writeFileSync.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(written.error).toMatchObject({ kind: 'error', message: 'generic ancestor error' });
    expect(storage.renameSync).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ['recorded before this process started', { recordedAt: new Date(0).toISOString() }],
    ['recorded by this process itself', { pid: process.pid }],
    ['recorded without a readable pid', { pid: 'not-a-pid' }],
  ])('replaces a setup refusal %s', (_reason, overrides) => {
    vi.stubEnv('CORAL_STARTUP_ATTEMPT_ID', undefined);
    storage.readFileSync.mockReturnValue(recordedSetupRefusal(overrides));

    expect(writeBootstrapDiagnostic('/plugin', 'startup_failed', new Error('generic ancestor error'), 1)).toBe(
      '/state/startup-diagnostic.json',
    );

    const written = JSON.parse(String(storage.writeFileSync.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(written.error).toMatchObject({ kind: 'error', message: 'generic ancestor error' });
    expect(storage.renameSync).toHaveBeenCalledTimes(1);
  });
});
