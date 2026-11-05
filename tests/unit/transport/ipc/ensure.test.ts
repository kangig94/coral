import { createHash } from 'node:crypto';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { attemptExclusiveFileLockSync, createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { CoralSetupError } from '#src/runtime/errors.js';
import { BackendUnreachableError } from '#src/infra/http-errors.js';
import { upgradeIntentPath, supervisorLockPath } from '#src/infra/path/coordinator.js';
import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';
import type * as IpcClientMod from '#src/transport/ipc/client.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import * as nodeProcess from '#src/infra/node-process.js';
import { type LaunchAdmission, launchAdmissionPath } from '#src/infra/launch-admission-record.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function writeStartingAdmission(overrides: Partial<LaunchAdmission> = {}): void {
  const launchId = '00000000-0000-4000-8000-000000000001';
  const path = launchAdmissionPath(coordinatorPaths('prod').runDir, launchId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      launchId,
      child: { pid: process.pid, incarnation: probeProcessIncarnation(process.pid) },
      parent: { pid: process.ppid, incarnation: probeProcessIncarnation(process.ppid) },
      admittedAt: Date.now(),
      admittedMonotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
      build: { version: '0.5.2', buildSetId: 'cold-build', bundleHash: 'test-hash', flavor: 'prod' },
      purpose: 'startup',
      ...overrides,
    }),
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
  it('bounds unanswered sentinel startup with stale discovery', async () => {
    makeHome();
    const root = createPluginRoot();
    writeDiscovery(root, { sentinel: { version: 1, id: 'wedged' } });
    mockState.health.mockRejectedValue(new Error('no answer'));
    vi.useFakeTimers();
    const { ensure } = await importEnsure();
    const result = ensure('jobs.detail', root);
    const assertion = expect(result).rejects.toMatchObject({ code: 'coordinator_recovering' });
    await vi.advanceTimersByTimeAsync(32_000);
    await assertion;
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no answer yet', 'absent', 'keep waiting', 'coordinator_recovering', 'coordinator_recovering'],
    ['answered then silent', 'absent', 'keep waiting', 'coordinator_recovering', 'coordinator_recovering'],
    ['starting once', 'verified', 'keep waiting', 'keep waiting', 'ready'],
    ['answered then silent', 'expired', 'keep waiting', 'coordinator_recovering', 'coordinator_recovering'],
  ] as const)(
    'startup silence rule: %s, admission=%s',
    async (history, admission, beforeSilenceBound, atSilenceBound, afterSilenceBound) => {
      makeHome();
      const root = createPluginRoot();
      vi.useFakeTimers();
      const startedAt = process.hrtime.bigint() / 1_000_000n;
      const lastAnswerAt = history === 'no answer yet' ? 0 : history === 'starting once' ? 1_000 : 5_000;
      const readyAt = lastAnswerAt + 40_000;
      let attemptId: string | undefined;
      let startingAnswers = 0;
      mockState.spawn.mockImplementation((_command, _args, options) => {
        attemptId = (options as { env: NodeJS.ProcessEnv }).env.CORAL_STARTUP_ATTEMPT_ID;
        if (admission === 'verified') writeStartingAdmission();
        if (admission === 'expired')
          writeStartingAdmission({ admittedAt: Date.now() - 100_000, admittedMonotonicMs: undefined });
        return spawnedChild();
      });
      mockState.health.mockImplementation(async () => {
        if (attemptId === undefined) throw new Error('not started');
        const elapsed = Number(process.hrtime.bigint() / 1_000_000n - startedAt);
        const starting =
          (history === 'starting once' && elapsed >= 1_000 && startingAnswers === 0) ||
          (history === 'answered then silent' && elapsed >= 1_000 && elapsed <= 5_000);
        if (!starting && elapsed < readyAt) throw new Error('store open in progress');
        if (starting) startingAnswers += 1;
        writeDiscovery(root);
        return {
          status: starting ? 'starting' : 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'existing-coordinator',
          namespace: pluginRootNamespace(root),
          env: { CORAL_STARTUP_ATTEMPT_ID: attemptId },
        };
      });
      const { ensure } = await importEnsure();
      let outcome: unknown = 'keep waiting';
      const result = ensure('jobs.detail', root)
        .then((client) => {
          outcome = 'ready';
          return client;
        })
        .catch((error: unknown) => {
          outcome = error instanceof CoralSetupError ? error.code : error;
          return error;
        });
      await vi.advanceTimersByTimeAsync(lastAnswerAt + 20_000);
      expect(outcome).toBe(beforeSilenceBound);
      await vi.advanceTimersByTimeAsync(9_500);
      expect(outcome).toBe(beforeSilenceBound);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome).toBe(atSilenceBound);
      await vi.advanceTimersByTimeAsync(14_500);
      expect(outcome).toBe(afterSilenceBound);
      if (afterSilenceBound === 'ready') expect(await result).toMatchObject({ instanceId: 'existing-coordinator' });
      else expect(await result).toMatchObject({ code: 'coordinator_recovering' });
      if (history === 'no answer yet') expect(startingAnswers).toBe(0);
      else if (history === 'starting once') expect(startingAnswers).toBe(1);
      else expect(startingAnswers).toBeGreaterThan(1);
      expect(mockState.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the admitted startup deadline when observing an existing starting child without sentinel health', async () => {
    makeHome();
    const root = createPluginRoot();
    vi.useFakeTimers();
    writeStartingAdmission();
    writeDiscovery(root);
    const startedAt = process.hrtime.bigint() / 1_000_000n;
    let readings = 0;
    let answeredStarting = false;
    mockState.health.mockImplementation(async () => {
      readings += 1;
      const elapsed = Number(process.hrtime.bigint() / 1_000_000n - startedAt);
      const starting = readings <= 2 || (elapsed >= 1_000 && !answeredStarting);
      if (elapsed >= 1_000 && starting) answeredStarting = true;
      if (!starting && elapsed < 41_000) throw new Error('store open in progress');
      return {
        status: starting ? 'starting' : 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'existing-coordinator',
        namespace: pluginRootNamespace(root),
      };
    });
    const { ensure } = await importEnsure();
    const result = ensure('jobs.detail', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(42_000);
    expect(answeredStarting).toBe(true);
    expect(await result).toMatchObject({ instanceId: 'existing-coordinator' });
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it.each(['expired', 'discovered', 'wrong-flavor', 'child-mismatch', 'parent-mismatch', 'unknown'] as const)(
    'does not extend silence for an %s admission',
    async (evidence) => {
      makeHome();
      const root = createPluginRoot();
      vi.useFakeTimers();
      writeStartingAdmission({
        ...(evidence === 'expired' ? { admittedAt: Date.now() - 120_001, admittedMonotonicMs: undefined } : {}),
        ...(evidence === 'discovered' ? { discoveredAt: Date.now() } : {}),
        ...(evidence === 'wrong-flavor'
          ? { build: { version: '0.5.2', buildSetId: 'cold-build', bundleHash: 'test-hash', flavor: 'dev' } }
          : {}),
        ...(evidence === 'child-mismatch'
          ? { child: { pid: process.pid, incarnation: testIncarnation('stale') } }
          : {}),
        ...(evidence === 'parent-mismatch'
          ? { parent: { pid: process.ppid, incarnation: testIncarnation('stale') } }
          : {}),
      });
      if (evidence === 'unknown') vi.spyOn(nodeProcess, 'probeProcessIncarnation').mockReturnValue(null);
      mockState.health.mockRejectedValue(new Error('no answer'));
      const { ensure } = await importEnsure();
      const result = ensure('jobs.detail', root).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(32_000);
      expect(await result).toMatchObject({ code: 'coordinator_recovering' });
      expect(mockState.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it('stops waiting when a silent admitted child exhausts its startup budget', async () => {
    makeHome();
    const root = createPluginRoot();
    vi.useFakeTimers();
    writeStartingAdmission();
    mockState.health.mockRejectedValue(new Error('no answer'));
    const { ensure } = await importEnsure();
    let settled = false;
    const result = ensure('jobs.detail', root)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled).toBe(false);
    expect(mockState.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toMatchObject({ code: 'coordinator_recovering' });
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it('waits for first health at 35 seconds with a repeated invocation', async () => {
    makeHome();
    const root = createPluginRoot();
    vi.useFakeTimers();
    const startedAt = process.hrtime.bigint() / 1_000_000n;
    let attemptId: string | undefined;
    mockState.spawn.mockImplementation((_command, _args, options) => {
      attemptId = (options as { env: NodeJS.ProcessEnv }).env.CORAL_STARTUP_ATTEMPT_ID;
      writeStartingAdmission();
      return spawnedChild();
    });
    mockState.health.mockImplementation(async () => {
      if (attemptId === undefined || process.hrtime.bigint() / 1_000_000n - startedAt < 35_000n)
        throw new Error('store initialization in progress');
      writeDiscovery(root, { sentinel: { version: 1, id: 'cold-start' } });
      return {
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'existing-coordinator',
        namespace: pluginRootNamespace(root),
        sentinel: { version: 1, id: 'cold-start' },
        env: { CORAL_STARTUP_ATTEMPT_ID: attemptId },
      };
    });
    const { ensure } = await importEnsure();
    const first = ensure('jobs.detail', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31_000);
    const repeated = ensure('jobs.detail', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(await first).toMatchObject({ instanceId: 'existing-coordinator' });
    expect(await repeated).toMatchObject({ instanceId: 'existing-coordinator' });
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  describe.each([
    ['admitted before spawn', 0],
    ['late admission', 1],
    ['already serving', 0],
  ] as const)('upgrade acceptance: %s', (route, expectedSpawns) => {
    it.each(
      route === 'admitted before spawn'
        ? ([
            ['0.5.2', false],
            ['0.5.3', false],
            ['0.5.4', false],
            ['0.5.2', true],
          ] as const)
        : ([['0.5.2', false]] as const),
    )('settles the upgrade request for incumbent %s (corrupt intent=%s)', async (incumbentVersion, corruptIntent) => {
      makeHome();
      const root = createPluginRoot('prod', '0.5.3');
      const bundles = {
        'coral-backend.cjs': 'backend fixture',
        'coral-cli': 'cli fixture',
        'coral-claude-appserver.cjs': 'appserver fixture',
        'coral-durable-wrapper.cjs': 'wrapper fixture',
      };
      for (const [file, content] of Object.entries(bundles)) writeFileSync(join(root, 'bridge', file), content);
      const hash = (file: keyof typeof bundles) =>
        createHash('sha256').update(bundles[file]).digest('hex').slice(0, 16);
      const manifest = {
        version: '0.5.3',
        buildSetId: '00000000-0000-4000-8000-000000000003',
        flavor: 'prod' as const,
        storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
        bundleHash: hash('coral-backend.cjs'),
        cliBundleHash: hash('coral-cli'),
        claudeAppserverBundleHash: hash('coral-claude-appserver.cjs'),
        durableWrapperBundleHash: hash('coral-durable-wrapper.cjs'),
      };
      writeFileSync(join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest));
      mockState.strictIdentity = { ok: true, manifest };
      vi.useFakeTimers();
      const startedAt = process.hrtime.bigint() / 1_000_000n;
      const runDir = coordinatorPaths('prod').runDir;
      mkdirSync(runDir, { recursive: true });
      const publishAdmission = () =>
        writeStartingAdmission({
          build: {
            version: incumbentVersion,
            buildSetId: 'incumbent-build',
            bundleHash: 'incumbent-hash',
            flavor: 'prod',
          },
        });
      if (route === 'admitted before spawn') publishAdmission();
      if (route === 'late admission') {
        mockState.spawn.mockImplementation(() => {
          const child = spawnedChild();
          setTimeout(() => {
            publishAdmission();
            child.emit('exit', 1, null);
          }, 29_950);
          return child;
        });
      }
      if (corruptIntent) writeFileSync(upgradeIntentPath(runDir), '{');
      createSharedFileLockSync(supervisorLockPath(runDir))();
      const lock = attemptExclusiveFileLockSync(supervisorLockPath(runDir));
      if (lock.kind !== 'acquired') throw new Error('Fixture supervisor did not acquire ownership');
      mockState.health.mockImplementation(async () => {
        if (route !== 'already serving' && process.hrtime.bigint() / 1_000_000n - startedAt < 35_000n)
          throw new Error('cold startup in progress');
        writeDiscovery(root, {
          version: incumbentVersion,
          bundleHash: 'incumbent-hash',
          incarnation: probeProcessIncarnation(process.pid) ?? undefined,
        });
        return {
          status: 'ok',
          version: incumbentVersion,
          bundleHash: 'incumbent-hash',
          flavor: 'prod',
          instanceId: 'existing-coordinator',
          namespace: pluginRootNamespace(root),
          incarnation: probeProcessIncarnation(process.pid),
          env: { CORAL_STARTUP_ATTEMPT_ID: 'owner-attempt' },
        };
      });
      try {
        const { ensure } = await importEnsure();
        const result = ensure('jobs.detail', root).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(36_000);
        if (corruptIntent) {
          expect(await result).toBeInstanceOf(BackendUnreachableError);
          expect(await result).toMatchObject({
            message: 'Coordinator upgrade request was refused: upgrade intent is corrupt',
          });
          expect(readFileSync(upgradeIntentPath(runDir), 'utf8')).toBe('{');
        } else {
          expect(await result).toMatchObject({ instanceId: 'existing-coordinator', version: incumbentVersion });
          const upgrade = readUpgradeIntent(runDir);
          if (incumbentVersion === '0.5.2') {
            expect(upgrade).toMatchObject({
              kind: 'readable',
              intent: {
                disposition: 'pending',
                incumbent: {
                  instanceId: 'existing-coordinator',
                  version: incumbentVersion,
                  bundleHash: 'incumbent-hash',
                  flavor: 'prod',
                  pid: process.pid,
                  incarnation: probeProcessIncarnation(process.pid),
                },
                target: { build: manifest, pluginRootLabel: root },
              },
            });
          } else expect(upgrade.kind).toBe('absent');
        }
        expect(mockState.spawn).toHaveBeenCalledTimes(expectedSpawns);
        expect(attemptExclusiveFileLockSync(supervisorLockPath(runDir)).kind).toBe('contended');
      } finally {
        lock.lease();
      }
    });
  });

  it.each([35_000, null])(
    'follows the admitted owner after a losing sentinel exits (first health=%s)',
    async (firstHealthAt) => {
      makeHome();
      const root = createPluginRoot();
      vi.useFakeTimers();
      const startedAt = process.hrtime.bigint() / 1_000_000n;
      let sentinelExited = false;
      mockState.spawn.mockImplementation(() => {
        const child = spawnedChild();
        setTimeout(() => writeStartingAdmission(), 1_000);
        setTimeout(() => {
          sentinelExited = true;
          child.emit('exit', 1, null);
        }, 30_000);
        return child;
      });
      mockState.health.mockImplementation(async () => {
        const elapsed = Number(process.hrtime.bigint() / 1_000_000n - startedAt);
        if (firstHealthAt === null || elapsed < firstHealthAt) throw new Error('owner still initializing');
        writeDiscovery(root, { sentinel: { version: 1, id: 'owner' } });
        return {
          status: 'ok',
          version: '0.5.2',
          bundleHash: 'test-hash',
          flavor: 'prod',
          instanceId: 'existing-coordinator',
          namespace: pluginRootNamespace(root),
          sentinel: { version: 1, id: 'owner' },
          env: { CORAL_STARTUP_ATTEMPT_ID: 'owner-attempt' },
        };
      });
      const { ensure } = await importEnsure();
      let settled = false;
      const result = ensure('jobs.detail', root)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(sentinelExited).toBe(true);
      expect(settled).toBe(false);
      if (firstHealthAt === null) {
        await vi.advanceTimersByTimeAsync(89_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await result).toMatchObject({ code: 'coordinator_recovering' });
      } else {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await result).toMatchObject({ instanceId: 'existing-coordinator' });
      }
      expect(mockState.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it('reports an exited sentinel without verified admitted startup as a startup failure', async () => {
    makeHome();
    const root = createPluginRoot();
    vi.useFakeTimers();
    mockState.spawn.mockImplementation(() => {
      const child = spawnedChild();
      setTimeout(() => child.emit('exit', 1, null), 10_000);
      return child;
    });
    mockState.health.mockRejectedValue(new Error('no answer'));
    const { ensure } = await importEnsure();
    const result = ensure('jobs.detail', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await result).toBeInstanceOf(BackendUnreachableError);
    expect(await result).toMatchObject({ message: expect.stringContaining('stopped') });
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting after a transient missed ping beyond 30 seconds of answering startup', async () => {
    makeHome();
    const root = createPluginRoot();
    vi.useFakeTimers();
    const startedAt = process.hrtime.bigint() / 1_000_000n;
    let attemptId: string | undefined;
    let missedPing = false;
    mockState.spawn.mockImplementation((_command, _args, options) => {
      attemptId = (options as { env: NodeJS.ProcessEnv }).env.CORAL_STARTUP_ATTEMPT_ID;
      writeDiscovery(root, { sentinel: { version: 1, id: 'starting' } });
      return spawnedChild();
    });
    mockState.health.mockImplementation(async () => {
      if (attemptId === undefined) throw new Error('not started');
      const elapsed = process.hrtime.bigint() / 1_000_000n - startedAt;
      if (elapsed >= 31_000n && !missedPing) {
        missedPing = true;
        throw new Error('transient missed ping');
      }
      return {
        status: elapsed < 32_000n ? 'starting' : 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'existing-coordinator',
        namespace: pluginRootNamespace(root),
        sentinel: { version: 1, id: 'starting' },
        env: { CORAL_STARTUP_ATTEMPT_ID: attemptId },
      };
    });
    const { ensure } = await importEnsure();
    const result = ensure('jobs.detail', root).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(33_000);
    expect(await result).toMatchObject({ instanceId: 'existing-coordinator' });
    expect(missedPing).toBe(true);
    expect(mockState.spawn).toHaveBeenCalledTimes(1);
  });

  it.each(['delivered', 'refused-again'] as const)(
    'reissues jobs.send once to the successor after a pre-effect lifecycle refusal (%s)',
    async (outcome) => {
      makeHome();
      const root = createPluginRoot();
      writeDiscovery(root, { instanceId: 'successor-coordinator' });
      mockState.health.mockResolvedValue({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        instanceId: 'successor-coordinator',
        namespace: pluginRootNamespace(root),
      });
      const { IpcLifecycleRefusal } = await import('#src/transport/ipc/client.js');
      const refusal = new IpcLifecycleRefusal('/incumbent.sock', 'jobs.send');
      const incumbent = { request: vi.fn().mockRejectedValue(refusal) };
      const successorRefusal = new IpcLifecycleRefusal(socketPath(root), 'jobs.send');
      if (outcome === 'delivered') mockState.request.mockResolvedValue({ state: 'delivered' });
      else mockState.request.mockRejectedValue(successorRefusal);
      const params = {
        projectRoot: '/project',
        jobId: 'job-1',
        input: 'message',
        clientMessageId: '11111111-1111-4111-8111-111111111111',
      };
      const { issueWithSuccessorAfterLifecycleRefusal } = await importEnsure();
      const result = issueWithSuccessorAfterLifecycleRefusal(
        'jobs.send',
        root,
        (client) => client.request('jobs.send', params, { timeoutMs: 20_000 }),
        undefined,
        incumbent,
      );
      if (outcome === 'delivered') await expect(result).resolves.toEqual({ state: 'delivered' });
      else await expect(result).rejects.toBe(successorRefusal);
      expect(incumbent.request).toHaveBeenCalledExactlyOnceWith('jobs.send', params, { timeoutMs: 20_000 });
      expect(mockState.request).toHaveBeenCalledExactlyOnceWith(socketPath(root), 'jobs.send', params, {
        timeoutMs: 20_000,
      });
    },
  );

  it('never seeks a successor for jobs.send response loss', async () => {
    const lostResponse = new Error('IPC connection closed');
    const incumbent = { request: vi.fn().mockRejectedValue(lostResponse) };
    const { issueWithSuccessorAfterLifecycleRefusal } = await importEnsure();
    await expect(
      issueWithSuccessorAfterLifecycleRefusal(
        'jobs.send',
        undefined,
        (client) => client.request('jobs.send'),
        undefined,
        incumbent,
      ),
    ).rejects.toBe(lostResponse);
    expect(incumbent.request).toHaveBeenCalledOnce();
    expect(mockState.createdClients).toEqual([]);
    expect(mockState.spawn).not.toHaveBeenCalled();
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
