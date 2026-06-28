import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
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

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    return true;
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal);
  }
}

describe('buildExecPromise', () => {
  it('falls back to direct child signaling when process-group signaling fails', async () => {
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
        return pid > 0;
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
    expect(killCalls).toEqual([
      { pid: -1234, signal: 'SIGTERM' },
      { pid: 1234, signal: 'SIGTERM' },
    ]);

    child.emitClose(null, 'SIGTERM');
    await expect(execPromise).resolves.toMatchObject({
      stdout: '',
      stderr: '',
      status: null,
      error: expect.any(Error),
    });
  });
});
