import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { buildExecPromise } from '#src/runtime/exec-builder.js';
import type { RuntimeSpawnOptions } from '#src/runtime/ports.js';
import type { ChildProcessLike, ChildReadableLike, ChildStdinLike } from '#src/infra/port-types.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
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

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.killedSignals.push(signal);
    return true;
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal);
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

  it('falls back to direct child signaling when process-group signaling fails', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const spawnCalls: RuntimeSpawnOptions[] = [];
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const incarnation = testIncarnation(1_234_000);

    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs: 5,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: true,
      platform: 'linux',
      readProcessIncarnation: () => incarnation,
      spawn: (options) => {
        spawnCalls.push(options);
        return child;
      },
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

    expect(spawnCalls).toEqual([
      expect.objectContaining({
        command: 'fake-exec',
        args: ['--timeout'],
        detached: true,
      }),
    ]);
    expect(killCalls).toEqual([{ pid: -1234, signal: 'SIGTERM' }]);
    expect(child.killedSignals).toEqual(['SIGTERM']);

    child.emitClose(null, 'SIGTERM');
    await expect(execPromise).resolves.toMatchObject({
      stdout: '',
      stderr: '',
      status: null,
      error: expect.any(Error),
    });
  });

  it('refuses a delayed group signal after the leader pid is recycled', async () => {
    const time = new VirtualTime();
    const child = new FakeChildProcess(1234);
    const incarnation = testIncarnation(1_234_000);
    const recycledIncarnation = testIncarnation(1_234_001);
    let currentIncarnation = incarnation;
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

    const execPromise = buildExecPromise({
      command: 'fake-exec',
      args: ['--timeout'],
      timeoutMs: 5,
      maxBuffer: 1024,
      encoding: 'utf-8',
      killProcessGroup: true,
      platform: 'linux',
      readProcessIncarnation: () => currentIncarnation,
      spawn: () => child,
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
    currentIncarnation = recycledIncarnation;
    time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();

    expect(killCalls).toEqual([{ pid: -1234, signal: 'SIGTERM' }]);
    expect(child.killedSignals).toEqual(['SIGKILL']);

    child.emitClose(null, 'SIGKILL');
    await expect(execPromise).resolves.toMatchObject({ status: null, error: expect.any(Error) });
  });
});
