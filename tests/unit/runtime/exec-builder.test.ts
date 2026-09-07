import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { EXEC_TIMEOUT_CODE, SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { buildExecPromise } from '#src/runtime/exec-builder.js';
import type { RuntimeSpawnOptions } from '#src/runtime/ports.js';
import type { ChildProcessLike, ChildReadableLike, ChildStdinLike } from '#src/infra/port-types.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

class FakeStdin extends EventEmitter implements ChildStdinLike {
  destroyed = false;

  write(): boolean {
    return true;
  }

  end(): void {
    this.destroyed = true;
  }
}

class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough() as unknown as ChildReadableLike;
  readonly stderr = new PassThrough() as unknown as ChildReadableLike;
  readonly pid: number | undefined;
  readonly killedSignals: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private collected = false;

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.killedSignals.push(signal);
    return !this.collected;
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.collected) this.emitExit(code, signal);
    this.emit('close', code, signal);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.collected = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

describe('buildExecPromise', () => {
  it('propagates explicit shell execution to the process spawn boundary', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const spawnCalls: RuntimeSpawnOptions[] = [];
    const execPromise = buildExecPromise({
      command: 'provider.cmd',
      args: ['--version'],
      shell: true,
      maxBuffer: 1024,
      encoding: 'utf-8',
      spawn: (options) => {
        spawnCalls.push(options);
        return child;
      },
      kill: () => true,
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });

    child.emitClose(0, null);

    await expect(execPromise).resolves.toMatchObject({ status: 0 });
    expect(spawnCalls).toEqual([
      expect.objectContaining({ command: 'provider.cmd', args: ['--version'], shell: true }),
    ]);
  });

  it('continues waiting for close when no kill was scheduled', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: [],
      maxBuffer: 1024,
      encoding: 'utf-8',
      spawn: () => child,
      kill: () => true,
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });
    let settled = false;
    void execPromise.then(() => {
      settled = true;
    });

    child.emitExit(0, null);
    time.tick(SIGKILL_GRACE_MS);
    await flushMicrotasks();
    expect(settled).toBe(false);

    child.emitClose(0, null);
    await expect(execPromise).resolves.toMatchObject({ status: 0 });
  });

  it('uses owned-child group authority on Darwin without a platform capability gate', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const spawnCalls: RuntimeSpawnOptions[] = [];
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs: 5,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: true,
      spawn: (options) => {
        spawnCalls.push(options);
        return child;
      },
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        return true;
      },
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });

    await flushMicrotasks();
    time.tick(5);
    await flushMicrotasks();

    expect(spawnCalls).toEqual([
      expect.objectContaining({
        command: 'fake-exec',
        args: ['--timeout'],
        detached: true,
      }),
    ]);
    expect(killCalls).toEqual([{ pid: -1234, signal: 'SIGTERM' }]);
    expect(child.killedSignals).toEqual([]);

    child.emitClose(null, 'SIGTERM');
    await expect(execPromise).resolves.toMatchObject({
      stdout: '',
      stderr: '',
      status: null,
      error: expect.any(Error),
    });
  });

  it('does not narrow a failed process-group delivery to the leader', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs: 5,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: true,
      spawn: () => child,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        return false;
      },
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });

    await flushMicrotasks();
    time.tick(5);
    await flushMicrotasks();
    time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();

    expect(killCalls).toEqual([
      { pid: -1234, signal: 'SIGTERM' },
      { pid: -1234, signal: 'SIGKILL' },
    ]);
    expect(child.killedSignals).toEqual([]);

    child.emitClose(null, 'SIGKILL');
    await expect(execPromise).resolves.toMatchObject({ status: null, error: expect.any(Error) });
  });

  it('refuses group signaling after the child has been collected', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs: 5,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: true,
      spawn: () => child,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        return true;
      },
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });

    child.emitExit(0, null);
    time.tick(5 + SIGTERM_GRACE_MS);
    await flushMicrotasks();

    expect(killCalls).toEqual([]);
    expect(child.killedSignals).toEqual([]);

    child.emitClose(0, null);
    await expect(execPromise).resolves.toMatchObject({ status: null, error: expect.any(Error) });
  });

  it.each([
    {
      mode: 'group',
      killProcessGroup: true,
      expectedChildSignals: [],
      expectedMessage:
        /no identified signal target; SIGTERM and SIGKILL delivery were not attempted because no pid or pgid could be attributed; child collection and descendant absence remain unobserved; exec will not attempt further signals/,
    },
    {
      mode: 'non-group',
      killProcessGroup: false,
      expectedChildSignals: ['SIGTERM', 'SIGKILL'],
      expectedMessage:
        /no identified signal target; SIGTERM and SIGKILL were attempted through the child handle without an identified pid; child collection and descendant absence remain unobserved; exec will not attempt further signals/,
    },
  ])('reports an unidentified signal target in $mode mode', async (testCase) => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(undefined);
    const processKillCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const timeoutMs = 5;
    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: testCase.killProcessGroup,
      spawn: () => child,
      kill: (pid, signal) => {
        processKillCalls.push({ pid, signal });
        return true;
      },
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });

    time.tick(timeoutMs + SIGTERM_GRACE_MS + SIGKILL_GRACE_MS);

    expect(processKillCalls).toEqual([]);
    expect(child.killedSignals).toEqual(testCase.expectedChildSignals);
    await expect(execPromise).resolves.toMatchObject({
      status: null,
      error: expect.objectContaining({ message: expect.stringMatching(testCase.expectedMessage) }),
    });
  });

  it('still delegates non-group signals to child.kill after the child has been collected', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs: 5,
      maxBuffer: 1024,
      encoding: 'utf-8',
      spawn: () => child,
      kill: () => true,
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });

    child.emitExit(0, null);
    time.tick(5 + SIGTERM_GRACE_MS);
    await flushMicrotasks();

    expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);

    time.tick(SIGKILL_GRACE_MS);
    await expect(execPromise).resolves.toMatchObject({
      status: null,
      error: expect.objectContaining({
        message: expect.stringMatching(
          /child pid 1234 was collected;.*can no longer be attributed to pid 1234; pid 1234 will not be signalled/,
        ),
      }),
    });
  });

  it('settles at the full termination deadline when inherited stdio delays close', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs: 5,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: true,
      spawn: () => child,
      kill: () => true,
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });
    let settled = false;
    void execPromise.then(() => {
      settled = true;
    });

    time.tick(5);
    child.emitExit(null, 'SIGTERM');
    time.tick(SIGTERM_GRACE_MS + SIGKILL_GRACE_MS - 1);
    await flushMicrotasks();
    expect(settled).toBe(false);

    time.tick(1);
    await expect(execPromise).resolves.toMatchObject({
      status: null,
      error: expect.objectContaining({
        code: EXEC_TIMEOUT_CODE,
        message: expect.stringMatching(
          /leader pid 1234 was collected;.*inherited stdio remains running and can no longer be attributed to pgid 1234; pgid 1234 will not be signalled/,
        ),
      }),
    });
  });

  it('settles a bounded exec by the termination deadline when exit and close never arrive', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const timeoutMs = 5;
    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: true,
      spawn: () => child,
      kill: () => true,
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    });
    let settled = false;
    void execPromise.then(() => {
      settled = true;
    });

    time.tick(timeoutMs + SIGTERM_GRACE_MS + SIGKILL_GRACE_MS - 1);
    await flushMicrotasks();
    expect(settled).toBe(false);

    time.tick(1);
    await expect(execPromise).resolves.toMatchObject({
      status: null,
      error: expect.objectContaining({
        code: EXEC_TIMEOUT_CODE,
        message: expect.stringMatching(
          /collection of leader pid 1234 remains unobserved.*SIGTERM and SIGKILL were attempted for pgid 1234;.*will not attempt further signals/,
        ),
      }),
    });
  });
});
