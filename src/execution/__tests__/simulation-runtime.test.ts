import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../session-manager.js';
import {
  InMemoryPaths,
  InMemoryStorage,
  SealedEnv,
  SequentialIds,
  SimulationRuntime,
  VirtualTime,
  createSimulationBackend,
} from '../simulation/core/index.js';

function waitForChildClose(child: Awaited<ReturnType<SimulationRuntime['process']['spawn']>>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });
}

describe('simulation runtime', () => {
  const worlds: Array<ReturnType<typeof createSimulationBackend>> = [];

  afterEach(async () => {
    while (worlds.length > 0) {
      const world = worlds.pop();
      if (!world) {
        continue;
      }
      await world.backend.shutdown('test-cleanup');
      await world.backend.waitForShutdown();
    }
  });

  it('advances virtual time with tick, sleep, intervals, and same-deadline FIFO ordering', async () => {
    const time = new VirtualTime(100);
    const events: string[] = [];

    const interval = time.setInterval(() => {
      events.push(`interval:${time.now()}`);
    }, 5);
    time.setTimeout(() => {
      events.push('timeout:a');
    }, 10);
    time.setTimeout(() => {
      events.push('timeout:b');
    }, 10);
    const sleep = time.sleep(15).then(() => {
      events.push('sleep');
    });

    time.tick(5);
    await Promise.resolve();
    expect(events).toEqual(['interval:105']);

    time.tick(5);
    await Promise.resolve();
    expect(events).toEqual(['interval:105', 'timeout:a', 'timeout:b', 'interval:110']);

    time.clearInterval(interval);
    time.tick(5);
    await sleep;

    expect(time.now()).toBe(115);
    expect(events).toEqual(['interval:105', 'timeout:a', 'timeout:b', 'interval:110', 'sleep']);
  });

  it('provides in-memory storage with atomic writes, exclusive writes, snapshot/restore, and deterministic paths', () => {
    const time = new VirtualTime(1_000);
    const storage = new InMemoryStorage(time);
    const paths = new InMemoryPaths();
    const workDir = '/tmp/sim/work';
    const filePath = join(workDir, 'alpha.txt');
    const exclusivePath = join(workDir, 'lock.json');
    const atomicPath = join(workDir, 'state.json');

    storage.mkdirSync(workDir, { recursive: true });
    storage.writeFileSync(filePath, 'alpha');
    storage.appendFileSync(filePath, '\nbeta');

    const snapshot = storage.snapshot();

    expect(storage.readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta');
    expect(storage.tryExclusiveWriteSync(exclusivePath, 'one')).toBe(true);
    expect(storage.tryExclusiveWriteSync(exclusivePath, 'two')).toBe(false);
    expect(storage.writeAtomicSync(atomicPath, '{"ok":true}', { encoding: 'utf-8' })).toBe(true);
    storage.renameSync(atomicPath, join(workDir, 'renamed.json'));

    const entries = storage.readdirSync(workDir, { withFileTypes: true }).map((entry) => entry.name);
    const namespace = paths.pluginRootNamespace('/tmp/sim/plugin');
    const projectSource = paths.projectSource('/tmp/sim/project');
    expect(entries).toEqual(['alpha.txt', 'lock.json', 'renamed.json']);
    expect(storage.statSync(filePath).size).toBe(Buffer.byteLength('alpha\nbeta'));
    expect(paths.jobsDir()).toBe('/tmp/sim/jobs');
    expect(paths.sessionBase()).toBe('/tmp/sim/sessions');
    expect(paths.backendInfoPath('/tmp/sim/plugin')).toBe(`/tmp/sim/installations/${namespace}/backend.json`);
    expect(paths.backendLockPath('/tmp/sim/plugin')).toBe(`/tmp/sim/installations/${namespace}/backend.lock`);
    expect(namespace).toMatch(/^[0-9a-f]{12}$/);
    expect(projectSource).toMatch(/^local\/project-[0-9a-f]{8}$/);
    expect(paths.projectSource('/tmp/sim/project')).toBe(projectSource);

    storage.restore(snapshot);

    expect(storage.readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta');
    expect(storage.existsSync(exclusivePath)).toBe(false);
    expect(storage.existsSync(join(workDir, 'renamed.json'))).toBe(false);
  });

  it('scripts spawn and durable processes with deterministic kill and liveness behavior', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({
      stdout: [{ delayMs: 1, data: 'child-out\n' }],
      stderr: [{ delayMs: 2, data: 'child-err\n' }],
      close: { delayMs: 5, code: 0 },
    });
    runtime.spawner.enqueueDurable({
      pid: 30_001,
      stdout: [{ delayMs: 2, data: 'progress-one\n' }],
      stderr: [{ delayMs: 2, data: 'warn-one\n' }],
      exit: null,
      kills: [{ signal: 'SIGTERM', delayMs: 1, exitSignal: 'SIGTERM' }],
    });

    const child = runtime.process.spawn({
      command: 'fake-child',
      args: ['--spawn'],
      mode: 'piped',
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string | Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });

    const closePromise = waitForChildClose(child);
    const durableLaunchPromise = runtime.process.durable.launch({
      provider: 'fake-provider',
      command: 'fake-provider',
      args: ['--exec'],
      jobDir: '/tmp/sim/jobs/job-1',
    });

    await Promise.resolve();
    const durable = await durableLaunchPromise;
    const durableExitPromise = runtime.process.durable.waitForExit(durable);

    runtime.time.tick(5);
    await Promise.resolve();

    expect(await closePromise).toEqual({ code: 0, signal: null });
    expect(stdout).toBe('child-out\n');
    expect(stderr).toBe('child-err\n');
    expect(runtime.storage.readFileSync(durable.stdoutPath, 'utf-8')).toBe('progress-one\n');
    expect(runtime.storage.readFileSync(durable.stderrPath, 'utf-8')).toBe('warn-one\n');
    expect(runtime.process.isAlive(durable.pid)).toBe(true);

    runtime.process.kill(durable.pid, 'SIGTERM');
    expect(runtime.spawner.killCalls).toContainEqual({ pid: 30_001, signal: 'SIGTERM' });
    expect(runtime.process.isAlive(durable.pid)).toBe(true);

    runtime.time.tick(1);
    await expect(durableExitPromise).resolves.toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(runtime.process.isAlive(durable.pid)).toBe(false);

    const ids = new SequentialIds();
    expect(ids.uuid()).toBe('00000000-0000-0000-0000-000000000001');
    expect(ids.uuid()).toBe('00000000-0000-0000-0000-000000000002');
    expect(ids.randomBytes(4).toString('hex')).toBe('00010203');

    const env = new SealedEnv();
    expect(env.pid()).toBe(12_345);
    expect(env.platform()).toBe('linux');
    expect(env.cwd()).toBe('/tmp/sim');
    expect(env.coralSnapshot()).toEqual({
      CORAL_EFFORT: 'medium',
      CORAL_OWNER: 'sim-owner',
    });
  });

  it('creates an isolated simulation backend world with inert boot hooks and a fake provider registry', async () => {
    const worldA = createSimulationBackend({ listen: { port: 4_201 } });
    const worldB = createSimulationBackend({ listen: { port: 4_202 } });
    worlds.push(worldA, worldB);

    const startedA = await worldA.backend.start();
    const startedB = await worldB.backend.start();

    expect(startedA.port).toBe(4_201);
    expect(startedB.port).toBe(4_202);
    expect(worldA.hooks.acquireLockCalls).toHaveLength(1);
    expect(worldA.hooks.listenCalls).toEqual([{ host: '127.0.0.1', port: 4_201 }]);
    expect(worldA.hooks.createKbSubsystemCalls).toHaveLength(1);
    expect(worldA.hooks.recoverPersistedDiscussCalls).toBe(1);
    expect(worldA.providerRegistry.get('fake-provider')).toBeDefined();
    expect(worldA.storage.existsSync(worldA.paths.backendLockPath(worldA.pluginRoot))).toBe(false);
    expect(worldA.storage.existsSync(worldA.paths.backendInfoPath(worldA.pluginRoot))).toBe(true);

    worldA.progressStore.initJob({
      jobId: 'job-a',
      sessionId: 'session-a',
      provider: 'fake-provider',
      projectRoot: worldA.projectRoot,
      backendNamespace: worldA.namespace,
    });

    const sessionA = new SessionManager(worldA.projectRoot, worldA.runtime).allocate({
      provider: 'fake-provider',
      name: 'world-a',
      cwd: worldA.projectRoot,
      projectRoot: worldA.projectRoot,
      backendNamespace: worldA.namespace,
    });

    expect(worldA.progressStore.listJobIds()).toEqual(['job-a']);
    expect(worldB.progressStore.listJobIds()).toEqual([]);
    expect(new SessionManager(worldB.projectRoot, worldB.runtime).get('fake-provider', sessionA.sessionId)).toBeNull();
    expect(worldA.ids.uuid()).toBe('00000000-0000-0000-0000-000000000003');
    expect(worldB.ids.uuid()).toBe('00000000-0000-0000-0000-000000000002');

    await worldA.backend.shutdown('done');
    await worldA.backend.waitForShutdown();
    expect(worldA.storage.existsSync(worldA.paths.backendInfoPath(worldA.pluginRoot))).toBe(false);
    expect(worldA.hooks.removeBackendInfoCalls.length).toBeGreaterThan(0);
  });
});
