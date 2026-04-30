import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { probeProcessStartedAtSeconds } from '#src/infra/node-process.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { readBuildFlavor } from '#src/infra/bundle-manifest.js';

const mockState = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  health: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  shutdown: vi.fn<(socketPath: string, options?: unknown) => Promise<unknown>>(),
  home: '',
  platform: process.platform,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockState.execFileSync,
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
    shutdown: (options?: unknown) => mockState.shutdown(socketPath, options),
  }),
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

function lockPath(root: string, flavor = readBuildFlavor(root)): string {
  return coordinatorPaths(flavor).lockFile;
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

function writeLockFile(
  root: string,
  pid: number,
  overrides: Partial<{
    instanceId: string;
    version: string;
    bundleHash: string;
    flavor: 'prod' | 'dev';
    startedAt: number;
    processStartedAt: number;
  }> = {},
): void {
  const flavor = overrides.flavor ?? readBuildFlavor(root);
  const filePath = lockPath(root, flavor);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({
      instanceId: overrides.instanceId ?? `lock-owner-${pid}`,
      pid,
      version: overrides.version ?? '0.5.2',
      bundleHash: overrides.bundleHash ?? 'test-hash',
      flavor,
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  mockState.execFileSync.mockReset();
  mockState.spawn.mockReset();
  mockState.health.mockReset();
  mockState.shutdown.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ipc ensure', () => {
  it('launches the coordinator when discovery is absent and polls startup on the 200ms cadence', async () => {
    makeHome();
    vi.useFakeTimers();

    const root = createPluginRoot();
    const callTimes: number[] = [];

    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, {
        port: 4201,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return { unref: vi.fn() };
    });

    mockState.health.mockImplementation(async (currentSocketPath) => {
      callTimes.push(Date.now());
      if (currentSocketPath !== socketPath(root)) {
        throw new Error(`Unexpected socket path: ${currentSocketPath}`);
      }
      if (callTimes.length < 3) {
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

    const { ensure, STARTUP_POLL_MS } = await importEnsure();
    const ensuredPromise = ensure(root);
    let resolved = false;
    ensuredPromise.then(() => {
      resolved = true;
    });

    expect(STARTUP_POLL_MS).toBe(200);
    await vi.advanceTimersByTimeAsync(STARTUP_POLL_MS * 2 - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(51);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(ensured.socketPath).toBe(socketPath(root));
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(callTimes).toHaveLength(3);
  });

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

  it('shuts down an incompatible coordinator and replaces it', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, {
      port: 4203,
      token: 'old-token',
      instanceId: 'old-coordinator',
      bundleHash: 'old-hash',
    });

    mockState.health.mockImplementation(async (currentSocketPath) => {
      if (currentSocketPath === socketPath(root)) {
        return {
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'old-hash',
          flavor: 'prod',
          instanceId: 'old-coordinator',
          namespace: pluginRootNamespace(root),
        };
      }
      throw new Error(`Unexpected socket path: ${currentSocketPath}`);
    });
    mockState.shutdown.mockResolvedValue({ status: 'draining', instanceId: 'old-coordinator' });
    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, {
        port: 4204,
        token: 'new-token',
        instanceId: 'new-coordinator',
      });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'new-coordinator',
        namespace: pluginRootNamespace(root),
      });
      return { unref: vi.fn() };
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.instanceId).toBe('new-coordinator');
    expect(mockState.shutdown).toHaveBeenCalledTimes(1);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('clears a stale lock before re-observing and launching', async () => {
    makeHome();
    const root = createPluginRoot();
    writeLockFile(root, 2_147_483_647, { instanceId: 'stale-lock-owner' });

    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, {
        port: 4205,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return { unref: vi.fn() };
    });
    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'replacement-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensured = await ensure(root);

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(existsSync(lockPath(root))).toBe(false);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('re-observes a live coordinator.json socket race until the socket becomes ready', async () => {
    makeHome();
    vi.useFakeTimers();

    const root = createPluginRoot();
    writeDiscovery(root, {
      pid: process.pid,
      port: 4206,
      token: 'race-token',
      instanceId: 'race-coordinator',
    });

    let calls = 0;
    mockState.health.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) {
        throw createErrnoError('ENOENT');
      }
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'race-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === process.pid && signal === 0) return true;
      return true;
    }) as typeof process.kill);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(450);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('race-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('collides with a concurrent launcher and converges on the other launcher result', async () => {
    makeHome();
    vi.useFakeTimers();

    const root = createPluginRoot();
    writeLockFile(root, 434343, { instanceId: 'other-launcher' });

    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === 434343 && signal === 0) return true;
      return true;
    }) as typeof process.kill);

    setTimeout(() => {
      unlinkSync(lockPath(root));
      writeDiscovery(root, {
        pid: 434343,
        port: 4207,
        token: 'other-token',
        instanceId: 'other-coordinator',
      });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'other-coordinator',
        namespace: pluginRootNamespace(root),
      });
    }, 150);

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(450);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('other-coordinator');
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('force-replaces a verified sick coordinator after repeated readiness timeouts', async () => {
    makeHome();
    vi.useFakeTimers();

    const root = createPluginRoot();
    const processStartedAt = probeProcessStartedAtSeconds(process.pid);
    if (processStartedAt === null) {
      return;
    }

    writeDiscovery(root, {
      pid: process.pid,
      port: 4208,
      token: 'sick-token',
      instanceId: 'sick-coordinator',
      processStartedAt,
    });
    writeLockFile(root, process.pid, {
      instanceId: 'sick-coordinator',
      processStartedAt,
    });

    let killed = false;
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid !== process.pid) return true;
      if (signal === 0) {
        if (killed) throw createErrnoError('ESRCH');
        return true;
      }
      if (signal === 'SIGKILL') {
        killed = true;
        return true;
      }
      return true;
    }) as typeof process.kill);

    mockState.health.mockImplementation(async (currentSocketPath) => {
      if (currentSocketPath === socketPath(root)) {
        throw new Error('coordinator hung');
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
        port: 4209,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'replacement-coordinator',
        namespace: pluginRootNamespace(root),
      });
      return { unref: vi.fn() };
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(10_300);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(killed).toBe(true);
  });

  it('persists previously verified sick ownership through later observations and still replaces gracefully', async () => {
    makeHome();
    vi.useFakeTimers();

    const root = createPluginRoot();
    const processStartedAt = probeProcessStartedAtSeconds(process.pid);
    if (processStartedAt === null) {
      return;
    }

    writeDiscovery(root, {
      pid: process.pid,
      port: 4210,
      token: 'sticky-token',
      instanceId: 'sticky-coordinator',
      processStartedAt,
    });
    writeLockFile(root, process.pid, {
      instanceId: 'sticky-coordinator',
      processStartedAt,
    });

    let killed = false;
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid !== process.pid) return true;
      if (signal === 0) {
        if (killed) throw createErrnoError('ESRCH');
        return true;
      }
      if (signal === 'SIGKILL') {
        killed = true;
        return true;
      }
      return true;
    }) as typeof process.kill);

    let healthCalls = 0;
    mockState.health.mockImplementation(async (currentSocketPath) => {
      if (currentSocketPath === socketPath(root)) {
        healthCalls += 1;
        if (healthCalls === 3 && existsSync(lockPath(root))) {
          unlinkSync(lockPath(root));
        }
        throw new Error('coordinator hung');
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
        port: 4211,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'replacement-coordinator',
        namespace: pluginRootNamespace(root),
      });
      return { unref: vi.fn() };
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(10_300);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(killed).toBe(true);
  });

  it('refuses unsafe replacement when sick ownership never verifies', async () => {
    makeHome();
    vi.useFakeTimers();

    const root = createPluginRoot();
    writeDiscovery(root, {
      pid: process.pid,
      port: 4212,
      token: 'retired-token',
      instanceId: 'retired-coordinator',
    });
    writeLockFile(root, process.pid, { instanceId: 'retired-coordinator' });

    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === process.pid && signal === 0) return true;
      return true;
    }) as typeof process.kill);

    mockState.health.mockRejectedValue(new Error('coordinator hung'));

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(10_300);

    await expect(ensuredPromise).rejects.toThrow('missing-processStartedAt');
    await expect(ensuredPromise).rejects.toThrow("Run 'coral-cli backend status' and restart if the problem persists.");
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('quarantines a corrupt lock after repeated retries before launching a replacement', async () => {
    makeHome();
    vi.useFakeTimers();

    const root = createPluginRoot();
    mkdirSync(dirname(lockPath(root)), { recursive: true });
    writeFileSync(lockPath(root), JSON.stringify({ instanceId: 'missing-pid' }), 'utf-8');

    mockState.spawn.mockImplementation(() => {
      writeDiscovery(root, {
        port: 4213,
        token: 'replacement-token',
        instanceId: 'replacement-coordinator',
      });
      return { unref: vi.fn() };
    });
    mockState.health.mockResolvedValue({
      status: 'ok',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      instanceId: 'replacement-coordinator',
      namespace: pluginRootNamespace(root),
    });

    const { ensure } = await importEnsure();
    const ensuredPromise = ensure(root);
    await vi.advanceTimersByTimeAsync(700);
    const ensured = await ensuredPromise;

    expect(ensured.instanceId).toBe('replacement-coordinator');
    expect(existsSync(lockPath(root))).toBe(false);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });
});
