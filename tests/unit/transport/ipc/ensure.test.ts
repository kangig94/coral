import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type * as IpcClientMod from '#src/transport/ipc/client.js';
import type * as UpgradeIntentMod from '#src/infra/upgrade-intent.js';
import type * as NodeProcessMod from '#src/infra/node-process.js';
import { probeProcessIncarnation, type ProcessIncarnation, type ProcessLiveness } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { coordinatorPaths, v0109CoordinatorSocketGuardSetForRunDir } from '#src/infra/path/coordinator.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { requestLegacyUpgrade } from '#src/upgrade-waiter/start.js';
import { createRealUpgradeWaiterPorts } from '#src/runtime/upgrade-waiter.js';
import { upgradeIntentPath } from '#src/infra/path/coordinator.js';
import {
  readBuildFlavor,
  type StrictBundleIdentityResult,
  type StrictBundleManifest,
} from '#src/infra/bundle-manifest.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import { TOOL_TIMEOUT_MS } from '#src/transport/http/sse.js';
import { IpcRpcError, type IpcClient } from '#src/transport/ipc/client.js';
import { jobsAbortRpcSpec, providerProxySetContainRpcSpec } from '#src/transport/rpc/catalog.js';

const mockState = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args?: readonly string[], options?: unknown) => ChildProcess>(),
  health: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  request: vi.fn<(socketPath: string, method: string, params?: unknown, options?: unknown) => Promise<unknown>>(),
  shutdown: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  bindSocket: vi.fn<() => Promise<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }>>(),
  createdClients: [] as Array<{ socketPath: string; auth: unknown }>,
  healthReads: [] as Array<{ method: 'ping' | 'health'; options: unknown }>,
  home: '',
  platform: process.platform,
  /** What this build can prove about its own bundle; a unit run has no injected identity, so default is a refusal. */
  strictIdentity: { ok: false, reason: 'embedded_identity_unavailable' } as StrictBundleIdentityResult,
  /** Overrides for the recorded owner's observed state; `null` leaves the real probe in charge. */
  ownerLiveness: null as ProcessLiveness | null,
  ownerIncarnationUnprobeable: false,
  validUpgradeTargetRoot: null as string | null,
  localInterfaces: null as ReturnType<typeof NodeOs.networkInterfaces> | null,
}));

vi.mock('#src/infra/upgrade-intent.js', async (loadOriginal) => {
  const actual = await loadOriginal<typeof UpgradeIntentMod>();
  return {
    ...actual,
    revalidateUpgradeIntentTarget: (intent: UpgradeIntentMod.UpgradeIntent) =>
      intent.target.pluginRootLabel === mockState.validUpgradeTargetRoot
        ? ({ kind: 'validated' } as ReturnType<typeof actual.revalidateUpgradeIntentTarget>)
        : actual.revalidateUpgradeIntentTarget(intent),
  };
});

vi.mock('#src/infra/node-process.js', async () => {
  const actual = await vi.importActual<typeof NodeProcessMod>('#src/infra/node-process.js');
  return {
    ...actual,
    observeProcessLiveness: (pid: number): ProcessLiveness => {
      if (mockState.ownerLiveness !== null) return mockState.ownerLiveness;
      return actual.observeProcessLiveness(pid);
    },
    probeProcessIncarnation: (pid: number, platform?: NodeJS.Platform) =>
      mockState.ownerIncarnationUnprobeable ? null : actual.probeProcessIncarnation(pid, platform),
  };
});

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
    networkInterfaces: () => mockState.localInterfaces ?? actual.networkInterfaces(),
  };
});

// `IpcLifecycleRefusal` stays real: the lifecycle fallback decides on the thrown class, so a stubbed
// stand-in would let a test pass against a fallback that never recognized a refusal.
vi.mock('#src/transport/ipc/client.js', async () => {
  const actual = await vi.importActual<typeof IpcClientMod>('#src/transport/ipc/client.js');
  return {
    ...actual,
    createIpcClient: (socketPath: string, _time?: unknown, auth?: unknown) => {
      mockState.createdClients.push({ socketPath, auth });
      const readHealth = async (options?: unknown): Promise<unknown> => {
        const health = await mockState.health(socketPath, options);
        return typeof health === 'object' && health !== null && 'instanceId' in health && !('pid' in health)
          ? { ...health, pid: process.pid }
          : health;
      };
      return {
        socketPath,
        request: (method: string, params?: unknown, options?: unknown) =>
          mockState.request(socketPath, method, params, options),
        ping: (options?: unknown) => {
          mockState.healthReads.push({ method: 'ping', options });
          return readHealth(options);
        },
        health: (options?: unknown) => {
          mockState.healthReads.push({ method: 'health', options });
          return readHealth(options);
        },
        shutdown: (options?: unknown) => mockState.shutdown(socketPath, options),
      };
    },
  };
});

// Stub bindSocket so probeSocketReleased's behavior is deterministic without
// real fs sockets. Default: socket is released (returns 'bound').
vi.mock('#src/transport/ipc/server.js', () => ({
  bindSocket: () => mockState.bindSocket(),
}));

const tempRoots: string[] = [];

