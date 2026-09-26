import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { closeIpcServer, createIpcServer, listenIpcServer, type IpcListener } from '#src/transport/ipc/server.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import type { HttpHandlerPorts, HealthSnapshot } from '#src/transport/server-ports.js';
import { TEST_SYSTEM_PROVIDER_SCOPE } from '../../helpers/provider-credentials.js';
import {
  coordinatorFilesForHome,
  createShippedPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  terminateChildProcess,
  waitForProcessExit,
  type SpawnedCoordinator,
} from './helpers.js';

const tempDirs: string[] = [];
const liveListeners: IpcListener[] = [];
const liveChildren: ChildProcess[] = [];
const contenders: SpawnedCoordinator[] = [];
const shippedStateCases = (
  ['v0.10.0', 'v0.10.1', 'v0.10.4', 'v0.10.5', 'v0.10.9', 'v0.10.10', 'v0.10.13'] as const
).flatMap((tag) => (['starting', 'idle', 'busy', 'preparing', 'committing'] as const).map((state) => ({ tag, state })));

// Shipped v0.10.0-v0.10.8 contenders trust a discovery record only when its `processStartedAt` equals the
// Linux start time they derive at a fixed 100 clock ticks per second.
function shippedProcessStartedAtSeconds(pid: number): number {
  const bootTime = /^btime (\d+)$/mu.exec(readFileSync('/proc/stat', 'utf-8'))?.[1];
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const startTicks = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u)[19];
  if (bootTime === undefined || startTicks === undefined) throw new Error(`Cannot read the start time of pid ${pid}.`);
  return Math.floor(Number(bootTime) + Number(startTicks) / 100);
}

