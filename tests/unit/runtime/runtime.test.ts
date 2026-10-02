import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime, waitForDurableRuntime, waitForRecordedDurableExit } from '#src/runtime/real.js';
import type { ChildProcessLike, TimePort } from '#src/infra/port-types.js';
import type {
  DurableLaunchDisposition,
  DurableLaunchResult,
  DurablePendingLaunchObligation,
} from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const createdDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function requireLaunched(disposition: DurableLaunchDisposition): Promise<DurableLaunchResult> {
  if (disposition.disposition === 'launched') return disposition;
  const reason = disposition.reason;
  let held = disposition;
  while (true) {
    await held.retryAfter;
    const retry = await held.retry();
    if (retry.disposition === 'settled') throw new Error(reason);
    held = retry;
  }
}

async function confirmExitGraceAcrossWallClockJump(wallClockJumpMs: number): Promise<{
  wallClockMs: number;
  sleepCount: number;
}> {
  let wallClockMs = 1_700_000_000_000;
  let monotonicMs = 0n;
  let sleepCount = 0;
  const time: Pick<TimePort, 'now' | 'monotonicNow' | 'sleep'> = {
    now: () => wallClockMs,
    monotonicNow: () => monotonicMs,
    sleep: (milliseconds) => {
      sleepCount += 1;
      if (sleepCount === 1) wallClockMs += wallClockJumpMs;
      monotonicMs += BigInt(milliseconds);
      return Promise.resolve();
    },
  };
  const pid = 2_000_000_000;

  await expect(
    waitForRecordedDurableExit(
      {
        pid,
        incarnation: testIncarnation('absent-wrapper'),
        processGroupId: pid,
        childRoot: { pid: pid + 1, incarnation: testIncarnation('absent-child') },
      },
      pid,
      'linux',
      time,
    ),
  ).rejects.toThrow(`Durable process ${pid} exited before the wrapper reported completion`);

  return { wallClockMs, sleepCount };
}

function waitForClose(child: ChildProcessLike): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', reject);
  });
}

async function readPipedOutput(child: ChildProcessLike): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (!child.stdout || !child.stderr) {
    throw new Error('Expected piped stdio handles');
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string | Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: string | Buffer) => {
    stderr += chunk.toString();
  });

  const result = await waitForClose(child);
  return { stdout, stderr, ...result };
}

