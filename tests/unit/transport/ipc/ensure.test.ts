import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type * as IpcClientMod from '#src/transport/ipc/client.js';
import { type ProcessIncarnation } from '#src/infra/node-process.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { readBuildFlavor, type StrictBundleIdentityResult } from '#src/infra/bundle-manifest.js';

const mockState = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args?: readonly string[], options?: unknown) => ChildProcess>(),
  health: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  request: vi.fn<(socketPath: string, method: string, params?: unknown, options?: unknown) => Promise<unknown>>(),
  shutdown: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  bindSocket: vi.fn<() => Promise<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }>>(),
  createdClients: [] as Array<{ socketPath: string; auth: unknown }>,
  home: '',
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
          return readHealth(options);
        },
        health: (options?: unknown) => {
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

function makeHome(): void {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-ensure-home-'));
  tempRoots.push(root);
  mockState.home = root;
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
  writeFileSync(join(root, 'bridge', 'coral-backend.cjs'), 'backend fixture');
  writeFileSync(join(root, 'bridge', 'coral-sentinel.cjs'), 'supervisor fixture');
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
    sentinel: { version: 1; id: string };
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
      ...(overrides.sentinel === undefined ? {} : { sentinel: overrides.sentinel }),
    }),
    'utf-8',
  );
}

function setCompleteChildEnv(): void {
  process.env.CORAL_CHILD = '1';
  process.env.CORAL_CHILD_PRINCIPAL_HANDLE = 'child-handle';
  process.env.CORAL_JOB_ID = 'parent-job';
  process.env.CORAL_SESSION_ID = 'parent-session';
}

async function importEnsure() {
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
  mockState.request.mockReset();
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

  describe('child existing-only lifecycle', () => {
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
      expect(bindCalls).toBe(2);
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
    expect(mockState.bindSocket).toHaveBeenCalledTimes(2);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });
});

it('retries one snapshot lifecycle refusal on the successor without changing its cursor', async () => {
  makeHome();
  mockState.bindSocket.mockResolvedValue({ kind: 'bound' });
  vi.useFakeTimers();
  const root = createPluginRoot();
  writeDiscovery(root, { instanceId: 'draining-coordinator' });
  mockState.health
    .mockResolvedValueOnce({
      status: 'draining',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'draining-coordinator',
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
  mockState.spawn.mockImplementation(() => {
    writeDiscovery(root, { instanceId: 'replacement-coordinator' });
    return spawnedChild();
  });
  const { IpcLifecycleRefusal } = await import('#src/transport/ipc/client.js');
  const refusal = new IpcLifecycleRefusal(socketPath(root), 'jobs.wait.snapshot');
  const cursor = { afterSeq: 42 };
  const params = { jobIds: ['a'], projectRoot: '/project', cursor };
  const initial = { request: vi.fn().mockRejectedValue(refusal) };
  const answer = { snapshot: 'successor snapshot' };
  mockState.request.mockResolvedValue(answer);
  const { issueWithSuccessorAfterLifecycleRefusal } = await importEnsure();
  const result = issueWithSuccessorAfterLifecycleRefusal(
    'jobs.wait.snapshot',
    root,
    (client) => client.request('jobs.wait.snapshot', params),
    undefined,
    initial as never,
  );
  const settled = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(800);
  expect(await settled).toEqual({ value: answer });
  expect(initial.request).toHaveBeenCalledExactlyOnceWith('jobs.wait.snapshot', params);
  expect(mockState.request).toHaveBeenCalledExactlyOnceWith(socketPath(root), 'jobs.wait.snapshot', params, undefined);
  expect(mockState.spawn).toHaveBeenCalledTimes(1);
});