function makeHome(deep = false): string {
  const root = mkdtempSync(join(tmpdir(), `coral-ipc-ensure-home-${deep ? 'x'.repeat(100) : ''}-`));
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
    bindHost: string;
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
      bindHost: overrides.bindHost ?? '127.0.0.1',
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
    durableWrapperBundleHash: bundleHash,
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
  mockState.ownerLiveness = null;
  mockState.ownerIncarnationUnprobeable = false;
  mockState.localInterfaces = null;
  mockState.validUpgradeTargetRoot = null;
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
  mockState.request.mockReset();
  mockState.shutdown.mockReset();
  mockState.bindSocket.mockReset();
  mockState.bindSocket.mockResolvedValue({ kind: 'bound' });
  mockState.createdClients.length = 0;
  mockState.healthReads.length = 0;
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

    expect(mayInvocationBeServedByIncumbent(health, 'running')).toBe(true);
    expect(mayInvocationBeServedByIncumbent({ ...health, status: 'draining' }, 'running')).toBe(false);
    expect(mayInvocationBeServedByIncumbent(null, 'running')).toBe(false);

    expect(mayInvocationBeServedByIncumbent(health, 'running-or-draining')).toBe(true);
    expect(mayInvocationBeServedByIncumbent({ ...health, status: 'draining' }, 'running-or-draining')).toBe(true);
    expect(mayInvocationBeServedByIncumbent(null, 'running-or-draining')).toBe(false);

    // Replacement does not move with the route's admission: a draining incumbent stays replaceable so an
    // admitted route that could not be served by it still has a successor to reach.
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
    const ensured = await ensure('sessions.create', root);

    expect(ensured.instanceId).toBe('existing-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(mockState.shutdown).not.toHaveBeenCalled();
    expect(mockState.createdClients).toContainEqual({
      socketPath: socketPath(root),
      auth: { kind: 'boot', token: 'test-boot-token' },
    });
  });

  it.each([
    { advertised: ['supportsWaitV2', 'supportsHandover'], expected: ['supportsWaitV2', 'supportsHandover'] },
    { advertised: undefined, expected: [] },
    { advertised: 'supportsWaitV2', expected: [] },
  ])('should carry wait extensions $advertised as $expected', async ({ advertised, expected }) => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4202, token: 'existing-token', instanceId: 'existing-coordinator' });
    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'existing-coordinator',
      namespace: pluginRootNamespace(root),
      ...(advertised === undefined ? {} : { jobsWaitExtensions: advertised }),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure('jobs.wait', root);

    expect(ensured.instanceId).toBe('existing-coordinator');
    expect(ensured.jobsWaitExtensions).toEqual(expected);
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
    const ensured = await ensure('sessions.create', root);

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
      const ensured = await ensure('sessions.create', root);

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

      await expect(ensure('sessions.create', root)).rejects.toThrow(
        'Nested Coral command stopped because its parent coordinator is unreachable',
      );
      expect(existsSync(discoveryPath(root))).toBe(false);
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('refuses a startup request from a child without starting or replacing anything', async () => {
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

      const { ensureRunningCoordinator } = await importEnsure();

      await expect(ensureRunningCoordinator(root)).rejects.toThrow('parent coordinator is draining');
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('waits past a kernel-ready parent before answering a startup request from a child', async () => {
      makeHome();
      vi.useFakeTimers();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, { instanceId: 'parent-coordinator' });
      const statuses = ['kernel-ready', 'kernel-ready', 'kernel-ready', 'ok'];
      let healthCalls = 0;
      mockState.health.mockImplementation(async () => ({
        status: statuses[Math.min(healthCalls++, statuses.length - 1)],
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'parent-coordinator',
        namespace: pluginRootNamespace(root),
      }));

      const { ensureRunningCoordinator } = await importEnsure();
      let settled = false;
      const ensuredPromise = ensureRunningCoordinator(root).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await ensuredPromise;
      expect(mockState.spawn).not.toHaveBeenCalled();
      // A child's client carries no principal, and `transport.health` requires one.
      expect(mockState.healthReads.filter(({ method }) => method === 'health')).toEqual([]);
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

      await expect(ensure('sessions.create', root)).rejects.toThrow('parent coordinator is draining');
      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('refuses a draining parent even for a route the catalog admits while draining', async () => {
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

      await expect(ensure('jobs.abort', root)).rejects.toThrow('parent coordinator is draining');
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
      const result = ensure('sessions.create', root);
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
      const result = ensure('sessions.create', root).catch((error: unknown) => error);
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

      await expect(ensure('sessions.create', root)).rejects.toThrow('discovery does not match the observed parent');
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

      await expect(ensure('sessions.create', root)).rejects.toThrow('discovery does not match the observed parent');
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
      const ensured = ensure('sessions.create', root);
      const result = ensured.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(400);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('coordinator identity changed');

      expect(mockState.shutdown).not.toHaveBeenCalled();
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('follows the exact successor named by a completed serving receipt', async () => {
      makeHome();
      vi.useFakeTimers();
      const root = createPluginRoot();
      setCompleteChildEnv();
      writeDiscovery(root, { instanceId: 'parent-coordinator' });
      const successorBuild = {
        version: '0.5.3',
        buildSetId: 'next-build',
        flavor: 'prod' as const,
        storeFormatFingerprint: 'same-format',
        bundleHash: 'new-hash',
        cliBundleHash: 'new-cli',
        claudeAppserverBundleHash: 'new-appserver',
        durableWrapperBundleHash: 'new-wrapper',
      };
      mockState.health
        .mockResolvedValueOnce({
          status: 'starting',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'parent-coordinator',
          namespace: pluginRootNamespace(root),
          pid: process.pid,
        })
        .mockResolvedValue({
          status: 'ok',
          version: successorBuild.version,
          bundleHash: successorBuild.bundleHash,
          flavor: 'prod',
          instanceId: 'committed-successor',
          namespace: 'successor-namespace',
          pid: process.pid,
        });
      setTimeout(() => {
        writeFileSync(
          upgradeIntentPath(coordinatorPaths('prod').runDir),
          JSON.stringify({
            version: 'v1',
            requestId: 'upgrade-1',
            revision: 1,
            incumbent: {
              instanceId: 'parent-coordinator',
              pid: process.pid,
              incarnation: null,
              version: '0.5.2',
              bundleHash: 'test-hash',
              flavor: 'prod',
            },
            target: { pluginRootLabel: root, build: successorBuild },
            attemptId: 'attempt-1',
            attemptOwner: { kind: 'incumbent', instanceId: 'parent-coordinator', pid: process.pid, incarnation: null },
            disposition: 'completed',
            blockers: [],
            retryCondition: null,
            attemptDeadline: '2099-01-01T00:01:00.000Z',
            completionReceipt: {
              kind: 'serving',
              attemptId: 'attempt-1',
              successor: {
                instanceId: 'committed-successor',
                pid: process.pid,
                incarnation: null,
                build: successorBuild,
              },
              epochKey: 'epoch-1:lineage-1',
              controlGeneration: 2,
              acceptedObligations: [],
              recordedAt: '2099-01-01T00:00:00.000Z',
            },
          }),
        );
        writeDiscovery(root, {
          instanceId: 'committed-successor',
          version: successorBuild.version,
          bundleHash: successorBuild.bundleHash,
          namespace: 'successor-namespace',
        });
      }, 100);

      const { ensure } = await importEnsure();
      const result = ensure('sessions.create', root);
      await vi.advanceTimersByTimeAsync(400);
      expect((await result).instanceId).toBe('committed-successor');
      expect(mockState.spawn).not.toHaveBeenCalled();
      expect(mockState.shutdown).not.toHaveBeenCalled();
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

      await expect(ensure('sessions.create', root)).rejects.toThrow('discovery does not match the observed parent');
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
      const result = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const ensured = await ensure('sessions.create', root);

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
    const ensuredPromise = ensure('sessions.create', root);
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
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const ensuredPromise = ensure('sessions.create', root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  it('replaces a draining incumbent for a startup request instead of returning it', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4233, token: 'old-token', instanceId: 'draining-coordinator' });
    let healthCalls = 0;
    mockState.health.mockImplementation(async () => {
      healthCalls += 1;
      return {
        status: healthCalls === 1 ? 'draining' : 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: healthCalls === 1 ? 'draining-coordinator' : 'replacement-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    let bindCalls = 0;
    mockState.bindSocket.mockImplementation(async () => {
      bindCalls += 1;
      return bindCalls === 1 ? { kind: 'incumbent', reason: 'live-listener' } : { kind: 'bound' };
    });
    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, { port: 4234, token: 'replacement-token', instanceId: 'replacement-coordinator' });
      return spawnedChild();
    });

    const { ensureRunningCoordinator } = await importEnsure();
    const ensuredPromise = ensureRunningCoordinator(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('waits past kernel-ready for a startup request and resolves only once the coordinator is running', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4235, token: 'ready-token', instanceId: 'booting-coordinator' });
    const statuses = ['kernel-ready', 'kernel-ready', 'kernel-ready', 'ok'];
    let healthCalls = 0;
    mockState.health.mockImplementation(async () => ({
      status: statuses[Math.min(healthCalls++, statuses.length - 1)],
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'booting-coordinator',
      namespace: pluginRootNamespace(root),
    }));

    const { ensureRunningCoordinator } = await importEnsure();
    let settled = false;
    const ensuredPromise = ensureRunningCoordinator(root).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('booting-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('refuses a startup request whose coordinator begins draining before it is running', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4236, token: 'ready-token', instanceId: 'booting-coordinator' });
    const statuses = ['kernel-ready', 'kernel-ready', 'draining'];
    let healthCalls = 0;
    mockState.health.mockImplementation(async () => ({
      status: statuses[Math.min(healthCalls++, statuses.length - 1)],
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'booting-coordinator',
      namespace: pluginRootNamespace(root),
    }));

    const { ensureRunningCoordinator } = await importEnsure();
    const ensuredPromise = ensureRunningCoordinator(root);
    const refusal = expect(ensuredPromise).rejects.toThrow('began draining before its startup completed');
    await vi.advanceTimersByTimeAsync(2_000);
    await refusal;
  });

  it('gives up on a startup request whose coordinator never finishes starting', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4237, token: 'ready-token', instanceId: 'stuck-coordinator' });
    mockState.health.mockResolvedValue({
      status: 'kernel-ready',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'stuck-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensureRunningCoordinator, KERNEL_READY_DEADLINE_MS } = await importEnsure();
    const ensuredPromise = ensureRunningCoordinator(root);
    const refusal = expect(ensuredPromise).rejects.toThrow('last observation: kernel-ready');
    await vi.advanceTimersByTimeAsync(KERNEL_READY_DEADLINE_MS + 1_000);
    await refusal;
  });

  it('bounds every startup poll and survives a poll that goes unanswered', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4238, token: 'ready-token', instanceId: 'booting-coordinator' });
    const sequence: Array<string | Error> = [
      ...Array.from({ length: 5 }, () => 'kernel-ready'),
      new Error('connection reset'),
      'ok',
    ];
    let healthCalls = 0;
    mockState.health.mockImplementation(async () => {
      const next = sequence[Math.min(healthCalls++, sequence.length - 1)];
      if (next instanceof Error) throw next;
      return {
        status: next,
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'booting-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });

    const { ensureRunningCoordinator } = await importEnsure();
    const ensuredPromise = ensureRunningCoordinator(root);
    await vi.advanceTimersByTimeAsync(3_000);
    await ensuredPromise;

    expect(healthCalls).toBeGreaterThan(sequence.length - 1);
    const lastPoll = mockState.healthReads.at(-1);
    expect(lastPoll?.method).toBe('ping');
    expect((lastPoll?.options as { timeoutMs?: number } | undefined)?.timeoutMs).toBeGreaterThan(0);
  });

  it('serves a draining incumbent for a route the catalog admits while draining', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4232,
      token: 'draining-token',
      instanceId: 'draining-coordinator',
    });
    mockState.health.mockResolvedValue({
      status: 'draining',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'draining-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure('jobs.abort', root);

    expect(ensured.instanceId).toBe('draining-coordinator');
    expect(mockState.bindSocket).not.toHaveBeenCalled();
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(mockState.shutdown).not.toHaveBeenCalled();
    expect(mockState.createdClients).toContainEqual({
      socketPath: socketPath(root),
      auth: { kind: 'boot', token: 'test-boot-token' },
    });
  });

  it('bounds a reached draining incumbent at the drain budget and leaves a serving one uncapped', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4236, instanceId: 'one-coordinator' });
    const health = {
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod' as const,
      instanceId: 'one-coordinator',
      namespace: pluginRootNamespace(root),
    };
    mockState.request.mockResolvedValue({ aborted: [] });

    const { ensure, HANDOFF_DRAIN_TIMEOUT_MS } = await importEnsure();

    mockState.health.mockResolvedValue({ ...health, status: 'draining' });
    await (await ensure('jobs.abort', root)).request('jobs.abort', {}, { timeoutMs: TOOL_TIMEOUT_MS });

    expect(mockState.request).toHaveBeenLastCalledWith(
      socketPath(root),
      'jobs.abort',
      {},
      expect.objectContaining({ timeoutMs: HANDOFF_DRAIN_TIMEOUT_MS }),
    );

    // A caller budget of zero means unbounded downstream, so the bound may not take it as the smaller one.
    await (await ensure('jobs.abort', root)).request('jobs.abort', {}, { timeoutMs: 0 });

    expect(mockState.request).toHaveBeenLastCalledWith(
      socketPath(root),
      'jobs.abort',
      {},
      expect.objectContaining({ timeoutMs: HANDOFF_DRAIN_TIMEOUT_MS }),
    );

    mockState.health.mockResolvedValue({ ...health, status: 'ok' });
    await (await ensure('jobs.abort', root)).request('jobs.abort', {}, { timeoutMs: TOOL_TIMEOUT_MS });

    expect(mockState.request).toHaveBeenLastCalledWith(
      socketPath(root),
      'jobs.abort',
      {},
      expect.objectContaining({ timeoutMs: TOOL_TIMEOUT_MS }),
    );
  });

  it('answers its own expiring bound with an unknown disposition rather than an unattributed failure', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4237, instanceId: 'one-coordinator' });
    mockState.health.mockResolvedValue({
      status: 'draining',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'one-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure, HANDOFF_DRAIN_TIMEOUT_MS } = await importEnsure();
    const { IpcDrainRequestUnanswered, IpcRequestTimeout } = await import('#src/transport/ipc/client.js');

    mockState.request.mockRejectedValue(new IpcRequestTimeout('IPC request timed out after 29876ms'));
    const client = await ensure('jobs.abort', root);
    const raised: unknown = await client.request('jobs.abort', {}, { timeoutMs: TOOL_TIMEOUT_MS }).then(
      (result: unknown) => result,
      (error: unknown) => error,
    );

    expect(raised).toBeInstanceOf(IpcDrainRequestUnanswered);
    expect(raised).toMatchObject({
      code: 'coordinator_drain_unanswered',
      method: 'jobs.abort',
      socketPath: socketPath(root),
      budgetMs: HANDOFF_DRAIN_TIMEOUT_MS,
    });
    expect((raised as Error).message).toContain('whether jobs.abort ran is unknown');
    expect(mockState.spawn).not.toHaveBeenCalled();

    // A caller whose own smaller budget expired was never bounded here, so it keeps its own outcome.
    mockState.request.mockRejectedValue(new IpcRequestTimeout('IPC request timed out after 900ms'));
    const unbounded: unknown = await client.request('jobs.abort', {}, { timeoutMs: 1_000 }).then(
      (result: unknown) => result,
      (error: unknown) => error,
    );

    expect(unbounded).toBeInstanceOf(IpcRequestTimeout);
    expect(unbounded).not.toBeInstanceOf(IpcDrainRequestUnanswered);
  });

  describe('lifecycle refusal from a reached incumbent', () => {
    const successorDischargeableMethods = [jobsAbortRpcSpec.name, providerProxySetContainRpcSpec.name] as const;

    function drainingIncumbent(root: string): void {
      writeDiscovery(root, { port: 4270, token: 'draining-token', instanceId: 'draining-coordinator' });
      mockState.health.mockImplementation(async () => ({
        status: mockState.spawn.mock.calls.length === 0 ? 'draining' : 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: mockState.spawn.mock.calls.length === 0 ? 'draining-coordinator' : 'successor-coordinator',
        namespace: pluginRootNamespace(root),
      }));
      mockState.spawn.mockImplementation(() => {
        writeDiscovery(root, { port: 4271, token: 'successor-token', instanceId: 'successor-coordinator' });
        return spawnedChild();
      });
    }

    function reachedInstanceId(client: Pick<IpcClient, 'request'>): string {
      return (client as unknown as { instanceId: string }).instanceId;
    }

    it.each(successorDischargeableMethods)(
      're-issues %s once on the successor after the refusing incumbent releases the address',
      async (method) => {
        makeHome();
        vi.useFakeTimers();
        const root = createPluginRoot();
        drainingIncumbent(root);
        let bindCalls = 0;
        mockState.bindSocket.mockImplementation(async () => {
          bindCalls += 1;
          return bindCalls === 1 ? { kind: 'incumbent', reason: 'live-listener' } : { kind: 'bound' };
        });

        const { issueWithSuccessorAfterLifecycleRefusal } = await importEnsure();
        const { IpcLifecycleRefusal } = await import('#src/transport/ipc/client.js');
        const reached: string[] = [];
        const issue = vi.fn(async (client: Pick<IpcClient, 'request'>) => {
          const instanceId = reachedInstanceId(client);
          reached.push(instanceId);
          if (instanceId === 'draining-coordinator') throw new IpcLifecycleRefusal(socketPath(root), method);
          return `answered-by-${instanceId}`;
        });

        const issued = issueWithSuccessorAfterLifecycleRefusal(method, root, issue);
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(issued).resolves.toBe('answered-by-successor-coordinator');
        expect(reached).toEqual(['draining-coordinator', 'successor-coordinator']);
        expect(bindCalls).toBeGreaterThan(1);
        expect(mockState.spawn).toHaveBeenCalledTimes(1);
        expect(mockState.shutdown).not.toHaveBeenCalled();
      },
    );

    it.each(successorDischargeableMethods)(
      'raises the refusal of %s when the refusing incumbent keeps the address past the drain budget',
      async (method) => {
        makeHome();
        vi.useFakeTimers();
        const root = createPluginRoot();
        drainingIncumbent(root);
        mockState.bindSocket.mockResolvedValue({ kind: 'incumbent', reason: 'live-listener' });

        const { issueWithSuccessorAfterLifecycleRefusal, HANDOFF_DRAIN_TIMEOUT_MS } = await importEnsure();
        const { IpcLifecycleRefusal } = await import('#src/transport/ipc/client.js');
        const { buildErrorEnvelope } = await import('#src/cli/errors.js');
        const issue = vi.fn(async () => {
          throw new IpcLifecycleRefusal(socketPath(root), method);
        });

        const issued: Promise<unknown> = issueWithSuccessorAfterLifecycleRefusal(method, root, issue).then(
          (result: unknown) => result,
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(HANDOFF_DRAIN_TIMEOUT_MS + 2_000);
        const raised: unknown = await issued;

        expect(raised).toBeInstanceOf(IpcLifecycleRefusal);
        expect(raised).toMatchObject({ code: 'backend_shutting_down', method, socketPath: socketPath(root) });
        expect((raised as Error).message).toContain(method);
        expect((raised as Error).message).toContain('still held that address');
        expect((raised as Error).message).not.toContain('while draining');
        expect(issue).toHaveBeenCalledTimes(1);
        expect(mockState.spawn).not.toHaveBeenCalled();

        const { envelope, exitCode } = buildErrorEnvelope(raised);
        expect(exitCode).toBe(75);
        expect(envelope.code).toBe('backend_shutting_down');
        expect(envelope.remediation).toContain('coral-cli backend status');
        expect(envelope.remediation).toContain(
          "The CLI's 30s bounded wait for the coordinator address to be released expired.",
        );
      },
    );

    it.each(successorDischargeableMethods)(
      'stops at one re-issue of %s when the successor refuses in turn',
      async (method) => {
        makeHome();
        const root = createPluginRoot();
        drainingIncumbent(root);

        const { issueWithSuccessorAfterLifecycleRefusal } = await importEnsure();
        const { IpcLifecycleRefusal } = await import('#src/transport/ipc/client.js');
        const successorSocketPath = `${socketPath(root)}.successor`;
        const issue = vi.fn(async (client: Pick<IpcClient, 'request'>) => {
          const draining = reachedInstanceId(client) === 'draining-coordinator';
          throw new IpcLifecycleRefusal(draining ? socketPath(root) : successorSocketPath, method);
        });

        const raised: unknown = await issueWithSuccessorAfterLifecycleRefusal(method, root, issue).then(
          (result: unknown) => result,
          (error: unknown) => error,
        );

        expect(raised).toBeInstanceOf(IpcLifecycleRefusal);
        expect(raised).toMatchObject({ method, socketPath: successorSocketPath });
        expect(issue).toHaveBeenCalledTimes(2);
        expect(mockState.spawn).toHaveBeenCalledTimes(1);
      },
    );

    it('obtains no successor when the drain bound, not the coordinator, ended the request', async () => {
      makeHome();
      const root = createPluginRoot();
      drainingIncumbent(root);

      const { issueWithSuccessorAfterLifecycleRefusal } = await importEnsure();
      const { IpcDrainRequestUnanswered, IpcRequestTimeout } = await import('#src/transport/ipc/client.js');
      mockState.request.mockRejectedValue(new IpcRequestTimeout('IPC request timed out after 29876ms'));

      const raised: unknown = await issueWithSuccessorAfterLifecycleRefusal(jobsAbortRpcSpec.name, root, (client) =>
        client.request(jobsAbortRpcSpec.name, {}, { timeoutMs: TOOL_TIMEOUT_MS }),
      ).then(
        (result: unknown) => result,
        (error: unknown) => error,
      );

      expect(raised).toBeInstanceOf(IpcDrainRequestUnanswered);
      expect(mockState.request).toHaveBeenCalledTimes(1);
      expect(mockState.bindSocket).not.toHaveBeenCalled();
      expect(mockState.spawn).not.toHaveBeenCalled();
    });

    it('keeps the refusal attached when obtaining the successor fails for another reason', async () => {
      makeHome();
      const root = createPluginRoot();
      drainingIncumbent(root);
      mockState.bindSocket.mockResolvedValue({ kind: 'bound' });
      mockState.spawn.mockImplementation(() => {
        throw new Error('spawn was refused by the host');
      });

      const { issueWithSuccessorAfterLifecycleRefusal } = await importEnsure();
      const { IpcLifecycleRefusal } = await import('#src/transport/ipc/client.js');
      const refusal = new IpcLifecycleRefusal(socketPath(root), jobsAbortRpcSpec.name);
      const issue = vi.fn(async () => {
        throw refusal;
      });

      const raised: unknown = await issueWithSuccessorAfterLifecycleRefusal(jobsAbortRpcSpec.name, root, issue).then(
        (result: unknown) => result,
        (error: unknown) => error,
      );

      expect(raised).not.toBeInstanceOf(IpcLifecycleRefusal);
      expect((raised as Error).message).toContain('spawn was refused by the host');
      expect((raised as Error).cause).toBe(refusal);
      expect(issue).toHaveBeenCalledTimes(1);
    });
  });

  it('waits for release then spawns when an admitted route meets a draining incumbent with no record', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    let spawned = false;
    mockState.health.mockImplementation(async () =>
      spawned
        ? {
            status: 'ok',
            version: '0.5.2',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'replacement-coordinator',
            namespace: pluginRootNamespace(root),
          }
        : {
            status: 'draining',
            version: '0.5.2',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'draining-coordinator',
            namespace: pluginRootNamespace(root),
          },
    );

    let bindCalls = 0;
    mockState.bindSocket.mockImplementation(async () => {
      bindCalls += 1;
      if (bindCalls === 1) return { kind: 'incumbent', reason: 'live-listener' };
      return { kind: 'bound' };
    });

    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, {
        port: 4233,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return spawnedChild();
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('jobs.abort', root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(bindCalls).toBeGreaterThan(1);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  it('spawns for a strict route whose authenticated re-read of the incumbent reports draining', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, { port: 4234, token: 'old-token', instanceId: 'draining-coordinator' });

    const drainingHealth = {
      status: 'draining' as const,
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod' as const,
      instanceId: 'draining-coordinator',
      namespace: pluginRootNamespace(root),
    };
    let healthCalls = 0;
    mockState.health.mockImplementation(async () => {
      healthCalls += 1;
      // The unauthenticated ping catches the incumbent before it published the drain; the authenticated
      // re-read is the first reading that shows it.
      if (healthCalls === 1) return { ...drainingHealth, status: 'ok' };
      if (mockState.spawn.mock.calls.length === 0) return drainingHealth;
      return { ...drainingHealth, status: 'ok', instanceId: 'replacement-coordinator' };
    });
    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, { port: 4235, token: 'replacement-token', instanceId: 'replacement-coordinator' });
      return spawnedChild();
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
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
    const ensured = await ensure('sessions.create', root);

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
    const ensured = await ensure('sessions.create', root);

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
    const ensured = await ensure('sessions.create', root);

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
    const ensuredPromise = ensure('sessions.create', root);
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
    const ensuredPromise = ensure('sessions.create', root);
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const context = { stage: 'handoff-deadline', socketPath: '/tmp/coral.sock' } as const;
    const expected = documentedCoralSetupError('handoff_socket_holder_unverified', context);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(
      () =>
        writeStartupSentinel(root, spawnedAttemptId(), {
          pid: 99_999,
          bundleHash: 'selected-build-hash',
          code: 'handoff_socket_holder_unverified',
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
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
    expect((error as Error).message).toContain('carries no readable code');
    expect((error as Error).message).toContain('coral-cli backend status');
    expect((error as Error).message).not.toContain('private malformed-diagnostic text');
    expect((error as Error).message).not.toContain('forged malformed-diagnostic command');
  });

  // A sentinel this build cannot render is still a refusal it can name. Startup is where the operator meets it
  // first, and a message that withholds the code leaves them nothing to search the coordinator log with, while
  // the persisted prose stays refused because an unproven author wrote it.
  it.each([
    {
      failure: 'a discriminator owned by another refusal',
      code: 'handoff_socket_holder_unverified',
      context: { stage: 'shutdown-request', pid: 4242 },
    },
    {
      failure: 'a missing required field',
      code: 'handoff_shutdown_credential_unavailable',
      context: { stage: 'shutdown-request' },
    },
  ])('names $failure in the current-attempt sentinel it could not render', async ({ code, context }) => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
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
    expect((error as Error).message).toContain(`setup-error code '${code}'`);
    expect((error as Error).message).toContain('not in the shape this Coral build renders that code from');
    expect((error as Error).message).toContain('coral-cli backend status');
    // The sentinel carries no proven author, so `unprovable` may not send the operator after a release.
    expect((error as Error).message).not.toContain('upgrade Coral');
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockState.spawn).toHaveBeenCalledOnce();

    writeStartupSentinel(root, spawnedAttemptId(), {
      code: 'handoff_socket_holder_unverified',
      userMessage: 'The coordinator socket holder could not be verified.',
      remediation: 'Verify the socket owner before retrying.',
      context: { stage: 'handoff-deadline', socketPath: '/tmp/coral.sock' },
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);

    await expect(ensuredPromise).resolves.toMatchObject({
      code: 'handoff_socket_holder_unverified',
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockState.spawn).toHaveBeenCalledOnce();

    writeStartupSentinel(root, spawnedAttemptId(), {
      code: 'handoff_socket_holder_unverified',
      userMessage: 'The coordinator socket holder could not be verified.',
      remediation: 'Verify the socket owner before retrying.',
      context: { stage: 'handoff-deadline', socketPath: '/tmp/coral.sock' },
    });
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);

    await expect(ensuredPromise).resolves.toMatchObject({
      code: 'handoff_socket_holder_unverified',
    });
  });

  it('returns the incumbent after two waiter launches fail while the contender keeps waiting', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const paths = coordinatorPaths('prod');
    mockState.validUpgradeTargetRoot = root;
    const incumbent = {
      instanceId: 'legacy-incumbent',
      pid: process.pid,
      incarnation: null,
      version: '0.5.1',
      bundleHash: 'legacy-hash',
      flavor: 'prod' as const,
    };
    writeDiscovery(root, {
      pid: incumbent.pid,
      version: incumbent.version,
      bundleHash: incumbent.bundleHash,
      instanceId: incumbent.instanceId,
    });
    let spawned = false;
    let executorSettled = false;
    const child = spawnedChild(process.pid);
    const startWaiter = vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'waiter did not claim' }));
    const runWaiter = vi.fn(async () => {
      const observed = readUpgradeIntent(paths.runDir);
      if (observed.kind !== 'readable') throw new Error('upgrade intent disappeared');
      const claimed = await compareAndSwapUpgradeIntent(paths.runDir, observed.intent.revision, {
        ...observed.intent,
        attemptId: 'inline-waiter-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'inline-waiter', pid: process.pid, incarnation: null },
        attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(claimed.kind).toBe('written');
      return await new Promise<never>(() => undefined);
    });
    mockState.health.mockImplementation(async () => {
      if (!spawned) throw createErrnoError('ECONNREFUSED');
      return {
        status: 'ok',
        version: incumbent.version,
        bundleHash: incumbent.bundleHash,
        flavor: incumbent.flavor,
        instanceId: incumbent.instanceId,
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      void requestLegacyUpgrade({
        runDir: paths.runDir,
        socketPath: paths.socketPath,
        incumbent,
        target: { build: provenManifest('test-hash'), pluginRootLabel: root },
        startWaiter,
        runWaiter,
        ports: createRealUpgradeWaiterPorts(),
      }).then(() => {
        executorSettled = true;
      });
      return child;
    });

    const { ensure, KERNEL_READY_DEADLINE_MS } = await importEnsure();
    const result = ensure('sessions.create', root);
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await result).instanceId).toBe(incumbent.instanceId);
    expect(startWaiter).toHaveBeenCalledTimes(2);
    expect(runWaiter).toHaveBeenCalledOnce();
    expect(executorSettled).toBe(false);
    expect(readUpgradeIntent(paths.runDir)).toMatchObject({
      intent: { attemptOwner: { kind: 'waiter', pid: process.pid } },
    });
    expect(KERNEL_READY_DEADLINE_MS).toBeGreaterThan(4_000);
    expect(child.unref).toHaveBeenCalledOnce();
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
    const ensuredPromise = ensure('sessions.create', root);
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
    const ensuredPromise = ensure('sessions.create', root);
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
    const ensuredPromise = ensure('sessions.create', root);
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
    const ensuredPromise = ensure('sessions.create', root);
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

  const UNREACHABLE_AFTER_CHILD_STOPPED =
    'The spawned Coral coordinator stopped, and this address does not answer health requests ' +
    '(health-request-failed). No live recorded coordinator could be identified behind it, so Coral signaled ' +
    'nothing; retry the command.';

  // Force-kill guidance is the floor for a coordinator that cannot answer at all, so it needs both the contender's
  // own refusal of an unverified holder and this invocation's continuous observation of silence behind it.
  it('names a verified live coordinator silent across the whole window in labeled force-kill guidance', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation! });
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS + 400);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`action=kill -9 ${process.pid}`);
  });

  it('treats an IPC connection-cap refusal as an answer, not a silent holder', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation! });
    mockState.health.mockRejectedValue(
      new IpcRpcError({
        code: -32603,
        message: 'Too many IPC connections',
        data: { code: 'too_many_ipc_connections' },
      }),
    );

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS + 400);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);

    expect(await result).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(JSON.stringify(await result)).not.toContain('kill -9');
  });

  it('checks authenticated HTTP health before naming a silent holder for force-kill', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation! });
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'existing-coordinator',
          namespace: pluginRootNamespace(root),
          pid: process.pid,
          incarnation,
        }),
        { status: 200 },
      ),
    );

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS + 400);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);

    expect(await result).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(JSON.stringify(await result)).not.toContain('kill -9');
    expect(http).toHaveBeenCalledWith('http://127.0.0.1:4100/health?detailed=1', {
      headers: { 'X-Coral-Boot-Token': 'test-boot-token' },
      signal: expect.any(AbortSignal),
    });
  });

  it('withholds force-kill for an answering holder on the long-path compatibility socket', async () => {
    makeHome(true);
    vi.useFakeTimers();
    const root = createPluginRoot();
    const paths = coordinatorPaths('prod');
    const addresses = v0109CoordinatorSocketGuardSetForRunDir(paths.runDir, 'prod', {
      platform: process.platform,
      configuredTempDirectory: process.env.TMPDIR,
      systemTempDirectory: tmpdir(),
    });
    if (addresses.kind !== 'guarded-addresses' || addresses.paths[0] === undefined) {
      throw new Error('Expected a long-path compatibility socket.');
    }
    const holderSocketPath = addresses.paths[0];
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { socketPath: holderSocketPath, incarnation: incarnation! });
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'existing-coordinator',
          namespace: pluginRootNamespace(root),
          pid: process.pid,
          incarnation,
        }),
        { status: 200 },
      ),
    );

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(
      () =>
        writeStartupSentinel(root, spawnedAttemptId(), {
          context: { stage: 'handoff-deadline', socketPath: holderSocketPath },
        }),
      FORCE_KILL_UNANSWERED_WINDOW_MS + 400,
    );
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);

    expect(await result).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(JSON.stringify(await result)).not.toContain('kill -9');
    expect(http).toHaveBeenCalledWith('http://127.0.0.1:4100/health?detailed=1', expect.any(Object));
  });

  it('checks the local bind when the advertised host is unreachable', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { host: 'unreachable.example', bindHost: '127.0.0.1', incarnation: incarnation! });
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const address = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      if (address.includes('unreachable.example')) throw createErrnoError('ENETUNREACH');
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'existing-coordinator',
          namespace: pluginRootNamespace(root),
          pid: process.pid,
          incarnation,
        }),
        { status: 200 },
      );
    });

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS + 400);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);

    expect(await result).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(JSON.stringify(await result)).not.toContain('kill -9');
    expect(http).toHaveBeenCalledWith('http://127.0.0.1:4100/health?detailed=1', expect.any(Object));
  });

  it('checks every local interface when the holder binds all IPv4 addresses', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { host: 'unreachable.example', bindHost: '0.0.0.0', incarnation: incarnation! });
    mockState.localInterfaces = {
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      eth0: [
        {
          address: '192.0.2.10',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:01',
          internal: false,
          cidr: '192.0.2.10/24',
        },
      ],
    };
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const address = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      if (address.includes('127.0.0.1')) throw createErrnoError('ECONNREFUSED');
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'existing-coordinator',
          namespace: pluginRootNamespace(root),
          pid: process.pid,
          incarnation,
        }),
        { status: 200 },
      );
    });

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS + 400);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);

    expect(await result).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(http).toHaveBeenCalledWith('http://192.0.2.10:4100/health?detailed=1', expect.any(Object));
  });

  it('does not identify another local HTTP responder as the recorded holder', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation! });
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'another-coordinator',
          namespace: pluginRootNamespace(root),
          pid: process.pid,
          incarnation,
        }),
        { status: 200 },
      ),
    );

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const result = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS + 400);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);

    expect(await result).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(JSON.stringify(await result)).not.toContain(`action=kill -9 ${process.pid}`);
  });

  it('resets silence when the recorded holder identity changes', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation!, instanceId: 'holder-a' });
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(
      () => writeDiscovery(root, { pid: process.pid, incarnation: incarnation!, instanceId: 'holder-b' }),
      FORCE_KILL_UNANSWERED_WINDOW_MS - 200,
    );
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS + 400);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS + 800);

    const error = await ensuredPromise;
    expect(error).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(JSON.stringify(error)).not.toContain('action=kill -9');
  });

  it('emits force-kill guidance after a replacement holder stays silent for a full new window', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation!, instanceId: 'holder-a' });
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const ensured = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(
      () => writeDiscovery(root, { pid: process.pid, incarnation: incarnation!, instanceId: 'holder-b' }),
      FORCE_KILL_UNANSWERED_WINDOW_MS - 200,
    );
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), FORCE_KILL_UNANSWERED_WINDOW_MS * 2 + 400);

    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS * 2 + 800);

    await expect(ensured).resolves.toHaveProperty('message', expect.stringContaining(`action=kill -9 ${process.pid}`));
  });

  // A contender that refuses after a stall of a few seconds has not shown that the holder cannot answer: the
  // stall may be a journal flush or a slow read, and the coordinator behind it is serving.
  it('withholds force-kill guidance from an unverified-holder refusal after a stall shorter than the window', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation! });
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ETIMEDOUT'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    setTimeout(() => writeStartupSentinel(root, spawnedAttemptId()), 3_500);
    await vi.advanceTimersByTimeAsync(4_000);
    const error = await ensuredPromise;

    expect(error).toMatchObject({ code: 'handoff_socket_holder_unverified' });
    expect(JSON.stringify(error)).not.toContain('kill -9');
  });

  // Only an unverified-holder refusal says the contender itself could not get an answer. A contender that exited
  // any other way conceded to, or raced, an incumbent that may have answered it.
  it('withholds force-kill guidance after a contender exit that was not an unverified-holder refusal', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, { pid: process.pid, incarnation: incarnation! });
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ETIMEDOUT'));
    mockState.spawn.mockReturnValue(child);

    const { ensure, FORCE_KILL_UNANSWERED_WINDOW_MS } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(FORCE_KILL_UNANSWERED_WINDOW_MS * 2);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('kill -9');
    expect((error as Error).message).not.toMatch(/force-kill/i);
  });

  // A printed `kill -9` is run by whoever reads it, so it may name only a process proven to be the recorded
  // owner and proven alive: every weaker observation must withhold the command.
  it.each([
    { owner: 'a recorded pid observed absent', record: 'matching', liveness: 'absent', unprobeable: false },
    { owner: 'a recorded pid whose liveness is unknown', record: 'matching', liveness: 'unknown', unprobeable: false },
    { owner: 'a live pid wearing another incarnation', record: 'mismatched', liveness: null, unprobeable: false },
    { owner: 'a live pid whose incarnation cannot be probed', record: 'matching', liveness: null, unprobeable: true },
    { owner: 'a live pid recorded without an incarnation', record: 'none', liveness: null, unprobeable: false },
  ] as const)('withholds force-kill guidance for $owner', async ({ record, liveness, unprobeable }) => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const incarnation = probeProcessIncarnation(process.pid);
    expect(incarnation).not.toBeNull();
    writeDiscovery(root, {
      pid: process.pid,
      ...(record === 'matching' ? { incarnation: incarnation! } : {}),
      ...(record === 'mismatched' ? { incarnation: testIncarnation('another-process') } : {}),
    });
    mockState.ownerLiveness = liveness;
    mockState.ownerIncarnationUnprobeable = unprobeable;
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('action=kill -9');
    expect((error as Error).message).not.toMatch(/force-kill/i);
    expect((error as Error).message).toBe(UNREACHABLE_AFTER_CHILD_STOPPED);
  });

  // A child that never spawned did not stop before binding, and the reason it never spawned is this process's
  // own: `spawnCoordinator` gives the child `stdio: ['ignore', 'ignore', <coordinator.log fd>]`, so nothing the
  // child wrote can reach the `error` event. Reverting the terminal to one shape makes both halves fail — the
  // message goes back to naming a bind that was never attempted, and the reason disappears.
  it('names the spawn failure when the child never started, rather than a bind it never attempted', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    const spawnFailure = 'spawn /nonexistent/node ENOENT';
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('error', new Error(spawnFailure));
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `The Coral coordinator process could not be started (${spawnFailure}). Its startup outcome is recorded for inspection.`,
    );
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
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', code, signal);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    // The probe never completed, so this invocation did not observe a coordinator failing to bind — only that
    // it could not see one. Restoring the single 'stopped before binding' message turns this red.
    expect((error as Error).message).toBe(UNREACHABLE_AFTER_CHILD_STOPPED);
  });

  it('rejects a wrong-attempt sentinel after the exact child becomes terminal', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    const child = spawnedChild();
    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue(child);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure('sessions.create', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    writeStartupSentinel(root, 'another-attempt');
    child.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(UNREACHABLE_AFTER_CHILD_STOPPED);
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
    const ensuredPromise = ensure('sessions.create', root);
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
    const ensuredPromise = ensure('sessions.create', root);
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

    await expect(ensure('sessions.create', root)).rejects.toThrow(
      expect.objectContaining({ code: 'coordinator_socket_dir_unverified' }),
    );
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
      const ensuredPromise = ensure('sessions.create', root);
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