describe('createRealRuntime', () => {
  it('rejects a silent durable wrapper after a late zero-delay post-wake turn', async () => {
    let monotonicMs = 0n;
    const pending: Array<{ callback: () => void; delayMs: number }> = [];
    const time: TimePort = {
      now: () => Number(monotonicMs),
      monotonicNow: () => monotonicMs,
      sleep: async () => undefined,
      setTimeout: (callback, delayMs) => {
        pending.push({ callback, delayMs });
        return {};
      },
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    const wrapper = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const readiness = waitForDurableRuntime({ time, wrapper: wrapper as never });
    const runNext = (): void => {
      const timer = pending.shift();
      if (timer === undefined) throw new Error('expected a pending readiness timer');
      monotonicMs += BigInt(timer.delayMs === 0 ? 1 : timer.delayMs);
      timer.callback();
    };

    runNext();
    runNext();

    await expect(readiness).rejects.toThrow('Durable wrapper failed to report runtime within 5000ms');
    expect(pending).toEqual([]);
  });

  it('rejects a malformed durable wrapper control message', async () => {
    const time: TimePort = {
      now: () => 0,
      monotonicNow: () => 0n,
      sleep: async () => undefined,
      setTimeout: vi.fn(() => ({})),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    };
    const wrapper = Object.assign(new EventEmitter(), {
      pid: 101,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const readiness = waitForDurableRuntime({ time, wrapper: wrapper as never });

    wrapper.stdout.write('null\n');

    await expect(readiness).rejects.toThrow('Durable wrapper emitted an invalid control message');
  });

  it('measures durable exit confirmation across a backward wall-clock jump with monotonic time', async () => {
    const result = await confirmExitGraceAcrossWallClockJump(-60_000);

    expect(result).toEqual({ wallClockMs: 1_699_999_940_000, sleepCount: 50 });
  });

  it('captures a sealed CORAL_* snapshot once', () => {
    vi.stubEnv('CORAL_OWNER', 'owner-a');
    vi.stubEnv('CORAL_EFFORT', 'high');

    const runtime = createRealRuntime('prod');
    const fullSnapshot = runtime.env.fullSnapshot();
    const snapshot = runtime.env.coralSnapshot();

    expect(fullSnapshot.CORAL_OWNER).toBe('owner-a');
    expect(Object.isFrozen(fullSnapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      CORAL_OWNER: 'owner-a',
      CORAL_EFFORT: 'high',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);

    vi.stubEnv('CORAL_OWNER', 'owner-b');

    expect(runtime.env.coralSnapshot().CORAL_OWNER).toBe('owner-a');
    expect(runtime.env.get('CORAL_OWNER')).toBe('owner-a');
  });

  it('does not claim to observe directory traversability on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (platform === undefined) throw new Error('process.platform descriptor is unavailable');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });

    try {
      const runtime = createRealRuntime('prod');

      expect(runtime.storage.observeDirectoryTraversabilitySync('/path-that-need-not-exist')).toBe('unobserved');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('spawns piped children with sanitized inherited env and per-spawn CORAL overrides', async () => {
    vi.stubEnv('KEEP_ME', 'base-value');
    vi.stubEnv('CORAL_TEST_STRIP_ME', 'secret');

    const runtime = createRealRuntime('prod');
    const child = runtime.process.spawn({
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdout.write(JSON.stringify({',
          '  keep: process.env.KEEP_ME ?? null,',
          '  stripped: process.env.CORAL_TEST_STRIP_ME ?? null,',
          '  owner: process.env.CORAL_OWNER ?? null,',
          '  extra: process.env.EXTRA_ENV ?? null,',
          '  child: process.env.CORAL_CHILD ?? null,',
          '}));',
        ].join(''),
      ],
      envAdditions: {
        CORAL_OWNER: 'session-123',
        EXTRA_ENV: 'extra-value',
      },
    });

    const result = await readPipedOutput(child);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      keep: 'base-value',
      stripped: null,
      owner: 'session-123',
      extra: 'extra-value',
      child: '1',
    });
  });

  it('launches durable detached jobs with private artifacts and without runtime/exit sidecar files', async () => {
    const runtime = createRealRuntime('prod');
    const rootDir = createTempDir('coral-runtime-');
    const jobDir = join(rootDir, 'job-1');
    runtime.storage.mkdirSync(jobDir, { recursive: true });
    // This test must run in a process fork because worker threads cannot set the process umask.
    const originalUmask = process.umask(0o022);

    try {
      const durable = await requireLaunched(
        await runtime.process.durable.launch({
          provider: 'codex',
          command: process.execPath,
          args: [
            '-e',
            [
              "process.stdout.write('step-one\\n');",
              "process.stderr.write('warn\\n');",
              'setTimeout(() => process.exit(0), 25);',
            ].join(''),
          ],
          jobDir,
          envAdditions: {
            CORAL_OWNER: 'durable-owner',
          },
        }),
      );
      const exit = await runtime.process.durable.waitForExit(durable);

      expect(durable.pid).toBeGreaterThan(0);
      expect(durable.launchHandle).toEqual(expect.any(String));
      expect(exit).toMatchObject({ exitCode: 0, signal: null });
      expect(existsSync(join(jobDir, 'runtime.json'))).toBe(false);
      expect(existsSync(join(jobDir, 'exit.json'))).toBe(false);
      expect(runtime.storage.readFileSync(durable.stdoutPath, 'utf-8')).toContain('step-one');
      expect(runtime.storage.readFileSync(durable.stderrPath, 'utf-8')).toContain('warn');
      expect({
        env: runtime.storage.statSync(join(jobDir, 'env.json'), { bigint: true }).mode & 0o777n,
        stdout: runtime.storage.statSync(durable.stdoutPath, { bigint: true }).mode & 0o777n,
        stderr: runtime.storage.statSync(durable.stderrPath, { bigint: true }).mode & 0o777n,
      }).toEqual({ env: 0o600n, stdout: 0o600n, stderr: 0o600n });
    } finally {
      process.umask(originalUmask);
    }
  });

  it('settles a durable wrapper internally when the ownership boundary does not accept it', async () => {
    const runtime = createRealRuntime('prod');
    const jobDir = join(createTempDir('coral-runtime-refused-wrapper-'), 'job-1');
    runtime.storage.mkdirSync(jobDir, { recursive: true });
    let observeRefusal!: (obligation: DurablePendingLaunchObligation) => void;
    const refusalObserved = new Promise<DurablePendingLaunchObligation>((resolve) => {
      observeRefusal = resolve;
    });

    const launch = runtime.process.durable.launch({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000);'],
      jobDir,
      onWrapperSpawned: ((obligation: DurablePendingLaunchObligation) => {
        observeRefusal(obligation);
        return { kind: 'refused' };
      }) as never,
    });
    const refusedObligation = await refusalObserved;

    let launchSettled = false;
    void launch.then(
      () => {
        launchSettled = true;
      },
      () => {
        launchSettled = true;
      },
    );
    await Promise.resolve();
    expect(launchSettled).toBe(false);
    expect(refusedObligation).toMatchObject({
      pid: expect.any(Number),
      settled: expect.any(Promise),
      requestTermination: expect.any(Function),
    });

    await refusedObligation.settled;
    await expect(launch).rejects.toThrow('Durable wrapper ownership was not accepted.');
  });

  it('refuses an exit promise from a different launch handle', async () => {
    const runtime = createRealRuntime('prod');
    const rootDir = createTempDir('coral-runtime-launch-handle-');
    const firstJobDir = join(rootDir, 'job-1');
    const secondJobDir = join(rootDir, 'job-2');
    runtime.storage.mkdirSync(firstJobDir, { recursive: true });
    runtime.storage.mkdirSync(secondJobDir, { recursive: true });

    const first = await requireLaunched(
      await runtime.process.durable.launch({
        provider: 'codex',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 100);'],
        jobDir: firstJobDir,
      }),
    );
    const second = await requireLaunched(
      await runtime.process.durable.launch({
        provider: 'codex',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 100);'],
        jobDir: secondJobDir,
      }),
    );

    await expect(runtime.process.durable.waitForExit({ ...first, launchHandle: second.launchHandle })).rejects.toThrow(
      `Durable launch ${second.launchHandle} is not attached to process ${first.pid}.`,
    );
    await expect(runtime.process.durable.waitForExit(first)).resolves.toMatchObject({ exitCode: 0, signal: null });
    await expect(runtime.process.durable.waitForExit(second)).resolves.toMatchObject({ exitCode: 0, signal: null });
  });

  it('writes and appends through durable storage operations', () => {
    const runtime = createRealRuntime('prod');
    const rootDir = createTempDir('coral-runtime-durable-');
    const statePath = join(rootDir, 'nested', 'state.json');
    const logPath = join(rootDir, 'events', 'events.jsonl');

    expect(runtime.storage.writeAtomicDurableSync(statePath, '{"ok":true}', { encoding: 'utf-8', mode: 0o600 })).toBe(
      true,
    );
    expect(runtime.storage.readFileSync(statePath, 'utf-8')).toBe('{"ok":true}');

    expect(runtime.storage.appendFileDurableSync(logPath, 'one\n')).toBe(true);
    expect(runtime.storage.appendFileDurableSync(logPath, 'two\n')).toBe(true);
    expect(runtime.storage.readFileSync(logPath, 'utf-8')).toBe('one\ntwo\n');
  });

  it('returns false when durable atomic writes hit an ENOENT directory race', async () => {
    const rootDir = createTempDir('coral-runtime-durable-race-');
    const statePath = join(rootDir, 'nested', 'state.json');
    const openSyncMock = vi.fn<typeof NodeFs.openSync>(() => {
      const error = new Error('directory raced with durable open') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        openSync: openSyncMock,
      };
    });

    try {
      const { createRealRuntime: createMockedRuntime } = await import('#src/runtime/real.js');
      const runtime = createMockedRuntime('prod');

      expect(runtime.storage.writeAtomicDurableSync(statePath, '{}')).toBe(false);
      expect(openSyncMock).toHaveBeenCalledWith(`${statePath}.tmp`, 'w');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('returns false when durable appends hit an ENOENT directory race', async () => {
    const rootDir = createTempDir('coral-runtime-durable-append-race-');
    const logPath = join(rootDir, 'nested', 'events.jsonl');
    const openSyncMock = vi.fn<typeof NodeFs.openSync>(() => {
      const error = new Error('directory raced with durable append') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        openSync: openSyncMock,
      };
    });

    try {
      const { createRealRuntime: createMockedRuntime } = await import('#src/runtime/real.js');
      const runtime = createMockedRuntime('prod');

      expect(runtime.storage.appendFileDurableSync(logPath, 'event\n')).toBe(false);
      expect(openSyncMock).toHaveBeenCalledWith(logPath, 'a');
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
