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
    `${JSON.stringify({ type: 'coral.kb_child.ready', pid, startedAt: 1_000_000, readyAt: 1_000_123 })}\n`,
  );
}

function latestRequest(child: FakeChildProcess): { id: string; method: string; params?: unknown } {
  const parsed = requestMessages(child).at(-1) ?? {};
  if (typeof parsed.id !== 'string' || typeof parsed.method !== 'string') {
    throw new Error('Expected a child request');
  }
  return { id: parsed.id, method: parsed.method, params: parsed.params };
}

function requestMessages(child: FakeChildProcess): Array<{ id?: unknown; method?: unknown; params?: unknown }> {
  return child.stdin.chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown });
}

function writeResponse(child: FakeChildProcess, id: string, result: unknown): void {
  (child.stdout as unknown as PassThrough).write(
    `${JSON.stringify({ type: 'coral.kb_child.response', id, ok: true, result })}\n`,
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

  it('probes the child over the JSONL control protocol and records heartbeat health', async () => {
    const child = new FakeChildProcess(151);
    const { runtime } = createRuntime([child]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(child);
    await start;

    const probe = supervisor.probe();
    await flushMicrotasks();
    const request = latestRequest(child);
    expect(request.method).toBe('health');
    writeResponse(child, request.id, {
      status: 'ready',
      pid: 151,
      startedAt: 1_000_000,
      uptimeMs: 250,
      kbRead: { phase: 'ready', initializedAt: 1_000_100 },
    });

    await expect(probe).resolves.toMatchObject({
      phase: 'online',
      lastHeartbeatAt: 1_000_000,
      lastHeartbeatLatencyMs: 0,
      childUptimeMs: 250,
      kbRead: { phase: 'ready', initializedAt: 1_000_100 },
      pendingRequests: 0,
    });
  });

  it('coalesces concurrent health probes into one child request', async () => {
    const child = new FakeChildProcess(155);
    const { runtime } = createRuntime([child]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(child);
    await start;

    const first = supervisor.probe();
    const second = supervisor.probe();
    await flushMicrotasks();
    const requests = requestMessages(child);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('health');

    writeResponse(child, String(requests[0]?.id), {
      status: 'ready',
      pid: 155,
      startedAt: 1_000_000,
      uptimeMs: 300,
    });

    await expect(first).resolves.toMatchObject({ phase: 'online', childUptimeMs: 300, pendingRequests: 0 });
    await expect(second).resolves.toMatchObject({ phase: 'online', childUptimeMs: 300, pendingRequests: 0 });
  });

  it('sends read-only KB requests over the child control protocol', async () => {
    const child = new FakeChildProcess(157);
    const { runtime } = createRuntime([child]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(child);
    await start;

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note' });
    await flushMicrotasks();
    const request = latestRequest(child);
    expect(request.method).toBe('kb.read');
    expect(request.params).toEqual({ method: 'readNote', slug: 'alpha-note' });
    writeResponse(child, request.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'child' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'child' },
    });
  });

  it('times out an unanswered child health probe and clears the pending request', async () => {
    const child = new FakeChildProcess(161);
    const { runtime, time } = createRuntime([child]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      requestTimeoutMs: 25,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(child);
    await start;

    const probe = supervisor.probe();
    await flushMicrotasks();
    expect(latestRequest(child).method).toBe('health');
    expect(supervisor.read()).toMatchObject({ pendingRequests: 1 });

    time.tick(25);
    await flushMicrotasks();

    await expect(probe).resolves.toMatchObject({
      phase: 'online',
      pendingRequests: 0,
      lastError: 'health probe failed: KB child request timed out after 25ms',
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
    expect(first.stdin.chunks.join('')).toContain('"method":"shutdown"');
    expect(first.stdin.chunks.join('')).toContain('"reason":"test"');
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
