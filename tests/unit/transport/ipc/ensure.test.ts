import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import {
  readBuildFlavor,
  type StrictBundleIdentityResult,
  type StrictBundleManifest,
} from '#src/infra/bundle-manifest.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';

const mockState = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args?: readonly string[], options?: unknown) => ChildProcess>(),
  health: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  shutdown: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  bindSocket: vi.fn<() => Promise<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }>>(),
  createdClients: [] as Array<{ socketPath: string; auth: unknown }>,
  home: '',
  platform: process.platform,
  /** What this build can prove about its own bundle; a unit run has no injected identity, so default is a refusal. */
  strictIdentity: { ok: false, reason: 'embedded_identity_unavailable' } as StrictBundleIdentityResult,
}));

// Only `resolveStrictBundleIdentity` is replaced: the flavor and manifest reads below must stay real, because
// the temporary plugin roots these tests build are what those reads are supposed to see.
vi.mock('#src/infra/bundle-manifest.js', async () => {
  const actual = await vi.importActual<typeof BundleManifestMod>('#src/infra/bundle-manifest.js');
  return { ...actual, resolveStrictBundleIdentity: () => mockState.strictIdentity };
});

vi.mock('node:child_process', () => ({
  spawn: mockState.spawn,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.home,
    platform: () => mockState.platform,
  };
});

vi.mock('#src/transport/ipc/client.js', () => ({
  createIpcClient: (socketPath: string, _time?: unknown, auth?: unknown) => {
    mockState.createdClients.push({ socketPath, auth });
    return {
      socketPath,
      request: vi.fn(),
      ping: (options?: unknown) => mockState.health(socketPath, options),
      health: (options?: unknown) => mockState.health(socketPath, options),
      shutdown: (options?: unknown) => mockState.shutdown(socketPath, options),
    };
  },
}));

// Stub bindSocket so probeSocketReleased's behavior is deterministic without
// real fs sockets. Default: socket is released (returns 'bound').
vi.mock('#src/transport/ipc/server.js', () => ({
  bindSocket: () => mockState.bindSocket(),
}));

const tempRoots: string[] = [];

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-ensure-home-'));
  tempRoots.push(root);
  mockState.home = root;
  return root;
}

function spawnedChild(pid = 12_345): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid, configurable: true });
  child.unref = vi.fn();
  return child;
}

function createPluginRoot(flavor: 'prod' | 'dev' = 'prod', version = '0.5.2'): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-ensure-root-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'manifest.json'), JSON.stringify({ bundleHash: 'test-hash', flavor }), 'utf-8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }), 'utf-8');
  return root;
}

function discoveryPath(root: string, flavor = readBuildFlavor(root)): string {
  return coordinatorPaths(flavor).infoFile;
}

function socketPath(root: string, flavor = readBuildFlavor(root)): string {
  return coordinatorPaths(flavor).socketPath;
}

function writeDiscovery(
  root: string,
  overrides: Partial<{
    pid: number;
    port: number;
    host: string;
    token: string;
    bootToken: string | null;
    shutdownToken: string | null;
    version: string;
    bundleHash: string;
    flavor: 'prod' | 'dev';
    instanceId: string;
    namespace: string;
    startedAt: number;
    incarnation: ProcessIncarnation;
    socketPath: string;
  }> = {},
): void {
  const flavor = overrides.flavor ?? readBuildFlavor(root);
  const filePath = discoveryPath(root, flavor);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({
      pid: overrides.pid ?? process.pid,
      port: overrides.port ?? 4100,
      host: overrides.host ?? '127.0.0.1',
      socketPath: overrides.socketPath ?? socketPath(root, flavor),
      token: overrides.token ?? 'test-token',
      ...(overrides.bootToken === null ? {} : { bootToken: overrides.bootToken ?? 'test-boot-token' }),
      ...(overrides.shutdownToken === null ? {} : { shutdownToken: overrides.shutdownToken ?? 'test-shutdown-token' }),
      version: overrides.version ?? '0.5.2',
      bundleHash: overrides.bundleHash ?? 'test-hash',
      flavor,
      instanceId: overrides.instanceId ?? 'existing-coordinator',
      namespace: overrides.namespace ?? pluginRootNamespace(root),
      startedAt: overrides.startedAt ?? Date.now(),
      ...(overrides.incarnation === undefined ? {} : { incarnation: overrides.incarnation }),
    }),
    'utf-8',
  );
}

