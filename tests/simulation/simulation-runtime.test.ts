import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BUFFER } from '#src/infra/process-constants.js';
import { SessionManager } from '#src/sessions/shell/store.js';
import {
  InMemoryPaths,
  InMemoryStorage,
  SealedEnv,
  SequentialIds,
  SimulationRuntime,
  VirtualTime,
  createSimulationBackend,
  flushMicrotasks,
} from '#tools/simulation/core/backend.js';

function waitForChildClose(child: Awaited<ReturnType<SimulationRuntime['process']['spawn']>>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });
}

function pendingTimerCount(time: VirtualTime): number {
  return (time as unknown as { timers: Map<number, unknown> }).timers.size;
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

  it('defers recursive delay-zero timeouts to the next tick', () => {
    const time = new VirtualTime(100);
    let calls = 0;

    const recursive = () => {
      calls += 1;
      if (calls < 3) {
        time.setTimeout(recursive, 0);
      }
    };

    time.setTimeout(recursive, 0);

    time.tick(0);
    expect(time.now()).toBe(100);
    expect(calls).toBe(0);

    time.tick(1);
    expect(time.now()).toBe(101);
    expect(calls).toBe(1);

    time.tick(1);
    expect(time.now()).toBe(102);
    expect(calls).toBe(2);
  });

  it('finishes due timers and advances to the target before rethrowing callback errors', () => {
    const time = new VirtualTime(100);
    const error = new Error('timer failed');
    const events: string[] = [];

    time.setTimeout(() => {
      events.push(`first:${time.now()}`);
    }, 5);
    time.setTimeout(() => {
      events.push(`throw:${time.now()}`);
      throw error;
    }, 5);
    time.setTimeout(() => {
      events.push(`after:${time.now()}`);
    }, 10);

    expect(() => time.tick(10)).toThrow(error);
    expect(time.now()).toBe(110);
    expect(events).toEqual(['first:105', 'throw:105', 'after:110']);
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
    expect(storage.writeAtomicDurableSync(atomicPath, '{"ok":"durable"}', { encoding: 'utf-8' })).toBe(true);
    expect(storage.appendFileDurableSync(filePath, '\ngamma')).toBe(true);
    expect(storage.writeAtomicDurableSync(join('/tmp/sim/missing', 'state.json'), '{}')).toBe(false);
    expect(storage.appendFileDurableSync(join('/tmp/sim/missing', 'events.jsonl'), 'event\n')).toBe(false);
    storage.renameSync(atomicPath, join(workDir, 'renamed.json'));

    const entries = storage.readdirSync(workDir, { withFileTypes: true }).map((entry) => entry.name);
    const namespace = paths.pluginRootNamespace('/tmp/sim/plugin');
    const projectSource = paths.projectSource('/tmp/sim/project');
    expect(entries).toEqual(['alpha.txt', 'lock.json', 'renamed.json']);
    expect(storage.statSync(filePath).size).toBe(Buffer.byteLength('alpha\nbeta\ngamma'));
    expect(paths.jobsDir()).toBe('/tmp/sim/jobs');
    expect(paths.coral.coordinator.infoFile).toBe('/tmp/sim/coral/run/coordinator.json');
    expect(namespace).toMatch(/^[0-9a-f]{12}$/);
    expect(projectSource).toMatch(/^local\/project-[0-9a-f]{8}$/);
    expect(paths.projectSource('/tmp/sim/project')).toBe(projectSource);

    storage.restore(snapshot);

    expect(storage.readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta');
    expect(storage.existsSync(exclusivePath)).toBe(false);
    expect(storage.existsSync(join(workDir, 'renamed.json'))).toBe(false);
  });

  it('keeps in-memory storage directory listings updated across indexed mutations', () => {
    const storage = new InMemoryStorage(new VirtualTime(1_000));
    const root = '/tmp/indexed';
    const appendedPath = join(root, 'append.txt');
    const alphaPath = join(root, 'alpha.txt');
    const nestedPath = join(root, 'nested');
    const leafPath = join(nestedPath, 'leaf');

    const list = (path: string) => storage.readdirSync(path, { withFileTypes: true }).map((entry) => entry.name);

    storage.mkdirSync(leafPath, { recursive: true });
    storage.writeFileSync(alphaPath, 'alpha');
    storage.appendFileSync(appendedPath, 'append');
    storage.tryExclusiveWriteSync(join(nestedPath, 'lock.json'), 'lock');
    storage.writeAtomicSync(join(leafPath, 'state.json'), '{"ok":true}', { encoding: 'utf-8' });

    expect(list(root)).toEqual(['alpha.txt', 'append.txt', 'nested']);
    expect(list(nestedPath)).toEqual(['leaf', 'lock.json']);
    expect(list(leafPath)).toEqual(['state.json']);

    const snapshot = storage.snapshot();

    storage.renameSync(alphaPath, join(nestedPath, 'alpha.txt'));
    storage.unlinkSync(appendedPath);
    storage.renameSync(nestedPath, join(root, 'renamed'));

    expect(list(root)).toEqual(['renamed']);
    expect(list(join(root, 'renamed'))).toEqual(['alpha.txt', 'leaf', 'lock.json']);

    storage.rmSync(join(root, 'renamed'), { recursive: true });
    expect(list(root)).toEqual([]);

    storage.restore(snapshot);
    expect(list(root)).toEqual(['alpha.txt', 'append.txt', 'nested']);
    expect(list(nestedPath)).toEqual(['leaf', 'lock.json']);
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

  it('collects spawn events through the in-memory runtime observer', () => {
    const world = createSimulationBackend();

    const received: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    const subscription = world.runtime.observer.onSpawn((event) => {
      received.push({
        command: event.command,
        args: [...event.args],
        ...(event.env ? { env: { ...event.env } } : {}),
      });
    });

    const child = world.runtime.process.spawn({
      command: 'fake-child',
      args: ['--observe'],
      envAdditions: {
        TOKEN: 'redacted',
      },
    });

    expect(world.runtime.observer.events).toHaveLength(1);
    expect(world.runtime.observer.events[0]).toMatchObject({
      command: 'fake-child',
      args: ['--observe'],
      env: { TOKEN: 'redacted' },
    });
    expect(world.runtime.observer.events[0]?.child).toBe(child);
    expect(received).toEqual([
      {
        command: 'fake-child',
        args: ['--observe'],
        env: { TOKEN: 'redacted' },
      },
    ]);

    subscription[Symbol.dispose]();

    world.runtime.process.spawn({
      command: 'after-dispose',
      args: [],
    });

    expect(world.runtime.observer.events).toHaveLength(2);
    expect(received).toHaveLength(1);
  });

  it('reuses the spawn queue for exec and exposes the dispatch through spawnCalls and observer events', async () => {
    const runtime = new SimulationRuntime();
    const observed: Array<{ command: string; args: string[] }> = [];
    runtime.observer.onSpawn((event) => {
      observed.push({
        command: event.command,
        args: [...event.args],
      });
    });

    runtime.spawner.enqueueSpawn({
      stdout: [{ delayMs: 1, data: 'exec-out\n' }],
      stderr: [{ delayMs: 2, data: 'exec-err\n' }],
      close: { delayMs: 3, code: 0 },
    });

    const execPromise = runtime.process.exec('fake-exec', ['--queued'], { timeout: 25 });
    await flushMicrotasks();

    expect(runtime.spawner.spawnCalls).toEqual([
      expect.objectContaining({
        command: 'fake-exec',
        args: ['--queued'],
      }),
    ]);
    expect(observed).toEqual([
      {
        command: 'fake-exec',
        args: ['--queued'],
      },
    ]);

    runtime.time.tick(3);
    await flushMicrotasks();

    await expect(execPromise).resolves.toEqual({
      stdout: 'exec-out\n',
      stderr: 'exec-err\n',
      status: 0,
    });
    expect(pendingTimerCount(runtime.time)).toBe(0);
  });

  it('pins async exec timeouts to the simulation clock', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({
      close: null,
      kills: [{ signal: 'SIGTERM', delayMs: 0, exitSignal: 'SIGTERM' }],
    });

    let settled = false;
    const execPromise = runtime.process.exec('fake-timeout', ['--clock'], { timeout: 5 }).then((result) => {
      settled = true;
      return result;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);

    runtime.time.tick(4);
    await flushMicrotasks();
    expect(settled).toBe(false);

    runtime.time.tick(1);
    await flushMicrotasks();
    expect(settled).toBe(false);

    runtime.time.tick(1);
    await flushMicrotasks();

    await expect(execPromise).resolves.toMatchObject({
      stdout: '',
      stderr: '',
      status: null,
      error: expect.any(Error),
    });
    expect(runtime.spawner.killCalls).toEqual([{ pid: 20_000, signal: 'SIGTERM' }]);
  });

  it('uses a queued execSync script API with deterministic command matching and recorded calls', () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueExecSync({
      command: 'git',
      args: ['status', '--short'],
      result: {
        stdout: 'M src/index.ts\n',
        stderr: '',
        status: 0,
      },
    });

    expect(() => runtime.process.execSync('git', ['diff'])).toThrow(
      'Expected execSync git ["status","--short"] but received git ["diff"]',
    );

    const result = runtime.process.execSync('git', ['status', '--short'], { timeout: 15 });

    expect(result).toEqual({
      stdout: 'M src/index.ts\n',
      stderr: '',
      status: 0,
    });
    expect(runtime.spawner.execSyncCalls).toEqual([
      {
        command: 'git',
        args: ['diff'],
        options: { encoding: 'utf-8', maxBuffer: MAX_BUFFER },
      },
      {
        command: 'git',
        args: ['status', '--short'],
        options: { timeout: 15, encoding: 'utf-8', maxBuffer: MAX_BUFFER },
      },
    ]);
  });

  it('creates an isolated simulation backend world with inert boot hooks and a fake provider registry', async () => {
    const worldA = createSimulationBackend({ listen: { port: 4_201 } });
    const worldB = createSimulationBackend({ listen: { port: 4_202 } });
    worlds.push(worldA, worldB);

    const startedA = await worldA.backend.start();
    const startedB = await worldB.backend.start();

    expect(startedA.port).toBe(4_201);
    expect(startedB.port).toBe(4_202);
    expect(worldA.hooks.listenCalls).toEqual([{ host: '127.0.0.1', port: 4_201 }]);
    expect(worldA.hooks.createKbSubsystemCalls).toHaveLength(1);
    expect(worldA.hooks.recoverPersistedDiscussCalls).toBe(1);
    expect(worldA.providerRegistry.get('fake-provider')).toBeDefined();
    expect(worldA.runtime.storage.existsSync(worldA.runtime.paths.coral.coordinator.infoFile)).toBe(true);

    worldA.progressStore.initJob({
      jobId: 'job-a',
      sessionId: 'session-a',
      provider: 'fake-provider',
      projectRoot: worldA.projectRoot,
      backendNamespace: worldA.namespace,
    });

    const sessionA = new SessionManager(
      worldA.projectRoot,
      worldA.runtime,
      undefined,
      undefined,
      worldA.progressStore.getDb(),
    ).allocate({
      provider: 'fake-provider',
      name: 'world-a',
      cwd: worldA.projectRoot,
      projectRoot: worldA.projectRoot,
      backendNamespace: worldA.namespace,
    });

    expect(worldA.progressStore.listJobIds()).toEqual(['job-a']);
    expect(worldB.progressStore.listJobIds()).toEqual([]);
    expect(
      new SessionManager(worldB.projectRoot, worldB.runtime, undefined, undefined, worldB.progressStore.getDb()).get(
        'fake-provider',
        sessionA.sessionId,
      ),
    ).toBeNull();
    expect(worldA.runtime.ids.uuid()).toBe('00000000-0000-0000-0000-000000000003');
    expect(worldB.runtime.ids.uuid()).toBe('00000000-0000-0000-0000-000000000002');

    await worldA.backend.shutdown('done');
    await worldA.backend.waitForShutdown();
    expect(worldA.runtime.storage.existsSync(worldA.runtime.paths.coral.coordinator.infoFile)).toBe(false);
    expect(worldA.hooks.removeBackendInfoCalls.length).toBeGreaterThan(0);
  });
});
