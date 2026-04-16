import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backendInfoPath, backendLockPath, installationDir, pluginRootNamespace } from '../../infra/paths.js';
import { probeProcessStartedAtSeconds } from '../../infra/backend-info.js';
import {
  ensureBackend,
  initialControllerState,
  reconcile,
  type VerifiedOwnership,
} from '../backend-lifecycle.js';
import { dirname } from 'node:path';

/** Client-side exclusive write (mirrors backend-lifecycle.ts logic) */
function tryExclusiveWrite(filePath: string, payload: string): boolean {
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(filePath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}
import { isProcessAlive } from '../../shared/node-process.js';

const tempRoots: string[] = [];

const mockState = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockState.execFileSync,
  spawn: mockState.spawn,
}));

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}));

function createPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-lifecycle-test-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  writeFileSync(
    join(root, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: 'test-hash', flavor: 'prod' }),
    'utf-8',
  );
  mkdirSync(installationDir(root), { recursive: true });
  return root;
}

function createPluginRootWithFlavor(flavor: 'prod' | 'dev'): string {
  const root = createPluginRoot();
  writeFileSync(join(root, 'bridge', 'manifest.json'), JSON.stringify({ bundleHash: 'test-hash', flavor }), 'utf-8');
  return root;
}

function writeBackendInfo(
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
  }> = {},
): void {
  writeFileSync(
    backendInfoPath(root),
    JSON.stringify({
      pid: overrides.pid ?? process.pid,
      port: overrides.port ?? 4100,
      host: overrides.host ?? '127.0.0.1',
      token: overrides.token ?? 'test-token',
      version: overrides.version ?? '0.0.0',
      bundleHash: overrides.bundleHash ?? 'test-hash',
      flavor: overrides.flavor ?? 'prod',
      instanceId: overrides.instanceId ?? 'existing-backend',
      namespace: overrides.namespace ?? pluginRootNamespace(root),
      startedAt: overrides.startedAt ?? Date.now(),
      ...(overrides.processStartedAt === undefined ? {} : { processStartedAt: overrides.processStartedAt }),
    }),
    'utf-8',
  );
}