function makeSocketPath(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-starting-handoff-test-'));
  tempDirs.push(root);
  const path = join(root, `${name}.sock`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function buildPorts(opts: {
  state: 'starting' | 'idle' | 'busy' | 'preparing' | 'committing';
  isLifecycleRunning: () => boolean;
  isDrainRequested: () => boolean;
  onRequestDrain: (reason: string) => void;
  pid?: number;
  namespace?: string;
}): HttpHandlerPorts {
  const health: HealthSnapshot = {
    status: opts.isLifecycleRunning() ? 'ok' : 'starting',
    kernel: opts.isLifecycleRunning() ? { phase: 'running', readyAt: 1 } : { phase: 'starting', readyAt: null },
    version: '0.11.0',
    bundleHash: 'new-incumbent',
    flavor: 'prod',
    namespace: opts.namespace ?? 'ns',
    instanceId: 'i',
    pid: opts.pid ?? 1,
    uptimeMs: 0,
    active: 0,
    activeJobs: opts.state === 'busy' ? 1 : 0,
    liveDiscuss: 0,
    queueDepth: 0,
    inflightRequests: opts.state === 'preparing' || opts.state === 'committing' ? 1 : 0,
    textProjectionState: 'idle',
    env: {},
    components: [{ id: 'kb', phase: 'offline', reason: 'test' }],
  };
  return {
    identity: {
      pluginRoot: '/p',
      token: 't',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
      version: '0.11.0',
      bundleHash: 'new-incumbent',
      flavor: 'prod',
      namespace: opts.namespace ?? 'ns',
      instanceId: 'i',
      now: () => 0,
      log: () => undefined,
    },
    coralEnvSnapshot: {},
    systemProviderScope: TEST_SYSTEM_PROVIDER_SCOPE,
    admin: {
      getLifecycleState: () => (opts.state === 'starting' ? 'starting' : 'running'),
      isLifecycleRunning: opts.isLifecycleRunning,
      isDrainRequested: opts.isDrainRequested,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: opts.onRequestDrain,
    },
    health: {
      read: () => ({
        ...health,
        status: opts.isLifecycleRunning() ? 'ok' : 'starting',
        kernel: opts.isLifecycleRunning() ? { phase: 'running', readyAt: 1 } : { phase: 'starting', readyAt: null },
      }),
    },
    events: {
      addResponse: vi.fn(),
      removeResponse: vi.fn(),
      bus: {
        on: vi.fn().mockReturnThis(),
        off: vi.fn().mockReturnThis(),
      } as unknown as HttpHandlerPorts['events']['bus'],
      createStreamId: () => 's',
      nowIsoString: () => '0',
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    sessions: {} as never,
    jobs: {} as never,
    workflows: {} as never,
    kb: {} as never,
    discuss: {} as never,
    recoveryQuarantine: {} as never,
    expansion: {} as never,
  };
}

afterEach(async () => {
  for (const contender of contenders.splice(0)) await stopCoordinator(contender);
  for (const child of liveChildren.splice(0)) await terminateChildProcess(child, 'SIGKILL');
  for (const listener of liveListeners.splice(0)) {
    try {
      await closeIpcServer(listener);
    } catch {
      // best-effort
    }
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('legacy transport.shutdown at a new incumbent', () => {
  it.each(['starting', 'idle', 'busy', 'preparing', 'committing'] as const)(
    'refuses an authenticated replacement request while %s',
    async (state) => {
      const socketPath = makeSocketPath(state);
      const requestDrain = vi.fn();
      const decideLegacyShutdown = vi.fn(() => ({
        code: 'shutdown_unauthorized' as const,
        message: 'Shutdown refused: the incumbent keeps serving, and the upgrade is deferred to automatic succession.',
      }));
      const ports = buildPorts({
        state,
        isLifecycleRunning: () => state !== 'starting',
        isDrainRequested: () => false,
        onRequestDrain: requestDrain,
      });
      ports.admin.decideLegacyShutdown = decideLegacyShutdown;
      const ipcServer = createIpcServer(ports);
      await listenIpcServer(ipcServer, socketPath);
      liveListeners.push(ipcServer);

      const client = createIpcClient(socketPath, undefined, { kind: 'boot', token: 'boot-token' });
      await expect(client.shutdown({ timeoutMs: 1_000 })).rejects.toMatchObject({
        code: 'shutdown_unauthorized',
      });
      expect(decideLegacyShutdown).toHaveBeenCalledOnce();
      expect(requestDrain).not.toHaveBeenCalled();
      expect(ports.admin.isDrainRequested()).toBe(false);
    },
  );

  it.each(shippedStateCases)(
    'refuses a shipped $tag contender and CLI while $state',
    async ({ tag, state }) => {
      const fixture = createShippedPluginFixture(tempDirs, tag);
      const namespace = pluginRootNamespace(fixture.root);
      const home = mkdtempSync(join(tmpdir(), 'coral-legacy-arrival-'));
      tempDirs.push(home);
      const paths = coordinatorFilesForHome(home, 'prod');
      const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      liveChildren.push(dummy);
      if (dummy.pid === undefined) throw new Error('incumbent pid was unavailable');

      const requestDrain = vi.fn();
      const startingAt = Date.now();
      const decideLegacyShutdown = vi.fn(() => ({
        code: 'shutdown_unauthorized' as const,
        message: 'Shutdown refused: the incumbent keeps serving, and the upgrade is deferred to automatic succession.',
      }));
      const ports = buildPorts({
        state,
        isLifecycleRunning: () => state !== 'starting' || Date.now() - startingAt >= 500,
        isDrainRequested: () => false,
        onRequestDrain: requestDrain,
        pid: dummy.pid,
        namespace,
      });
      ports.admin.decideLegacyShutdown = decideLegacyShutdown;
      const listener = createIpcServer(ports);
      mkdirSync(paths.runDir, { recursive: true });
      await listenIpcServer(listener, paths.socketPath, [paths.legacySocketPath]);
      liveListeners.push(listener);
      const discovery = {
        pid: dummy.pid,
        port: 1,
        socketPath: paths.socketPath,
        bundleHash: 'new-incumbent',
        flavor: 'prod',
        namespace,
        startedAt: Date.now(),
        processStartedAt: shippedProcessStartedAtSeconds(dummy.pid),
        token: 't',
        bootToken: 'boot-token',
        version: '0.11.0',
        instanceId: 'i',
      };
      writeFileSync(paths.infoFile, JSON.stringify(discovery), { mode: 0o600 });
      mkdirSync(paths.legacyRunDir, { recursive: true });
      writeFileSync(paths.legacyInfoFile, JSON.stringify({ ...discovery, socketPath: paths.legacySocketPath }), {
        mode: 0o600,
      });

      const contender = spawnCoordinator({ fixture, home, tempRoots: tempDirs });
      contenders.push(contender);
      try {
        await waitForProcessExit(contender, 15_000);
      } catch (error) {
        console.error(`Shipped contender ${tag} output: ${contender.output()}`);
        throw error;
      }
      if (['v0.10.0', 'v0.10.1', 'v0.10.4'].includes(tag)) {
        expect(decideLegacyShutdown).toHaveBeenCalled();
      } else {
        expect(decideLegacyShutdown).not.toHaveBeenCalled();
      }
      expect(dummy.exitCode).toBeNull();
      expect(dummy.signalCode).toBeNull();
      expect(requestDrain).not.toHaveBeenCalled();
      const shutdownsBeforeCli = decideLegacyShutdown.mock.calls.length;

      const cli = spawn(process.execPath, [fixture.cliPath, 'jobs', 'detail', 'missing-job'], {
        env: { ...process.env, HOME: home, TMPDIR: home, CLAUDE_PLUGIN_ROOT: fixture.root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      liveChildren.push(cli);
      let cliOutput = '';
      cli.stdout?.on('data', (chunk: Buffer) => {
        cliOutput += chunk.toString();
      });
      cli.stderr?.on('data', (chunk: Buffer) => {
        cliOutput += chunk.toString();
      });
      cli.stdout?.resume();
      cli.stderr?.resume();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('shipped CLI did not exit')), 15_000);
        cli.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        cli.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      if (['v0.10.0', 'v0.10.1', 'v0.10.4'].includes(tag)) {
        expect(decideLegacyShutdown.mock.calls.length, cliOutput).toBeGreaterThan(shutdownsBeforeCli);
      } else {
        expect(decideLegacyShutdown.mock.calls.length).toBe(shutdownsBeforeCli);
      }
      expect(dummy.exitCode).toBeNull();
      expect(dummy.signalCode).toBeNull();
      expect(requestDrain).not.toHaveBeenCalled();
    },
    40_000,
  );
});
