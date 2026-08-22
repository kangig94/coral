import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BUFFER, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import type { StoragePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { SessionManager } from '#src/sessions/shell.js';
import { createSimulationBackend } from '#tools/simulation/core/backend.js';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';
import { InMemoryPaths, SealedEnv, SequentialIds } from '#tools/simulation/core/runtime-doubles.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { providerLookupPortFromCatalog } from '#src/providers/catalog.js';

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
    expect(time.monotonicNow()).toBe(100n);

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
    expect(time.monotonicNow()).toBe(115n);
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
    expect(storage.writeAtomicDurableSync(join('/tmp/sim/missing', 'state.json'), '{}')).toBe(true);
    expect(storage.appendFileDurableSync(join('/tmp/sim/missing', 'events.jsonl'), 'event\n')).toBe(true);
    storage.renameSync(atomicPath, join(workDir, 'renamed.json'));

    const entries = storage.readdirSync(workDir, { withFileTypes: true }).map((entry) => entry.name);
    const namespace = paths.pluginRootNamespace('/tmp/sim/plugin');
    const projectSource = paths.projectSource('/tmp/sim/project');
    expect(entries).toEqual(['alpha.txt', 'lock.json', 'renamed.json']);
    expect(storage.statSync(filePath).size).toBe(Buffer.byteLength('alpha\nbeta\ngamma'));
    expect(paths.jobsDir()).toBe('/tmp/sim/jobs');
    expect(paths.coral.coordinator.infoFile).toBe('/tmp/sim/coral/gen2/run/coordinator.json');
    expect(namespace).toMatch(/^[0-9a-f]{12}$/);
    expect(projectSource).toMatch(/^local\/project-[0-9a-f]{8}$/);
    expect(paths.projectSource('/tmp/sim/project')).toBe(projectSource);

    storage.restore(snapshot);

    expect(storage.readFileSync(filePath, 'utf-8')).toBe('alpha\nbeta');
    expect(storage.existsSync(exclusivePath)).toBe(false);
    expect(storage.existsSync(join(workDir, 'renamed.json'))).toBe(false);
  });

  it('refuses recursive directory creation beneath a regular file', () => {
    const storage = new InMemoryStorage(new VirtualTime(1_000));
    const file = '/tmp/sim/file-barrier';
    const child = join(file, 'child');
    storage.writeFileSync(file, 'content');

    expect(() => storage.mkdirSync(child, { recursive: true })).toThrowError(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
    expect(storage.existsSync(child)).toBe(false);
  });

  it('matches real filesystem modes and keeps every stat overload internally consistent', () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'coral-simulation-storage-'));
    const originalUmask = process.umask(0o022);

    try {
      const storage = new InMemoryStorage(new VirtualTime(1_000));
      const simulatedDirectory = '/tmp/sim/metadata';
      const simulatedFile = join(simulatedDirectory, 'file.txt');
      const realDirectory = join(realRoot, 'metadata');
      const realFile = join(realDirectory, 'file.txt');

      storage.mkdirSync(simulatedDirectory, { mode: 0o777 });
      mkdirSync(realDirectory, { mode: 0o777 });
      storage.writeFileSync(simulatedFile, 'alpha');
      writeFileSync(realFile, 'alpha');

      const expectConsistentViews = (simulatedPath: string, realPath: string): void => {
        const simulatedLstat = storage.lstatSync(simulatedPath);
        const simulatedStat = storage.statSync(simulatedPath);
        const simulatedBigIntLstat = storage.lstatSync(simulatedPath, { bigint: true });
        const simulatedBigIntStat = storage.statSync(simulatedPath, { bigint: true });
        const realLstat = lstatSync(realPath, { bigint: true });
        const realStat = statSync(realPath, { bigint: true });

        expect({
          lstat: {
            directory: simulatedLstat.isDirectory(),
            file: simulatedLstat.isFile(),
            symbolicLink: simulatedLstat.isSymbolicLink(),
          },
          stat: {
            directory: simulatedStat.isDirectory(),
            file: simulatedStat.isFile(),
          },
          bigintLstat: {
            directory: simulatedBigIntLstat.isDirectory(),
            file: simulatedBigIntLstat.isFile(),
            type: simulatedBigIntLstat.mode & 0o170000n,
            mode: simulatedBigIntLstat.mode & 0o7777n,
            uid: simulatedBigIntLstat.uid,
          },
          bigintStat: {
            directory: simulatedBigIntStat.isDirectory(),
            file: simulatedBigIntStat.isFile(),
            type: simulatedBigIntStat.mode & 0o170000n,
            mode: simulatedBigIntStat.mode & 0o7777n,
            uid: simulatedBigIntStat.uid,
          },
        }).toEqual({
          lstat: {
            directory: realLstat.isDirectory(),
            file: realLstat.isFile(),
            symbolicLink: realLstat.isSymbolicLink(),
          },
          stat: {
            directory: realStat.isDirectory(),
            file: realStat.isFile(),
          },
          bigintLstat: {
            directory: realLstat.isDirectory(),
            file: realLstat.isFile(),
            type: realLstat.mode & 0o170000n,
            mode: realLstat.mode & 0o7777n,
            uid: realLstat.uid,
          },
          bigintStat: {
            directory: realStat.isDirectory(),
            file: realStat.isFile(),
            type: realStat.mode & 0o170000n,
            mode: realStat.mode & 0o7777n,
            uid: realStat.uid,
          },
        });
        expect(simulatedStat.size).toBe(Number(simulatedBigIntStat.size));
        expect(simulatedStat.mtimeMs).toBe(Number(simulatedBigIntStat.mtimeNs / 1_000_000n));
        expect(simulatedBigIntLstat).toMatchObject({
          dev: expect.any(BigInt),
          ino: expect.any(BigInt),
          mode: expect.any(BigInt),
          size: expect.any(BigInt),
          mtimeNs: expect.any(BigInt),
        });
        expect(simulatedBigIntLstat).toMatchObject({
          dev: simulatedBigIntStat.dev,
          ino: simulatedBigIntStat.ino,
          mode: simulatedBigIntStat.mode,
          size: simulatedBigIntStat.size,
          mtimeNs: simulatedBigIntStat.mtimeNs,
        });
      };

      expectConsistentViews(simulatedDirectory, realDirectory);
      expectConsistentViews(simulatedFile, realFile);

      storage.chmodSync(simulatedDirectory, 0o17654);
      chmodSync(realDirectory, 0o17654);

      expectConsistentViews(simulatedDirectory, realDirectory);
    } finally {
      process.umask(originalUmask);
      const realDirectory = join(realRoot, 'metadata');
      if (existsSync(realDirectory)) chmodSync(realDirectory, 0o700);
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it.each([0o022, 0o077])('matches real file-creation modes under umask %o', (umask) => {
    const realRoot = mkdtempSync(join(tmpdir(), 'coral-simulation-mode-parity-'));
    const realStorage = createRealRuntime('prod', { baseDir: realRoot }).storage;
    const simulatedStorage: StoragePort = new InMemoryStorage(new VirtualTime(1_000));
    const simulatedRoot = '/tmp/sim/mode-parity';
    const originalUmask = process.umask(umask);

    const cases: Array<{
      name: string;
      create(storage: StoragePort, path: string, mode: number | undefined): void;
    }> = [
      {
        name: 'writeFileSync',
        create: (storage, path, mode) =>
          storage.writeFileSync(path, 'value', mode === undefined ? undefined : { mode }),
      },
      {
        name: 'openSync',
        create: (storage, path, mode) => {
          const fd = storage.openSync(path, 'w', mode);
          storage.closeSync(fd);
        },
      },
      {
        name: 'appendFileSync',
        create: (storage, path) => storage.appendFileSync(path, 'value'),
      },
      {
        name: 'writeAtomicSync',
        create: (storage, path, mode) => {
          expect(storage.writeAtomicSync(path, 'value', mode === undefined ? undefined : { mode })).toBe(true);
        },
      },
      {
        name: 'writeAtomicDurableSync',
        create: (storage, path, mode) => {
          expect(storage.writeAtomicDurableSync(path, 'value', mode === undefined ? undefined : { mode })).toBe(true);
        },
      },
      {
        name: 'tryExclusiveWriteSync',
        create: (storage, path, mode) => {
          expect(storage.tryExclusiveWriteSync(path, 'value', mode === undefined ? undefined : { mode })).toBe(true);
        },
      },
    ];

    try {
      simulatedStorage.mkdirSync(simulatedRoot, { recursive: true });
      realStorage.mkdirSync(realRoot, { recursive: true });
      const simulatedModes: Record<string, number> = {};
      const realModes: Record<string, number> = {};

      for (const testCase of cases) {
        const modes = testCase.name === 'appendFileSync' ? [undefined] : [undefined, 0o640];
        for (const mode of modes) {
          const suffix = mode === undefined ? 'default' : 'explicit';
          const fileName = `${testCase.name}-${suffix}`;
          const simulatedPath = join(simulatedRoot, fileName);
          const realPath = join(realRoot, fileName);

          testCase.create(simulatedStorage, simulatedPath, mode);
          testCase.create(realStorage, realPath, mode);

          const label = `${testCase.name}:${suffix}`;
          simulatedModes[label] = Number(simulatedStorage.statSync(simulatedPath, { bigint: true }).mode & 0o7777n);
          realModes[label] = Number(realStorage.statSync(realPath, { bigint: true }).mode & 0o7777n);
        }
      }

      expect(simulatedModes).toEqual(realModes);

      const errorCode = (action: () => void): string | undefined => {
        try {
          action();
          return undefined;
        } catch (error: unknown) {
          return (error as NodeJS.ErrnoException).code;
        }
      };
      const simulatedExclusive = join(simulatedRoot, 'write-flag-wx');
      const realExclusive = join(realRoot, 'write-flag-wx');
      simulatedStorage.writeFileSync(simulatedExclusive, 'first');
      realStorage.writeFileSync(realExclusive, 'first');
      expect({
        simulated: errorCode(() => simulatedStorage.writeFileSync(simulatedExclusive, 'second', { flag: 'wx' })),
        real: errorCode(() => realStorage.writeFileSync(realExclusive, 'second', { flag: 'wx' })),
      }).toEqual({ simulated: 'EEXIST', real: 'EEXIST' });
      expect({
        simulated: simulatedStorage.readFileSync(simulatedExclusive, 'utf-8'),
        real: realStorage.readFileSync(realExclusive, 'utf-8'),
      }).toEqual({ simulated: 'first', real: 'first' });

      const simulatedMissing = join(simulatedRoot, 'write-flag-r-plus-missing');
      const realMissing = join(realRoot, 'write-flag-r-plus-missing');
      expect({
        simulated: errorCode(() => simulatedStorage.writeFileSync(simulatedMissing, 'value', { flag: 'r+' })),
        real: errorCode(() => realStorage.writeFileSync(realMissing, 'value', { flag: 'r+' })),
      }).toEqual({ simulated: 'ENOENT', real: 'ENOENT' });

      const simulatedExisting = join(simulatedRoot, 'write-flag-r-plus-existing');
      const realExisting = join(realRoot, 'write-flag-r-plus-existing');
      simulatedStorage.writeFileSync(simulatedExisting, 'abcdef');
      realStorage.writeFileSync(realExisting, 'abcdef');
      simulatedStorage.writeFileSync(simulatedExisting, 'xy', { flag: 'r+' });
      realStorage.writeFileSync(realExisting, 'xy', { flag: 'r+' });
      expect({
        simulated: simulatedStorage.readFileSync(simulatedExisting, 'utf-8'),
        real: realStorage.readFileSync(realExisting, 'utf-8'),
      }).toEqual({ simulated: 'xycdef', real: 'xycdef' });

      simulatedStorage.writeFileSync(simulatedExisting, 'tail', { flag: 'a' });
      realStorage.writeFileSync(realExisting, 'tail', { flag: 'a' });
      expect({
        simulated: simulatedStorage.readFileSync(simulatedExisting, 'utf-8'),
        real: realStorage.readFileSync(realExisting, 'utf-8'),
      }).toEqual({ simulated: 'xycdeftail', real: 'xycdeftail' });

      simulatedStorage.writeFileSync(simulatedExisting, 'reset', { flag: 'w' });
      realStorage.writeFileSync(realExisting, 'reset', { flag: 'w' });
      expect({
        simulated: simulatedStorage.readFileSync(simulatedExisting, 'utf-8'),
        real: realStorage.readFileSync(realExisting, 'utf-8'),
      }).toEqual({ simulated: 'reset', real: 'reset' });
    } finally {
      process.umask(originalUmask);
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it('reports classifiable errno codes for unsupported in-memory write and open flags', () => {
    const storage = new InMemoryStorage(new VirtualTime(1_000));
    const path = '/tmp/sim/unsupported-flag';

    expect(() => storage.writeFileSync(path, 'value', { flag: 'unsupported' })).toThrowError(
      expect.objectContaining({ code: 'EINVAL' }),
    );
    expect(() => storage.openSync(path, 'unsupported')).toThrowError(expect.objectContaining({ code: 'EINVAL' }));
  });

  it('reapplies an explicit atomic mode when a fixed temp file survives', () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'coral-atomic-temp-mode-'));
    const realStorage = createRealRuntime('prod', { baseDir: realRoot }).storage;
    const simulatedStorage = new InMemoryStorage(new VirtualTime(1_000));
    const simulatedPath = '/tmp/sim/atomic-temp-mode/state.json';
    const realPath = join(realRoot, 'state.json');
    const originalUmask = process.umask(0o077);

    try {
      simulatedStorage.mkdirSync(join('/tmp/sim/atomic-temp-mode'), { recursive: true });
      simulatedStorage.writeFileSync(`${simulatedPath}.tmp`, 'stale');
      realStorage.writeFileSync(`${realPath}.tmp`, 'stale');
      simulatedStorage.chmodSync(`${simulatedPath}.tmp`, 0o644);
      realStorage.chmodSync(`${realPath}.tmp`, 0o644);

      expect(simulatedStorage.writeAtomicSync(simulatedPath, 'fresh', { mode: 0o600 })).toBe(true);
      expect(realStorage.writeAtomicSync(realPath, 'fresh', { mode: 0o600 })).toBe(true);
      expect({
        simulated: Number(simulatedStorage.statSync(simulatedPath, { bigint: true }).mode & 0o7777n),
        real: Number(realStorage.statSync(realPath, { bigint: true }).mode & 0o7777n),
      }).toEqual({ simulated: 0o600, real: 0o600 });
    } finally {
      process.umask(originalUmask);
      rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it('reports the same owner through path, entry, and descriptor bigint stats', () => {
    const storage = new InMemoryStorage(new VirtualTime(1_000));
    const directory = '/tmp/sim/descriptor-metadata';
    const file = join(directory, 'file.txt');
    const owner = BigInt(process.getuid?.() ?? 0);
    storage.mkdirSync(directory, { recursive: true });
    storage.writeFileSync(file, 'alpha');
    const descriptor = storage.openSync(file, 'r');

    try {
      const pathStat = storage.statSync(file, { bigint: true });
      const entryStat = storage.lstatSync(file, { bigint: true });
      const descriptorStat = storage.fstatSync(descriptor, { bigint: true });

      expect({
        pathUid: pathStat.uid,
        entryUid: entryStat.uid,
        fdUid: descriptorStat.uid,
        fdHasUid: Object.hasOwn(descriptorStat, 'uid'),
      }).toEqual({ pathUid: owner, entryUid: owner, fdUid: owner, fdHasUid: true });
    } finally {
      storage.closeSync(descriptor);
    }
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
      provider: 'codex',
      command: 'codex',
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
    expect(runtime.process.observeLiveness(durable.pid)).toBe('alive');

    runtime.process.kill(durable.pid, 'SIGTERM');
    expect(runtime.spawner.killCalls).toContainEqual({ pid: 30_001, signal: 'SIGTERM' });
    expect(runtime.process.observeLiveness(durable.pid)).toBe('alive');

    runtime.time.tick(1);
    await expect(durableExitPromise).resolves.toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(runtime.process.observeLiveness(durable.pid)).toBe('absent');

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
        detached: true,
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
    expect(runtime.spawner.spawnCalls).toEqual([
      expect.objectContaining({
        command: 'fake-timeout',
        args: ['--clock'],
        detached: true,
      }),
    ]);
    expect(runtime.spawner.killCalls).toEqual([{ pid: -20_000, signal: 'SIGTERM' }]);
  });

  it('escalates async exec process-group timeouts to SIGKILL when SIGTERM does not close the child', async () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({
      close: null,
      kills: [
        { signal: 'SIGTERM', delayMs: SIGTERM_GRACE_MS + 10, exitSignal: 'SIGTERM' },
        { signal: 'SIGKILL', delayMs: 0, exitSignal: 'SIGKILL' },
      ],
    });

    const execPromise = runtime.process.exec('fake-stubborn-timeout', ['--clock'], { timeout: 5 });

    await flushMicrotasks();
    runtime.time.tick(5);
    await flushMicrotasks();
    expect(runtime.spawner.killCalls).toEqual([{ pid: -20_000, signal: 'SIGTERM' }]);

    runtime.time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();
    expect(runtime.spawner.killCalls).toEqual([
      { pid: -20_000, signal: 'SIGTERM' },
      { pid: -20_000, signal: 'SIGKILL' },
    ]);

    runtime.time.tick(1);
    await flushMicrotasks();
    await expect(execPromise).resolves.toMatchObject({
      stdout: '',
      stderr: '',
      status: null,
      error: expect.any(Error),
    });
    expect(pendingTimerCount(runtime.time)).toBe(0);
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
    expect(worldA.hooks.kbDaemonStartCalls).toHaveLength(1);
    expect(worldA.hooks.recoverPersistedDiscussCalls).toBe(1);
    expect(worldA.providerRegistry.get('codex')).toBeDefined();
    expect(worldA.projectRoot).toBe(join(worldA.carryOver.runtimeRoot, 'project'));
    expect(worldA.runtime.storage.existsSync(worldA.runtime.paths.coral.coordinator.infoFile)).toBe(true);
    const bound = await worldA.providerRegistry.bindProfile(
      'codex',
      {
        provider: 'codex',
        profile: { canonicalLocation: '/tmp/sim/accounts/codex', routing: { kind: 'home' } },
      },
      worldA.runtime.storage,
    );
    if (!bound.ok) throw new Error('expected the simulation Codex profile to bind');

    initTestJob(worldA.progressStore, {
      jobId: 'job-a',
      sessionId: 'session-a',
      provider: 'codex',
      projectRoot: worldA.projectRoot,
      backendNamespace: worldA.namespace,
    });

    const sessionA = new SessionManager(
      worldA.projectRoot,
      worldA.runtime,
      undefined,
      undefined,
      worldA.progressStore.getDb(),
      providerLookupPortFromCatalog(worldA.providerRegistry),
    ).allocate({
      binding: bound.value.envelope,
      name: 'world-a',
      cwd: worldA.projectRoot,
      projectRoot: worldA.projectRoot,
      backendNamespace: worldA.namespace,
    });

    expect(worldA.progressStore.listJobIds()).toEqual(['job-a']);
    expect(worldB.progressStore.listJobIds()).toEqual([]);
    expect(
      new SessionManager(
        worldB.projectRoot,
        worldB.runtime,
        undefined,
        undefined,
        worldB.progressStore.getDb(),
        providerLookupPortFromCatalog(worldB.providerRegistry),
      ).get('codex', sessionA.sessionId),
    ).toBeNull();
    expect(worldA.runtime.ids.uuid()).toBe('00000000-0000-0000-0000-000000000003');
    expect(worldB.runtime.ids.uuid()).toBe('00000000-0000-0000-0000-000000000002');

    await worldA.backend.shutdown('done');
    await worldA.backend.waitForShutdown();
    expect(worldA.runtime.storage.existsSync(worldA.runtime.paths.coral.coordinator.infoFile)).toBe(false);
    expect(worldA.hooks.removeBackendInfoCalls.length).toBeGreaterThan(0);
  });

  // Without advancing the clock, which is the whole point. A script can retire a pid and allocate the same
  // number again inside one virtual instant, and while incarnations were minted from the clock both spawns
  // got the same token — a false *match* on a reused pid, the one outcome containment must never produce.
  // The counter that replaced the clock is only observable here, so the old algorithm could return with the
  // rest of the suite green.
  it('gives a reused pid a different incarnation within one virtual instant', () => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueSpawn({ pid: 4242 });
    runtime.spawner.enqueueSpawn({ pid: 4242 });

    runtime.process.spawn({ command: 'fake-child', args: ['--first'] });
    const first = runtime.spawner.readProcessIncarnation(4242);
    runtime.process.spawn({ command: 'fake-child', args: ['--second'] });
    const second = runtime.spawner.readProcessIncarnation(4242);

    expect(first).not.toBeNull();
    expect(second, 'a reused pid must never carry the incarnation of the process that had it').not.toBe(first);
  });
});
import { initTestJob } from '#tests/helpers/session.js';