function writeStartupSentinel(
  root: string,
  attemptId: string,
  overrides: Partial<{
    pid: number;
    bundleHash: string;
    namespace: string;
    code: string;
    userMessage: string;
    remediation: string;
    context: Record<string, unknown>;
    error: unknown;
  }> = {},
): void {
  const paths = coordinatorPaths(readBuildFlavor(root));
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(
    paths.startupErrorFile,
    JSON.stringify({
      version: 1,
      attemptId,
      pid: overrides.pid ?? 12_345,
      startedAt: Date.now(),
      recordedAt: Date.now(),
      phase: 'startup_failed',
      state: 'stopped_with_diagnostic',
      exitCode: 1,
      socketPath: paths.socketPath,
      bundleHash: overrides.bundleHash ?? 'test-hash',
      flavor: 'prod',
      namespace: overrides.namespace ?? pluginRootNamespace(root),
      error:
        'error' in overrides
          ? overrides.error
          : {
              code: overrides.code ?? 'handoff_socket_holder_unverified',
              userMessage: overrides.userMessage ?? 'Handoff refused after observing a socket-only holder.',
              remediation: overrides.remediation ?? 'Inspect the socket holder, then retry.',
              ...(overrides.context !== undefined
                ? { context: overrides.context }
                : overrides.code === undefined
                  ? { context: { stage: 'handoff-deadline', socketPath: paths.socketPath } }
                  : {}),
            },
    }),
    'utf-8',
  );
}

function provenManifest(bundleHash: string): StrictBundleManifest {
  return {
    version: '0.5.2',
    buildSetId: '00000000-0000-4000-8000-000000000000',
    flavor: 'prod',
    storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
    bundleHash,
    cliBundleHash: bundleHash,
    claudeAppserverBundleHash: bundleHash,
  };
}

function spawnedAttemptId(): string {
  const options = mockState.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
  const attemptId = options?.env?.CORAL_STARTUP_ATTEMPT_ID;
  if (attemptId === undefined) {
    throw new Error('Expected the spawned coordinator attempt id.');
  }
  return attemptId;
}

function createErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function setCompleteChildEnv(): void {
  process.env.CORAL_CHILD = '1';
  process.env.CORAL_CHILD_PRINCIPAL_HANDLE = 'child-handle';
  process.env.CORAL_JOB_ID = 'parent-job';
  process.env.CORAL_SESSION_ID = 'parent-session';
}

async function importEnsure() {
  vi.resetModules();
  return await import('#src/transport/ipc/ensure.js');
}

// createRealRuntime reads CLAUDE_CONFIG_DIR from process.env and derives a
// config slot that partitions the coordinator path. The test helpers compute
// coordinatorPaths(flavor) with no slot, so an ambient CLAUDE_CONFIG_DIR would
// make ensure() read a partitioned path that never matches the seeded discovery.
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const childEnvKeys = ['CORAL_CHILD', 'CORAL_CHILD_PRINCIPAL_HANDLE', 'CORAL_JOB_ID', 'CORAL_SESSION_ID'] as const;
const savedChildEnv = new Map(childEnvKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  for (const key of childEnvKeys) delete process.env[key];
  mockState.spawn.mockImplementation(() => spawnedChild());
  mockState.strictIdentity = { ok: false, reason: 'embedded_identity_unavailable' };
});

