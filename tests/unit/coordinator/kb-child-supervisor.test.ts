import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createKbChildSupervisor } from '#src/coordinator/kb-child/supervisor.js';
import type { ChildProcessLike, ChildReadableLike, ChildStdinLike } from '#src/infra/port-types.js';
import type { Runtime, RuntimeSpawnOptions } from '#src/runtime/ports.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

class FakeStdin extends EventEmitter implements ChildStdinLike {
  destroyed = false;
  chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) {
      this.chunks.push(String(chunk));
    }
    this.destroyed = true;
  }
}

class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough() as unknown as ChildReadableLike;
  readonly stderr = new PassThrough() as unknown as ChildReadableLike;
  readonly killedSignals: NodeJS.Signals[] = [];
  readonly pid: number | undefined;

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal);
  }
}

function createRuntime(children: FakeChildProcess[], time = new VirtualTime()) {
  const spawnCalls: RuntimeSpawnOptions[] = [];
  const runtime = {
    time,
    process: {
      spawn: vi.fn((options: RuntimeSpawnOptions) => {
        spawnCalls.push(options);
        const child = children.shift();
        if (!child) {
          throw new Error('unexpected spawn');
        }
        return child;
      }),
    },
    storage: {},
    env: {},
    ids: {},
    paths: {},
  } as unknown as Runtime;

  return { runtime, spawnCalls, time };
}

function writeReady(child: FakeChildProcess, pid = child.pid): void {
  (child.stdout as unknown as PassThrough).write(
    `${JSON.stringify({ type: 'coral.kb_child.ready', pid, readyAt: 1_000_123 })}\n`,
  );
}

describe('KB child supervisor', () => {
  it('spawns the backend bundle in KB child mode and records ready health', async () => {
    const child = new FakeChildProcess(101);
    const { runtime, spawnCalls } = createRuntime([child]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      instanceId: 'instance-1',
    });

    const start = supervisor.start();
    await flushMicrotasks();

    expect(spawnCalls).toEqual([
      expect.objectContaining({
        command: '/node',
        args: ['/plugin/bridge/coral-backend.cjs', '--kb-child'],
        cwd: '/plugin',
        envAdditions: expect.objectContaining({
          CORAL_KB_CHILD: '1',
          CORAL_KB_CHILD_GENERATION: '1',
          CORAL_KB_CHILD_INSTANCE_ID: 'instance-1',
        }),
      }),
    ]);

    writeReady(child);

    await expect(start).resolves.toMatchObject({
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 101,
      startedAt: 1_000_000,
      readyAt: 1_000_123,
    });
  });

  it('restarts by asking the current child to shut down before spawning the next generation', async () => {
    const first = new FakeChildProcess(201);
    const second = new FakeChildProcess(202);
    const { runtime, spawnCalls } = createRuntime([first, second]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(first);
    await start;

    const restart = supervisor.restart('test');
    await flushMicrotasks();
    expect(first.stdin.destroyed).toBe(true);
    expect(first.stdin.chunks.join('')).toContain('shutdown test');
    expect(spawnCalls).toHaveLength(1);

    first.emitClose(0, null);
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(2);
    writeReady(second);

    await expect(restart).resolves.toMatchObject({
      phase: 'online',
      generation: 2,
      pid: 202,
    });
  });
});
