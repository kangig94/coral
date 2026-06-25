// CLI-side `ensure()` coverage. The CLI mirrors daemon-side bind-with-handoff
// over the IPC socket alone — `coordinator.lock` is gone and the reconcile
// state machine collapsed. Cases:
//   - Compatible + ready  → reuse summary client
//   - Compatible + starting → wait for `coordinator.json` then return
//   - Compatible + draining → wait for socket release, spawn fresh
//   - Mismatched bundle → call `requestIncumbentShutdown`, wait for release, spawn
//   - Health unreachable + no `coordinator.json` → spawn fresh

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { readBuildFlavor } from '#src/infra/bundle-manifest.js';

const mockState = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 12_345, unref: vi.fn() })),
  health: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  shutdown: vi.fn<(socketPath: string, params?: unknown, options?: unknown) => Promise<unknown>>(),
  bindSocket: vi.fn<() => Promise<{ kind: 'bound' } | { kind: 'incumbent'; reason: string }>>(),
  home: '',
  platform: process.platform,
}));

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
  createIpcClient: (socketPath: string) => ({
    socketPath,
    request: vi.fn(),
    health: (options?: unknown) => mockState.health(socketPath, options),
    shutdown: (params?: unknown, options?: unknown) => mockState.shutdown(socketPath, params, options),
  }),
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

function createPluginRoot(flavor: 'prod' | 'dev' = 'prod'): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-ensure-root-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  writeFileSync(join(root, 'bridge', 'manifest.json'), JSON.stringify({ bundleHash: 'test-hash', flavor }), 'utf-8');
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
    shutdownToken: string | null;
    version: string;
    bundleHash: string;
    flavor: 'prod' | 'dev';
    instanceId: string;
    namespace: string;
    startedAt: number;
    processStartedAt: number;
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
      ...(overrides.shutdownToken === null ? {} : { shutdownToken: overrides.shutdownToken ?? 'test-shutdown-token' }),
      version: overrides.version ?? '0.5.2',
      bundleHash: overrides.bundleHash ?? 'test-hash',
      flavor,
      instanceId: overrides.instanceId ?? 'existing-coordinator',
      namespace: overrides.namespace ?? pluginRootNamespace(root),
      startedAt: overrides.startedAt ?? Date.now(),
      ...(overrides.processStartedAt === undefined ? {} : { processStartedAt: overrides.processStartedAt }),
    }),
    'utf-8',
  );
}

function createErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
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

beforeEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ipc ensure', () => {
  it('reuses a present compatible ready coordinator', async () => {
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
  });

  it('waits for coordinator.json when health reports starting and returns the merged client', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    let healthCalls = 0;
    mockState.health.mockImplementation(async () => {
      healthCalls += 1;
      if (healthCalls === 1) {
        // initial probe: still starting, no discovery yet
        return {
          status: 'starting',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'starting-coordinator',
          namespace: pluginRootNamespace(root),
        };
      }
      // subsequent waitForBackendReady probes find the daemon ready
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'ready-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });

    // After the first probe sees 'starting', the daemon writes discovery.
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

  it('compatible-but-draining waits for socket release then spawns fresh', async () => {
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
      // After spawn: replacement is ready
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'replacement-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });

    // First bind probe: socket still owned by draining incumbent.
    // Second probe: released.
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
      return { pid: 12_345, unref: vi.fn() };
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  it('mismatched bundle requests incumbent shutdown then spawns fresh', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4240,
      token: 'old-token',
      instanceId: 'old-coordinator',
      bundleHash: 'old-hash',
    });

    let spawned = false;
    mockState.health.mockImplementation(async () => {
      if (!spawned) {
        // Both the initial probe and the inner requestIncumbentShutdown probe
        // see the mismatched incumbent.
        return {
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'old-hash',
          flavor: 'prod',
          instanceId: 'old-coordinator',
          namespace: pluginRootNamespace(root),
        };
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'new-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    mockState.shutdown.mockResolvedValue({ status: 'draining' });

    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, {
        port: 4241,
        token: 'new-token',
        instanceId: 'new-coordinator',
      });
      return { pid: 12_345, unref: vi.fn() };
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('new-coordinator');
    expect(mockState.shutdown).toHaveBeenCalledTimes(1);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('fails fast when mismatched incumbent has no verified shutdown capability', async () => {
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

    await expect(ensure(root)).rejects.toThrow('Manual shutdown required');
    expect(mockState.shutdown).not.toHaveBeenCalled();
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
      // First two probes: connection refused; third probe (after spawn) succeeds.
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
      return { pid: 12_345, unref: vi.fn() };
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(800);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(mockState.shutdown).not.toHaveBeenCalled();
  });

  it('uses the bind deadline while a freshly spawned coordinator has not answered health', async () => {
    makeHome();
    vi.useFakeTimers();
    const root = createPluginRoot();

    mockState.health.mockRejectedValue(createErrnoError('ECONNREFUSED'));
    mockState.spawn.mockReturnValue({ pid: 12_345, unref: vi.fn() });

    const { ensure, KERNEL_BIND_DEADLINE_MS, STARTUP_POLL_MS } = await importEnsure();
    const ensuredPromise = ensure(root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(KERNEL_BIND_DEADLINE_MS + STARTUP_POLL_MS);
    const error = await ensuredPromise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Timed out waiting for Coral coordinator bind');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('switches to the ready deadline after the first health response from a fresh spawn', async () => {
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
    mockState.spawn.mockReturnValue({ pid: 12_345, unref: vi.fn() });
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

  it('polls bindSocket repeatedly while the incumbent socket is still bound', async () => {
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
          status: 'ok',
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
    mockState.shutdown.mockResolvedValue({ status: 'draining' });
    mockState.spawn.mockImplementation(() => {
      spawned = true;
      writeDiscovery(root, {
        port: 4261,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return { pid: 12_345, unref: vi.fn() };
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(2_000);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(bindCalls).toBeGreaterThanOrEqual(3);
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
        return { pid: 12_345, unref: vi.fn() };
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