afterEach(() => {
  delete (globalThis as { __BUNDLE_DIR__?: string }).__BUNDLE_DIR__;
  if (savedClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  mockState.spawn.mockReset();
  mockState.health.mockReset();
  mockState.shutdown.mockReset();
  mockState.bindSocket.mockReset();
  mockState.bindSocket.mockResolvedValue({ kind: 'bound' });
  mockState.createdClients.length = 0;
  for (const key of childEnvKeys) {
    const value = savedChildEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ipc ensure', () => {
  it('should classify serving and replaceable incumbent states separately', async () => {
    const { mayInvocationBeServedByIncumbent, mayProcessReplaceIncumbent } = await importEnsure();
    const health = {
      status: 'ok' as const,
      version: '0.5.2',
      bundleHash: 'foreign-hash',
      flavor: 'prod' as const,
      instanceId: 'foreign-coordinator',
      namespace: 'foreign-namespace',
    };

    expect(mayInvocationBeServedByIncumbent(health)).toBe(true);
    expect(mayInvocationBeServedByIncumbent({ ...health, status: 'draining' })).toBe(false);
    expect(mayInvocationBeServedByIncumbent(null)).toBe(false);
    expect(mayProcessReplaceIncumbent(health)).toBe(false);
    expect(mayProcessReplaceIncumbent({ ...health, status: 'draining' })).toBe(true);
    expect(mayProcessReplaceIncumbent(null)).toBe(true);
  });

  it('should reuse a present healthy ready coordinator', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4202,
      token: 'existing-token',
      instanceId: 'existing-coordinator',
    });

    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'existing-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.instanceId).toBe('existing-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(mockState.shutdown).not.toHaveBeenCalled();
    expect(mockState.createdClients).toContainEqual({
      socketPath: socketPath(root),
      auth: { kind: 'boot', token: 'test-boot-token' },
    });
  });

  it('reuses a present healthy coordinator whose discovery record carries a field this build predates', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4203,
      token: 'existing-token',
      instanceId: 'existing-coordinator',
    });
    // A build newer than this one added a field to the record before either build's schema knew about
    // it — simulated by writing straight to disk, past `writeDiscovery`'s own field set.
    const filePath = discoveryPath(root);
    const written = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(filePath, JSON.stringify({ ...written, futureField: 'added-by-a-newer-coordinator' }), 'utf-8');

    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'existing-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.instanceId).toBe('existing-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  describe('child existing-only lifecycle', () => {
    it('reuses a mismatched incumbent without boot auth, shutdown, release probing, or spawn', async () => {
      makeHome();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, {
        bundleHash: 'parent-hash',
        instanceId: 'parent-coordinator',
      });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'parent-hash',
        flavor: 'prod',
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
      });

      const { ensure } = await importEnsure();
      const ensured = await ensure(root);

      expect(ensured.instanceId).toBe('parent-coordinator');
      expect(ensured.bundleHash).toBe('parent-hash');
      expect(ensured).not.toHaveProperty('token');
      expect(mockState.createdClients.every(({ auth }) => auth === undefined)).toBe(true);
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('fails without creating lifecycle state when the parent is unreachable', async () => {
      makeHome();
      const root = createPluginRoot();
      process.env.CORAL_CHILD = '1';
      mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));

      const { ensure } = await importEnsure();

      await expect(ensure(root)).rejects.toThrow(
        'Nested Coral command stopped because its parent coordinator is unreachable',
      );
      expect(existsSync(discoveryPath(root))).toBe(false);
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('does not wait for release or spawn when the parent is draining', async () => {
      makeHome();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, { instanceId: 'parent-coordinator' });
      mockState.health.mockResolvedValue({
        status: 'draining',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
      });

      const { ensure } = await importEnsure();

      await expect(ensure(root)).rejects.toThrow('parent coordinator is draining');
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('waits for the same starting parent to become ready with matching process identity', async () => {
      makeHome();
      vi.useFakeTimers();
      const root = createPluginRoot();
      setCompleteChildEnv();
      const identity = {
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod' as const,
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
        pid: 4_201,
        incarnation: testIncarnation(1_000),
      };
      mockState.health
        .mockResolvedValueOnce({ status: 'starting', ...identity })
        .mockResolvedValue({ status: 'ok', ...identity });
      setTimeout(
        () =>
          writeDiscovery(root, {
            instanceId: identity.instanceId,
            pid: identity.pid,
            incarnation: identity.incarnation,
          }),
        100,
      );

      const { ensure } = await importEnsure();
      const result = ensure(root);
      await vi.advanceTimersByTimeAsync(400);
      const ensured = await result;

      expect(ensured.instanceId).toBe(identity.instanceId);
      expect(ensured).not.toHaveProperty('token');
      expect(mockState.createdClients.every(({ auth }) => auth === undefined)).toBe(true);
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('rejects a PID change while waiting for the observed parent', async () => {
      makeHome();
      vi.useFakeTimers();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, {
        instanceId: 'parent-coordinator',
        pid: 4_201,
        incarnation: testIncarnation(1_000),
      });
      const identity = {
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod' as const,
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
        incarnation: testIncarnation(1_000),
      };
      mockState.health
        .mockResolvedValueOnce({ status: 'starting', ...identity, pid: 4_201 })
        .mockResolvedValue({ status: 'ok', ...identity, pid: 4_202 });

      const { ensure } = await importEnsure();
      const result = ensure(root).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(400);
      const error = await result;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('coordinator identity changed');
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('rejects discovery with a different process incarnation', async () => {
      makeHome();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, {
        instanceId: 'parent-coordinator',
        pid: 4_201,
        incarnation: testIncarnation(2_000),
      });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
        pid: 4_201,
        incarnation: testIncarnation(1_000),
      });

      const { ensure } = await importEnsure();

      await expect(ensure(root)).rejects.toThrow('discovery does not match the observed parent');
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('rejects discovery that points at a different coordinator socket', async () => {
      makeHome();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, {
        instanceId: 'parent-coordinator',
        socketPath: join(root, 'unrelated-coordinator.sock'),
      });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
      });

      const { ensure } = await importEnsure();

      await expect(ensure(root)).rejects.toThrow('discovery does not match the observed parent');
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('pins a starting child connection to the first observed coordinator instance', async () => {
      makeHome();
      vi.useFakeTimers();
      const root = createPluginRoot();
      setCompleteChildEnv();
      mockState.health
        .mockResolvedValueOnce({
          status: 'starting',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'parent-coordinator',
          namespace: pluginRootNamespace(root),
        })
        .mockResolvedValue({
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'replacement-coordinator',
          namespace: pluginRootNamespace(root),
        });
      setTimeout(() => writeDiscovery(root, { instanceId: 'replacement-coordinator' }), 100);

      const { ensure } = await importEnsure();
      const ensured = ensure(root);
      const result = ensured.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(400);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('coordinator identity changed');

      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('rejects stale discovery even when health is ready', async () => {
      makeHome();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, { instanceId: 'stale-coordinator' });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
      });

      const { ensure } = await importEnsure();

      await expect(ensure(root)).rejects.toThrow('discovery does not match the observed parent');
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('leaves a startup sentinel untouched while waiting for its exact parent', async () => {
      makeHome();
      vi.useFakeTimers();
      const root = createPluginRoot();
      setCompleteChildEnv();
      const paths = coordinatorPaths('prod');
      mkdirSync(paths.runDir, { recursive: true });
      writeFileSync(paths.startupErrorFile, '{"dead":"sentinel"}\n', 'utf-8');
      mockState.health.mockResolvedValue({
        status: 'starting',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
      });

      const { ensure, KERNEL_READY_DEADLINE_MS, STARTUP_POLL_MS } = await importEnsure();
      const result = ensure(root).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(KERNEL_READY_DEADLINE_MS + STARTUP_POLL_MS);
      const error = await result;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('timed out waiting for the observed parent');
      expect(readFileSync(paths.startupErrorFile, 'utf-8')).toBe('{"dead":"sentinel"}\n');
      expect(mockState.spawn).not.toHaveBeenCalled();
    });
  });

  it('should reuse a same-bundle older-version incumbent without changing its instance', async () => {
    makeHome();
    const root = createPluginRoot('prod', '0.9.1');
    writeDiscovery(root, {
      version: '0.8.7',
      port: 4202,
      token: 'old-token',
      instanceId: 'old-coordinator',
    });

    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.8.7',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'old-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.version).toBe('0.8.7');
    expect(ensured.instanceId).toBe('old-coordinator');
    expect(mockState.shutdown).not.toHaveBeenCalled();
    expect(mockState.bindSocket).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('waits for coordinator.json when health reports starting and returns the merged client', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    let healthCalls = 0;
    mockState.health.mockImplementation(async () => {
      healthCalls += 1;
      if (healthCalls === 1) {
        return {
          status: 'starting',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'starting-coordinator',
          namespace: pluginRootNamespace(root),
        };
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'ready-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });

    setTimeout(() => {
      writeDiscovery(root, { port: 4220, token: 'ready-token', instanceId: 'ready-coordinator' });
    }, 100);

    const { ensure, STARTUP_POLL_MS } = await importEnsure();
    expect(STARTUP_POLL_MS).toBe(200);
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('ready-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('keeps the existing-starting wait bounded without spawning another coordinator', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    mockState.health.mockResolvedValue({
      status: 'starting',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'starting-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure, KERNEL_READY_DEADLINE_MS, STARTUP_POLL_MS } = await importEnsure();
    const result = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(KERNEL_READY_DEADLINE_MS + STARTUP_POLL_MS);
    const error = await result;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Timed out waiting for Coral coordinator startup');
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('should wait for a draining incumbent to release the socket before spawning', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4230,
      token: 'old-token',
      instanceId: 'draining-coordinator',
    });

    let healthCalls = 0;
    mockState.health.mockImplementation(async () => {
      healthCalls += 1;
      if (healthCalls === 1) {
        return {
          status: 'draining',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'draining-coordinator',
          namespace: pluginRootNamespace(root),
        };
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'replacement-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });

    let bindCalls = 0;
    mockState.bindSocket.mockImplementation(async () => {
      bindCalls += 1;
      if (bindCalls === 1) return { kind: 'incumbent', reason: 'live-listener' };
      return { kind: 'bound' };
    });

    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, {
        port: 4231,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return spawnedChild();
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  it('should reuse a healthy foreign-build incumbent without changing its instance', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4240,
      token: 'old-token',
      instanceId: 'old-coordinator',
      bundleHash: 'old-hash',
    });

    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.5.2',
      bundleHash: 'old-hash',
      flavor: 'prod',
      instanceId: 'old-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.instanceId).toBe('old-coordinator');
    expect(ensured.bundleHash).toBe('old-hash');
    expect(mockState.shutdown).not.toHaveBeenCalled();
    expect(mockState.bindSocket).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('retries once after a single dropped authenticated health reply instead of spawning a competitor', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4270,
      token: 'existing-token',
      instanceId: 'existing-coordinator',
    });

    let calls = 0;
    mockState.health.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        // Simulate a single dropped authenticated round-trip: the
        // unauthenticated `ping` moments earlier already proved the
        // incumbent is live, so this one failure is IPC noise, not evidence
        // the incumbent is gone.
        throw createErrnoError('ECONNRESET');
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'existing-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.instanceId).toBe('existing-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  it('should reuse a healthy foreign-build incumbent without a shutdown token', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4240,
      token: 'old-token',
      shutdownToken: null,
      instanceId: 'old-coordinator',
      bundleHash: 'old-hash',
    });

    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.5.2',
      bundleHash: 'old-hash',
      flavor: 'prod',
      instanceId: 'old-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.instanceId).toBe('old-coordinator');
    expect(mockState.shutdown).not.toHaveBeenCalled();
    expect(mockState.bindSocket).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('spawns fresh when health is unreachable and no coordinator is present', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    mockState.health.mockImplementation(async (currentSocketPath) => {
      if (currentSocketPath !== socketPath(root)) {
        throw new Error(`Unexpected socket path: ${currentSocketPath}`);
      }
      if (mockState.health.mock.calls.length < 3) {
        throw createErrnoError('ECONNREFUSED');
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'replacement-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, {
        port: 4250,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return spawnedChild();
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.spawn.mock.calls[0]?.[1]).toEqual([join(root, 'bridge', 'coral-backend.cjs')]);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  it('spawns backend from the active bundle directory when bundled', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const bundleDir = mkdtempSync(join(tmpdir(), 'coral-ipc-ensure-bundle-'));
    tempRoots.push(bundleDir);
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({ bundleHash: 'bundle-dir-hash', flavor: 'prod' }),
      'utf-8',
    );
    (globalThis as { __BUNDLE_DIR__?: string }).__BUNDLE_DIR__ = bundleDir;

    let spawned = false;
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        throw createErrnoError('ECONNREFUSED');
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'bundle-dir-hash',
        flavor: 'prod',
        instanceId: 'bundle-dir-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, {
        bundleHash: 'bundle-dir-hash',
        instanceId: 'bundle-dir-coordinator',
      });
      return spawnedChild();
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('bundle-dir-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.spawn.mock.calls[0]?.[1]).toEqual([join(bundleDir, 'coral-backend.cjs')]);
  });

  it('adopts a no-health socket-holder refusal after the drain deadline while its child remains alive', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    const child = spawnedChild();
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockState.spawn).toHaveBeenCalledOnce();
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), 30_400);
    await vi.advanceTimersByTimeAsync(30_800);
    const error = await ensuredPromise;

    expect(error).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('adopts a delegated-build sentinel with the exact attempt after the former 60.8 second ceiling', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    const child = spawnedChild();
    mockState.spawn.mockReturnValue(child);
    const context = {
      stage: 'after-sigkill-grace',
      pid: 99_999,
      signal: 'SIGKILL',
      graceMs: 30_000,
    } as const;
    const expected = documentedCoralSetupError('handoff_sigkill_grace_target_alive', context);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(
      () =>
        writeStartupSentinel(root, spawnedAttemptId(), {
          pid: 99_999,
          bundleHash: 'selected-build-hash',
          code: 'handoff_sigkill_grace_target_alive',
          userMessage: '\u001b[2Jprivate delegated startup text',
          remediation: 'Run a forged recovery command.',
          context,
        }),
      61_000,
    );
    await vi.advanceTimersByTimeAsync(61_400);
    const error = await ensuredPromise;

    expect(error).toMatchObject({
      code: expected.code,
      userMessage: expected.userMessage,
      remediation: expected.remediation,
    });
    expect(JSON.stringify(error)).not.toContain('private delegated startup text');
    expect(JSON.stringify(error)).not.toContain('forged recovery command');
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('adopts a sentinel written by a delegated build at another plugin root', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    const child = spawnedChild();
    mockState.spawn.mockReturnValue(child);
    const context = { stage: 'handoff-deadline', socketPath: socketPath(root) } as const;
    const expected = documentedCoralSetupError('handoff_socket_holder_unverified', context);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    // A delegated build runs from its own plugin root, so both halves of its build identity differ from the
    // invoking build's. Only the exact attempt id ties this record to the spawn being waited on.
    writeStartupSentinel(root, spawnedAttemptId(), {
      bundleHash: 'delegated-build-hash',
      namespace: 'delegated-plugin-root-namespace',
      code: 'handoff_socket_holder_unverified',
      userMessage: 'Handoff refused at the startup deadline.',
      remediation: 'Inspect the socket holder, then retry.',
      context,
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);

    await expect(ensuredPromise).resolves.toMatchObject({
      code: expected.code,
      userMessage: expected.userMessage,
      remediation: expected.remediation,
    });
  });

  it('leaves a foreign-namespace sentinel to its own build when no attempt id attributes it', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    mockState.health.mockResolvedValue({
      status: 'starting',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'starting-coordinator',
      namespace: pluginRootNamespace(root),
    });
    // A live pid, so nothing but the namespace can stop this record from being adopted and retired.
    writeStartupSentinel(root, 'foreign-attempt', { pid: process.pid, namespace: 'other-plugin-root-namespace' });

    const { ensure, KERNEL_READY_DEADLINE_MS, STARTUP_POLL_MS } = await importEnsure();
    const result = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(KERNEL_READY_DEADLINE_MS + STARTUP_POLL_MS);
    const error = await result;

    expect((error as Error).message).toContain('Timed out waiting for Coral coordinator startup');
    expect(readFileSync(coordinatorPaths('prod').startupErrorFile, 'utf-8')).toContain('other-plugin-root-namespace');
  });

  it('reports an unrecognized current-attempt setup-error code without exposing persisted prose', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    writeStartupSentinel(root, spawnedAttemptId(), {
      code: 'future_setup_refusal',
      userMessage: 'private future-build text',
      remediation: 'Run a forged future-build command.',
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("setup-error code 'future_setup_refusal'");
    expect((error as Error).message).toContain('could not prove which build recorded it');
    expect((error as Error).message).toContain('coral-cli backend status');
    expect((error as Error).message).not.toContain('upgrade Coral');
    expect((error as Error).message).not.toContain('private future-build text');
    expect((error as Error).message).not.toContain('forged future-build command');
  });

  // Around forty codes this build throws are outside the catalog. Regenerating from the catalog cannot render
  // any of them, and the arm that used to catch them told the operator to upgrade past a code this build wrote.
  it('raises the recorded refusal of an uncatalogued code this build proves it wrote', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.strictIdentity = { ok: true, manifest: provenManifest('test-hash') };
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    writeStartupSentinel(root, spawnedAttemptId(), {
      code: 'describer_missing',
      userMessage: 'Event describer missing for: job_started.',
      remediation: "Add an entry to the owning domain's event-describers.ts.",
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toMatchObject({
      code: 'describer_missing',
      userMessage: 'Event describer missing for: job_started.',
      remediation: "Add an entry to the owning domain's event-describers.ts.",
    });
    // Exact, not a substring: any other arm of the reader raises a different error whose message is prose
    // about the code rather than the refusal itself.
    expect((error as Error).message).toBe('Event describer missing for: job_started.');
  });

  it('refuses the recorded refusal of an uncatalogued code a delegated build wrote', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.strictIdentity = { ok: true, manifest: provenManifest('test-hash') };
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    writeStartupSentinel(root, spawnedAttemptId(), {
      bundleHash: 'delegated-build-hash',
      namespace: 'delegated-plugin-root-namespace',
      code: 'future_setup_refusal',
      userMessage: 'private future-build text',
      remediation: 'Run a forged future-build command.',
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect((error as Error).message).toContain("setup-error code 'future_setup_refusal'");
    expect((error as Error).message).toContain('recorded by a Coral build other than the one running here');
    expect((error as Error).message).toContain('upgrade Coral');
    expect((error as Error).message).not.toContain('private future-build text');
    expect((error as Error).message).not.toContain('forged future-build command');
  });

  it('reports an invalid current-attempt setup-error diagnostic instead of treating it as absent', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    writeStartupSentinel(root, spawnedAttemptId(), {
      error: {
        userMessage: 'private malformed-diagnostic text',
        remediation: 'Run a forged malformed-diagnostic command.',
      },
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('invalid setup-error diagnostic');
    expect((error as Error).message).toContain('coral-cli backend status');
    expect((error as Error).message).not.toContain('private malformed-diagnostic text');
    expect((error as Error).message).not.toContain('forged malformed-diagnostic command');
  });

  it.each([
    {
      failure: 'a discriminator owned by another refusal',
      code: 'handoff_fresh_discovery_unavailable',
      context: { stage: 'shutdown-request', pid: 4242 },
    },
    {
      failure: 'a missing required field',
      code: 'handoff_shutdown_credential_unavailable',
      context: { stage: 'shutdown-request' },
    },
  ])('reports $failure as an invalid current-attempt sentinel diagnostic', async ({ code, context }) => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    writeStartupSentinel(root, spawnedAttemptId(), {
      code,
      userMessage: 'private incompatible-context text',
      remediation: 'Run a forged incompatible-context command.',
      context,
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('invalid setup-error diagnostic');
    expect((error as Error).message).not.toContain('private incompatible-context text');
    expect((error as Error).message).not.toContain('forged incompatible-context command');
  });

  it('performs a final sentinel read when the child exits during the poll sleep', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockState.spawn).toHaveBeenCalledOnce();

    writeStartupSentinel(root, spawnedAttemptId(), {
      code: 'handoff_accepted_signal_target_alive_after_failure',
      userMessage: 'Handoff failed after an accepted signal.',
      remediation: 'Wait for shutdown to finish, then retry.',
      context: { stage: 'after-accepted-signal-failure', pid: 12_345, signal: 'SIGTERM' },
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);

    await expect(ensuredPromise).resolves.toMatchObject({
      code: 'handoff_accepted_signal_target_alive_after_failure',
    });
  });

  it('does not adopt a foreign-build incumbent as the ready result of the current attempt', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    let spawned = false;
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        throw createErrnoError('ECONNREFUSED');
      }
      return {
        status: 'ok',
        version: '0.5.1',
        bundleHash: 'old-hash',
        flavor: 'prod',
        instanceId: 'foreign-incumbent',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, {
        version: '0.5.1',
        bundleHash: 'old-hash',
        instanceId: 'foreign-incumbent',
      });
      return child;
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockState.spawn).toHaveBeenCalledOnce();

    writeStartupSentinel(root, spawnedAttemptId(), {
      code: 'handoff_accepted_signal_target_alive_after_failure',
      userMessage: 'Handoff failed after an accepted signal.',
      remediation: 'Wait for shutdown to finish, then retry.',
      context: { stage: 'after-accepted-signal-failure', pid: 12_345, signal: 'SIGTERM' },
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);

    await expect(ensuredPromise).resolves.toMatchObject({
      code: 'handoff_accepted_signal_target_alive_after_failure',
    });
  });

  it('adopts a different-identity coordinator reached through the current attempt delegation chain', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    let spawned = false;
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        throw createErrnoError('ECONNREFUSED');
      }
      return {
        status: 'ok',
        version: '0.5.3',
        bundleHash: 'selected-hash',
        flavor: 'prod',
        instanceId: 'selected-coordinator',
        namespace: pluginRootNamespace(root),
        env: { CORAL_STARTUP_ATTEMPT_ID: spawnedAttemptId() },
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, {
        version: '0.5.3',
        bundleHash: 'selected-hash',
        instanceId: 'selected-coordinator',
      });
      return spawnedChild();
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('selected-coordinator');
    expect(ensured.bundleHash).toBe('selected-hash');
    expect(mockState.spawn).toHaveBeenCalledOnce();
  });

  it('adopts the desired build from another attempt after the exact child terminates', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    let spawned = false;
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        throw createErrnoError('ECONNREFUSED');
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'winning-coordinator',
        namespace: pluginRootNamespace(root),
        env: { CORAL_STARTUP_ATTEMPT_ID: 'winning-attempt' },
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, { instanceId: 'winning-coordinator' });
      return child;
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(0);

    let settled = false;
    void ensuredPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('winning-coordinator');
    expect(ensured.bundleHash).toBe('test-hash');
  });

  it('returns the serving incumbent the child conceded to instead of calling it a failed startup', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    let spawned = false;
    // The pre-spawn probe lost its round trip, so this invocation spawned against a live incumbent. The
    // child then found the incumbent outranked it and exited 0 without writing a sentinel or a diagnostic.
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        throw createErrnoError('ECONNREFUSED');
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'rebuilt-in-place-hash',
        flavor: 'prod',
        instanceId: 'serving-incumbent',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, { bundleHash: 'rebuilt-in-place-hash', instanceId: 'serving-incumbent' });
      return child;
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(0);

    // While the exact child is live, nothing ties this coordinator to it, so the wait must not end here.
    let settled = false;
    void ensuredPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('serving-incumbent');
    expect(ensured.bundleHash).toBe('rebuilt-in-place-hash');
    expect(existsSync(coordinatorPaths('prod').startupErrorFile)).toBe(false);
  });

  it('waits out a starting incumbent the child conceded to instead of failing the invocation', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    let spawned = false;
    let incumbentReady = false;
    // Two invocations found no socket and both spawned. The incumbent bound first and is still running its
    // boot eras, so it answers `starting`; this invocation's own child saw that it was outranked and exited 0
    // without writing a sentinel. `starting` is not a ready status, so no serving incumbent exists to adopt.
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        throw createErrnoError('ECONNREFUSED');
      }
      return {
        status: incumbentReady ? 'ok' : 'starting',
        version: '0.5.2',
        bundleHash: 'incumbent-hash',
        flavor: 'prod',
        instanceId: 'starting-incumbent',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, { bundleHash: 'incumbent-hash', instanceId: 'starting-incumbent' });
      return child;
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    let settled = false;
    void ensuredPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(false);

    incumbentReady = true;
    await vi.advanceTimersByTimeAsync(1_000);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('starting-incumbent');
    expect(ensured.bundleHash).toBe('incumbent-hash');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('treats child error without exit as terminal without exposing its text', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    const lifecycleSecret = 'private spawn lifecycle failure';
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('error', new Error(lifecycleSecret));
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'The spawned Coral coordinator stopped before binding or becoming ready. Run `coral-cli backend status` to inspect the recorded startup outcome.',
    );
    expect((error as Error).message).not.toContain(lifecycleSecret);
  });

  it.each([
    { code: 0, signal: null },
    { code: 23, signal: null },
    { code: null, signal: 'SIGTERM' as const },
  ])('treats child exit code=$code signal=$signal without a sentinel as terminal', async ({ code, signal }) => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', code, signal);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'The spawned Coral coordinator stopped before binding or becoming ready. Run `coral-cli backend status` to inspect the recorded startup outcome.',
    );
  });

  it('rejects a wrong-attempt sentinel after the exact child becomes terminal', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    writeStartupSentinel(root, 'another-attempt');
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'The spawned Coral coordinator stopped before binding or becoming ready. Run `coral-cli backend status` to inspect the recorded startup outcome.',
    );
    expect(readFileSync(coordinatorPaths('prod').startupErrorFile, 'utf-8')).toContain('another-attempt');
  });

  it('keeps a live current attempt waiting past every elapsed-time budget without spawning a competitor', async () => {
    makeHome();
    vi.useFakeTimers();
    const startMs = Date.now();
    const root = createPluginRoot();

    mockState.health.mockImplementation(async () => {
      const elapsed = Date.now() - startMs;
      if (elapsed < 4_800) {
        throw createErrnoError('ECONNREFUSED');
      }
      if (!existsSync(discoveryPath(root))) {
        return {
          status: 'starting',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'booting-coordinator',
          namespace: pluginRootNamespace(root),
        };
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'ready-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockReturnValue(spawnedChild());
    setTimeout(() => {
      writeDiscovery(root, {
        port: 4255,
        token: 'ready-token',
        instanceId: 'ready-coordinator',
      });
    }, 19_000);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(20_000);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('ready-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('should poll bindSocket repeatedly while a draining incumbent socket is still bound', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4260,
      token: 'stuck-token',
      instanceId: 'stuck-coordinator',
      bundleHash: 'old-hash',
    });

    let bindCalls = 0;
    mockState.bindSocket.mockImplementation(async () => {
      bindCalls += 1;
      if (bindCalls < 3) return { kind: 'incumbent', reason: 'live-listener' };
      return { kind: 'bound' };
    });

    let spawned = false;
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        return {
          status: 'draining',
          version: '0.5.2',
          bundleHash: 'old-hash',
          flavor: 'prod',
          instanceId: 'stuck-coordinator',
          namespace: pluginRootNamespace(root),
        };
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'replacement-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, {
        port: 4261,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return spawnedChild();
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(2_000);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(bindCalls).toBeGreaterThanOrEqual(3);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  // A refusal that no wait can clear must not be spent as drain time and reported as a timeout: the release
  // probe answers a two-valued question, and the third answer leaves through the error channel instead.
  it('surfaces a documented bind refusal instead of draining against it', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4262,
      token: 'refused-token',
      instanceId: 'refused-coordinator',
      bundleHash: 'old-hash',
    });
    mockState.health.mockResolvedValue({
      status: 'draining',
      version: '0.5.2',
      bundleHash: 'old-hash',
      flavor: 'prod',
      instanceId: 'refused-coordinator',
      namespace: pluginRootNamespace(root),
    });
    const { ensure } = await importEnsure();
    const { documentedCoralSetupError } = await import('#src/runtime/errors.js');
    mockState.bindSocket.mockRejectedValue(
      documentedCoralSetupError({
        code: 'coordinator_socket_dir_unverified',
        directory: '/tmp/coral-1000',
        cause: 'EIO: i/o error, lstat',
      }),
    );

    await expect(ensure(root)).rejects.toThrow(expect.objectContaining({ code: 'coordinator_socket_dir_unverified' }));
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  describe('coordinator.log rotation on spawn', () => {
    function runDir(): string {
      return coordinatorPaths('prod').runDir;
    }

    function logPath(): string {
      return join(runDir(), 'coordinator.log');
    }

    function archivePath(): string {
      return `${logPath()}.1`;
    }

    async function triggerFreshSpawn(root: string): Promise<void> {
      vi.useFakeTimers();
      mockState.health.mockImplementation(async () => {
        if (mockState.health.mock.calls.length < 3) {
          throw createErrnoError('ECONNREFUSED');
        }
        return {
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'replacement-coordinator',
          namespace: pluginRootNamespace(root),
        };
      });
      mockState.spawn.mockImplementation(() => {
        writeDiscovery(root, { instanceId: 'replacement-coordinator' });
        return spawnedChild();
      });

      const { ensure } = await importEnsure();
      const ensuredPromise = ensure(root);
      await vi.advanceTimersByTimeAsync(800);
      await ensuredPromise;
    }

    it('leaves a small log alone (no archive created)', async () => {
      makeHome();
      const root = createPluginRoot();
      mkdirSync(runDir(), { recursive: true });
      writeFileSync(logPath(), 'small log content', 'utf-8');

      await triggerFreshSpawn(root);

      expect(existsSync(archivePath())).toBe(false);
      expect(readFileSync(logPath(), 'utf-8')).toContain('small log content');
    });

    it('archives a log over threshold to .1 and starts a fresh log', async () => {
      makeHome();
      const root = createPluginRoot();
      mkdirSync(runDir(), { recursive: true });
      const sentinel = 'OLD-CONTENT-MARKER';
      const padding = 'x'.repeat(3 * 1024 * 1024);
      writeFileSync(logPath(), `${sentinel}\n${padding}`, 'utf-8');

      await triggerFreshSpawn(root);

      expect(existsSync(archivePath())).toBe(true);
      expect(readFileSync(archivePath(), 'utf-8')).toContain(sentinel);
      expect(statSync(logPath()).size).toBe(0);
    });

    it('discards an existing .1 when rotating (single backup retained)', async () => {
      makeHome();
      const root = createPluginRoot();
      mkdirSync(runDir(), { recursive: true });
      writeFileSync(archivePath(), 'STALE-ARCHIVE-MARKER', 'utf-8');
      const sentinel = 'CURRENT-LOG-MARKER';
      const padding = 'y'.repeat(3 * 1024 * 1024);
      writeFileSync(logPath(), `${sentinel}\n${padding}`, 'utf-8');

      await triggerFreshSpawn(root);

      const archived = readFileSync(archivePath(), 'utf-8');
      expect(archived).toContain(sentinel);
      expect(archived).not.toContain('STALE-ARCHIVE-MARKER');
    });

    it('handles missing log (first boot) without error', async () => {
      makeHome();
      const root = createPluginRoot();

      await triggerFreshSpawn(root);

      expect(existsSync(archivePath())).toBe(false);
      expect(existsSync(logPath())).toBe(true);
    });
  });
});