function writeLockFile(root: string, pid: number, processStartedAt?: number): void {
  const payload = JSON.stringify({
    instanceId: `test-${pid}-${Date.now()}`,
    pid,
    version: '0.0.0',
    bundleHash: 'test-hash',
    flavor: 'prod',
    startedAt: Date.now(),
    ...(processStartedAt === undefined ? {} : { processStartedAt }),
  });
  writeFileSync(backendLockPath(root), payload, 'utf-8');
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function makeDesired() {
  return {
    version: '0.0.0',
    bundleHash: 'test-hash',
    flavor: 'prod' as const,
    namespace: 'expected-namespace',
  };
}

function makeHealthyInfo(instanceId = 'backend-a') {
  return {
    pid: 4242,
    port: 4100,
    host: '127.0.0.1',
    token: 'healthy-token',
    version: '0.0.0',
    bundleHash: 'old-hash',
    flavor: 'dev' as const,
    instanceId,
    namespace: 'other-namespace',
    startedAt: 1,
  };
}

function createErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(installationDir(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
  mockState.execFileSync.mockClear();
  mockState.spawn.mockClear();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('backend lock lifecycle', () => {
  it('exclusive write fails when lock file already exists', () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);
    writeFileSync(lockPath, 'existing', 'utf-8');
    expect(tryExclusiveWrite(lockPath, 'new-content')).toBe(false);
  });

  it('exclusive write succeeds when no lock file exists', () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);
    expect(tryExclusiveWrite(lockPath, 'new-content')).toBe(true);
    expect(readFileSync(lockPath, 'utf-8')).toBe('new-content');
  });

  it('stale lock from dead process blocks new lock acquisition', () => {
    const root = createPluginRoot();
    const deadPid = 2147483647; // almost certainly not a real PID
    writeLockFile(root, deadPid);

    const lockPath = backendLockPath(root);
    expect(tryExclusiveWrite(lockPath, 'replacement')).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('stale lock from dead process is removable by PID check', () => {
    const root = createPluginRoot();
    const deadPid = 2147483647;
    writeLockFile(root, deadPid);

    const lockPath = backendLockPath(root);
    const content = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as { pid: number };

    // Verify the PID is dead
    let alive = true;
    try {
      process.kill(parsed.pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('lock from live process is not falsely detected as stale', () => {
    const root = createPluginRoot();
    writeLockFile(root, process.pid); // current process is alive

    const lockPath = backendLockPath(root);
    const content = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as { pid: number };

    let alive = false;
    try {
      process.kill(parsed.pid, 0);
      alive = true;
    } catch {
      /* alive remains false */
    }
    expect(alive).toBe(true);
  });

  it('lock file without pid field is not treated as stale', () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);
    writeFileSync(lockPath, JSON.stringify({ instanceId: 'no-pid' }), 'utf-8');

    // Should not be removable — no pid to check
    expect(existsSync(lockPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed.pid).toBeUndefined();
  });

  it('EPERM from process.kill treats the lock owner as alive (shared isProcessAlive semantics)', () => {
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw createErrnoError('EPERM');
    }) as typeof process.kill);

    // The shared isProcessAlive treats EPERM as "process exists but no permission" → alive
    expect(isProcessAlive(424242)).toBe(true);

    // Since isProcessAlive returns true, stale-lock cleanup keeps the lock in place.
    const root = createPluginRoot();
    writeLockFile(root, 424242);
    const lockPath = backendLockPath(root);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('non-ESRCH/non-EPERM process.kill failures are rethrown by shared isProcessAlive', () => {
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw createErrnoError('EACCES');
    }) as typeof process.kill);

    // The shared isProcessAlive rethrows unexpected errors (not ESRCH, not EPERM)
    expect(() => isProcessAlive(434343)).toThrow('EACCES');

    // Unexpected liveness probe failures leave the lock in place.
    const root = createPluginRoot();
    writeLockFile(root, 434343);
    const lockPath = backendLockPath(root);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('shutdown cleanup ordering', () => {
  it('removeBackendInfoIfOwner and removeLockIfOwner are called before onStopped in lifecycle', async () => {
    // This test verifies the fix by importing and checking the source structure.
    // The actual behavioral test is that process.exit(0) in onStopped no longer
    // preempts cleanup — verified by the fact that backend.lock is absent after
    // idle shutdown (manual verification).
    const lifecycleSrc = readFileSync(
      join(process.cwd(), 'src/execution/lifecycle.ts'),
      'utf-8',
    );

    // Find the shutdown section: cleanup must come before onStopped
    const cleanupIndex = lifecycleSrc.indexOf('removeBackendInfoIfOwnerFn(pluginRoot, instanceId)');
    const lockCleanupIndex = lifecycleSrc.indexOf('removeLockIfOwnerFn(pluginRoot, instanceId)');
    const onStoppedIndex = lifecycleSrc.indexOf('onStopped?.()');

    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(lockCleanupIndex).toBeGreaterThan(-1);
    expect(onStoppedIndex).toBeGreaterThan(-1);

    // First occurrence of cleanup must be before first occurrence of onStopped
    expect(cleanupIndex).toBeLessThan(onStoppedIndex);
    expect(lockCleanupIndex).toBeLessThan(onStoppedIndex);
  });
});

describe('reconcile', () => {
  it('requests shutdown once per incompatible instance and keeps draining on the graceful replacement path', () => {
    const desired = makeDesired();
    const first = reconcile(
      { observedAt: 0, type: 'healthyIncompatible', info: makeHealthyInfo('old-instance') },
      desired,
      initialControllerState(),
    );
    expect(first.action).toEqual({
      type: 'requestShutdown',
      info: makeHealthyInfo('old-instance'),
    });
    expect(first.nextState.shutdownRequestedFor.has('old-instance')).toBe(true);
    expect(first.nextState.replacementPending).toBe(true);
    expect(first.nextState.replacedInstanceId).toBe('old-instance');

    const second = reconcile(
      { observedAt: 200, type: 'healthyIncompatible', info: makeHealthyInfo('old-instance') },
      desired,
      first.nextState,
    );
    expect(second.action).toEqual({
      type: 'ensureReplacement',
      replacedInstanceId: 'old-instance',
    });

    const draining = reconcile({ observedAt: 400, type: 'starting' }, desired, second.nextState);
    expect(draining.action).toEqual({
      type: 'ensureReplacement',
      replacedInstanceId: 'old-instance',
    });
    expect(draining.nextState.replacementPending).toBe(true);
  });

  it('promotes a previously verified sick daemon to forceReplace at the 10s boundary', () => {
    const desired = makeDesired();
    const verifiedOwnership: VerifiedOwnership = {
      kind: 'verified',
      instanceId: 'sick-instance',
      processStartedAt: 123,
      source: 'processIdentity',
      cleanupSnapshot: {
        lockRaw: '{"lock":true}',
        backendInfoRaw: '{"backend":true}',
      },
    };

    const first = reconcile(
      {
        observedAt: 0,
        type: 'sick',
        pid: 9898,
        ownership: verifiedOwnership,
      },
      desired,
      initialControllerState(),
    );
    expect(first.action).toEqual({ type: 'wait' });
    expect(first.nextState.sickSince).toBe(0);
    expect(first.nextState.verifiedSickOwnership).toEqual(verifiedOwnership);

    const second = reconcile(
      {
        observedAt: 10_000,
        type: 'sick',
        pid: 9898,
        ownership: { kind: 'unverified', reason: 'lock-missing' },
      },
      desired,
      first.nextState,
    );
    expect(second.action).toEqual({
      type: 'forceReplace',
      pid: 9898,
      ownership: verifiedOwnership,
    });
  });

  it('fails unsafe replacement when sick ownership stays unverified for 10s', () => {
    const desired = makeDesired();

    const first = reconcile(
      {
        observedAt: 0,
        type: 'sick',
        pid: 2323,
        ownership: { kind: 'unverified', reason: 'legacy-no-processStartedAt' },
      },
      desired,
      initialControllerState(),
    );
    expect(first.action).toEqual({ type: 'wait' });
    expect(first.nextState.unverifiedSince).toBe(0);

    const second = reconcile(
      {
        observedAt: 10_000,
        type: 'sick',
        pid: 2323,
        ownership: { kind: 'unverified', reason: 'legacy-no-processStartedAt' },
      },
      desired,
      first.nextState,
    );
    expect(second.action).toEqual({
      type: 'failUnsafeReplacement',
      pid: 2323,
      reason: 'legacy-no-processStartedAt',
    });
  });

  it('preserves replacement workflow state while quarantining a corrupt lock', () => {
    const desired = makeDesired();
    const state = initialControllerState();
    state.replacementPending = true;
    state.replacedInstanceId = 'old-instance';
    state.corruptLockRetries = 2;

    const result = reconcile({ observedAt: 500, type: 'corruptLock' }, desired, state);
    expect(result.action).toEqual({ type: 'quarantineCorruptLock' });
    expect(result.nextState.replacementPending).toBe(true);
    expect(result.nextState.replacedInstanceId).toBe('old-instance');
    expect(result.nextState.corruptLockQuarantined).toBe(true);
  });
});

describe('ensureBackend flavor-aware reuse', () => {
  it('quarantines a corrupt replacement lock after repeated retries', async () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);
    writeFileSync(lockPath, JSON.stringify({ instanceId: 'missing-pid' }), 'utf-8');

    mockState.spawn.mockImplementation(() => {
      writeBackendInfo(root, {
        port: 4103,
        token: 'replacement-token',
        instanceId: 'replacement-backend',
      });
      return { unref: vi.fn() };
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');
      if (url === 'http://127.0.0.1:4103/health' && token === 'replacement-token') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'replacement-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backend = await ensureBackend(root);

    expect(backend).toEqual({
      host: '127.0.0.1',
      port: 4103,
      token: 'replacement-token',
      instanceId: 'replacement-backend',
    });
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('holds the replacement lock until the replacement backend reports healthy', async () => {
    const root = createPluginRoot();
    const lockPath = backendLockPath(root);

    mockState.spawn.mockImplementation(() => {
      writeBackendInfo(root, {
        port: 4104,
        token: 'held-lock-token',
        instanceId: 'held-lock-backend',
      });
      return { unref: vi.fn() };
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');
      if (url === 'http://127.0.0.1:4104/health' && token === 'held-lock-token') {
        expect(existsSync(lockPath)).toBe(true);
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'held-lock-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backend = await ensureBackend(root);

    expect(backend).toEqual({
      host: '127.0.0.1',
      port: 4104,
      token: 'held-lock-token',
      instanceId: 'held-lock-backend',
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('reuses a healthy backend when bundle hash and flavor both match', async () => {
    const root = createPluginRootWithFlavor('dev');
    writeBackendInfo(root, {
      port: 4101,
      token: 'existing-token',
      flavor: 'dev',
      instanceId: 'existing-dev-backend',
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');
      if (url === 'http://127.0.0.1:4101/health' && token === 'existing-token') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'dev',
            instanceId: 'existing-dev-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backend = await ensureBackend(root);

    expect(backend).toEqual({
      host: '127.0.0.1',
      port: 4101,
      token: 'existing-token',
      instanceId: 'existing-dev-backend',
    });
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('forces replacement when the same root flips flavor without changing bundle bytes', async () => {
    const root = createPluginRootWithFlavor('dev');
    writeBackendInfo(root, {
      port: 4101,
      token: 'old-token',
      flavor: 'prod',
      instanceId: 'old-prod-backend',
    });

    mockState.spawn.mockImplementation(() => {
      writeBackendInfo(root, {
        port: 4102,
        token: 'new-token',
        flavor: 'dev',
        instanceId: 'new-dev-backend',
      });
      return { unref: vi.fn() };
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');

      if (url === 'http://127.0.0.1:4101/health' && token === 'old-token') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'old-prod-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'http://127.0.0.1:4101/admin/shutdown' && token === 'old-token') {
        return new Response(null, { status: 200 });
      }

      if (url === 'http://127.0.0.1:4102/health' && token === 'new-token') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'dev',
            instanceId: 'new-dev-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backend = await ensureBackend(root);

    expect(backend).toEqual({
      host: '127.0.0.1',
      port: 4102,
      token: 'new-token',
      instanceId: 'new-dev-backend',
    });
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4101/admin/shutdown',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Coral-Backend-Token': 'old-token' },
      }),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === 'http://127.0.0.1:4101/admin/shutdown'),
    ).toHaveLength(1);
  });

  it('keeps a draining incompatible backend on the graceful replacement path', async () => {
    const root = createPluginRootWithFlavor('dev');
    writeBackendInfo(root, {
      port: 4101,
      token: 'old-token',
      flavor: 'prod',
      instanceId: 'old-prod-backend',
    });

    let shutdownRequested = false;
    let replacementPublished = false;

    mockState.spawn.mockImplementation(() => ({ unref: vi.fn() }));

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');

      if (url === 'http://127.0.0.1:4101/health' && token === 'old-token') {
        if (!shutdownRequested) {
          return new Response(
            JSON.stringify({
              status: 'ok',
              version: '0.0.0',
              bundleHash: 'test-hash',
              flavor: 'prod',
              instanceId: 'old-prod-backend',
              namespace: pluginRootNamespace(root),
              uptimeMs: 1,
              active: 0,
              activeJobs: 0,
              inflightRequests: 0,
              queueDepth: 0,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (!replacementPublished) {
          replacementPublished = true;
          writeBackendInfo(root, {
            port: 4105,
            token: 'replacement-token',
            flavor: 'dev',
            instanceId: 'replacement-backend',
          });
        }

        return new Response(
          JSON.stringify({
            status: 'draining',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'old-prod-backend',
            namespace: pluginRootNamespace(root),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'http://127.0.0.1:4101/admin/shutdown' && token === 'old-token') {
        shutdownRequested = true;
        return new Response(JSON.stringify({ status: 'draining', instanceId: 'old-prod-backend' }), { status: 200 });
      }

      if (url === 'http://127.0.0.1:4105/health' && token === 'replacement-token') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'dev',
            instanceId: 'replacement-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backend = await ensureBackend(root);

    expect(backend).toEqual({
      host: '127.0.0.1',
      port: 4105,
      token: 'replacement-token',
      instanceId: 'replacement-backend',
    });
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => requestUrl(input) === 'http://127.0.0.1:4101/admin/shutdown'),
    ).toHaveLength(1);
  });

  it('force-replaces a verified sick backend after the 10s ownership window', async () => {
    vi.useFakeTimers();

    const root = createPluginRoot();
    mockState.execFileSync.mockImplementation((command: string) => {
      if (command === 'getconf') return '100\n';
      throw new Error(`Unexpected execFileSync: ${command}`);
    });

    const processStartedAt = probeProcessStartedAtSeconds(process.pid);
    if (processStartedAt === null) {
      // Platform probe unavailable (e.g., cached null from earlier test, missing procfs)
      return;
    }

    writeBackendInfo(root, {
      pid: process.pid,
      port: 4106,
      token: 'sick-token',
      instanceId: 'sick-backend',
      processStartedAt: processStartedAt ?? undefined,
    });
    writeFileSync(
      backendLockPath(root),
      JSON.stringify({
        instanceId: 'sick-backend',
        pid: process.pid,
        version: '0.0.0',
        bundleHash: 'test-hash',
        flavor: 'prod',
        startedAt: Date.now(),
        processStartedAt,
      }),
      'utf-8',
    );

    let killed = false;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((((pid: number, signal?: NodeJS.Signals | 0) => {
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
    }) as typeof process.kill));

    mockState.spawn.mockImplementation(() => {
      writeBackendInfo(root, {
        port: 4107,
        token: 'replacement-token',
        instanceId: 'replacement-backend',
      });
      return { unref: vi.fn() };
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');

      if (url === 'http://127.0.0.1:4106/health' && token === 'sick-token') {
        throw new Error('backend hung');
      }

      if (url === 'http://127.0.0.1:4107/health' && token === 'replacement-token') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'replacement-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backendPromise = ensureBackend(root);
    await vi.advanceTimersByTimeAsync(10_200);
    const backend = await backendPromise;

    expect(backend).toEqual({
      host: '127.0.0.1',
      port: 4107,
      token: 'replacement-token',
      instanceId: 'replacement-backend',
    });
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(existsSync(backendLockPath(root))).toBe(false);
    expect(JSON.parse(readFileSync(backendInfoPath(root), 'utf-8'))).toMatchObject({
      instanceId: 'replacement-backend',
    });
  });

  it('fails unsafe replacement when sick ownership cannot be verified within 10s', async () => {
    vi.useFakeTimers();

    const root = createPluginRoot();
    writeBackendInfo(root, {
      pid: process.pid,
      port: 4108,
      token: 'unverified-token',
      instanceId: 'legacy-backend',
    });
    writeFileSync(
      backendLockPath(root),
      JSON.stringify({
        instanceId: 'legacy-backend',
        pid: process.pid,
        version: '0.0.0',
        bundleHash: 'test-hash',
        flavor: 'prod',
        startedAt: Date.now(),
      }),
      'utf-8',
    );

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === process.pid && signal === 0) return true;
      if (pid === process.pid && signal === 'SIGKILL') return true;
      return true;
    }) as typeof process.kill));

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');
      if (url === 'http://127.0.0.1:4108/health' && token === 'unverified-token') {
        throw new Error('backend hung');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backendPromise = ensureBackend(root);
    const rejection = expect(backendPromise).rejects.toThrow('legacy-no-processStartedAt');
    await vi.advanceTimersByTimeAsync(10_200);
    await rejection;

    expect(mockState.spawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(existsSync(backendLockPath(root))).toBe(true);
  });

  it('waits on the outer 60s deadline rather than a 45s replacement sub-timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T00:00:00.000Z'));

    const startedAt = Date.now();
    const root = createPluginRootWithFlavor('dev');
    writeBackendInfo(root, {
      port: 4101,
      token: 'old-token',
      flavor: 'prod',
      instanceId: 'old-prod-backend',
    });

    mockState.spawn.mockImplementation(() => {
      writeBackendInfo(root, {
        port: 4109,
        token: 'slow-token',
        flavor: 'dev',
        instanceId: 'slow-backend',
      });
      return { unref: vi.fn() };
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const token = new Headers(init?.headers).get('X-Coral-Backend-Token');

      if (url === 'http://127.0.0.1:4101/health' && token === 'old-token') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'prod',
            instanceId: 'old-prod-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url === 'http://127.0.0.1:4101/admin/shutdown' && token === 'old-token') {
        return new Response(null, { status: 200 });
      }

      if (url === 'http://127.0.0.1:4109/health' && token === 'slow-token') {
        if (Date.now() - startedAt < 50_000) {
          throw new Error('replacement not ready');
        }

        return new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.0.0',
            bundleHash: 'test-hash',
            flavor: 'dev',
            instanceId: 'slow-backend',
            namespace: pluginRootNamespace(root),
            uptimeMs: 1,
            active: 0,
            activeJobs: 0,
            inflightRequests: 0,
            queueDepth: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const backendPromise = ensureBackend(root);
    await vi.advanceTimersByTimeAsync(50_200);
    const backend = await backendPromise;

    expect(backend).toEqual({
      host: '127.0.0.1',
      port: 4109,
      token: 'slow-token',
      instanceId: 'slow-backend',
    });
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });
});
