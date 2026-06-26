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

  it('sends KB mutation requests over the child control protocol', async () => {
    const child = new FakeChildProcess(159);
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

    const mutation = supervisor.mutateKb({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'body', owner: 'kang' },
      ctx: { projectRoot: '/workspace/project-a', pluginRoot: '/plugin' },
    });
    await flushMicrotasks();
    const request = latestRequest(child);
    expect(request.method).toBe('kb.mutate');
    expect(request.params).toEqual({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'body', owner: 'kang' },
      ctx: { projectRoot: '/workspace/project-a', pluginRoot: '/plugin' },
    });
    writeResponse(child, request.id, {
      ok: true,
      data: { filename: 'memo.md' },
    });

    await expect(mutation).resolves.toEqual({
      ok: true,
      data: { filename: 'memo.md' },
    });
  });

  it('forwards child event messages to the supervisor event callback', async () => {
    const child = new FakeChildProcess(160);
    const { runtime } = createRuntime([child]);
    const onEvent = vi.fn();
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      onEvent,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(child);
    await start;

    (child.stdout as unknown as PassThrough).write(
      `${JSON.stringify({
        type: 'coral.kb_child.event',
        event: 'journal',
        appended: [{ seq: 1, ts: '2026-06-26T00:00:00.000Z', type: 'job.progress.emitted', stream: { kind: 'job', id: 'job-1' } }],
      })}\n`,
    );
    await flushMicrotasks();

    expect(onEvent).toHaveBeenCalledWith({
      type: 'coral.kb_child.event',
      event: 'journal',
      appended: [
        {
          seq: 1,
          ts: '2026-06-26T00:00:00.000Z',
          type: 'job.progress.emitted',
          stream: { kind: 'job', id: 'job-1' },
        },
      ],
    });
  });

  it('notifies exit listeners when the active child closes', async () => {
    const child = new FakeChildProcess(160);
    const { runtime } = createRuntime([child]);
    const onExit = vi.fn();
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });
    supervisor.onExit?.(onExit);

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(child);
    await start;

    (child.stderr as unknown as PassThrough).write('child failed while running job\n');
    child.emitClose(1, null);
    await flushMicrotasks();

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'failed',
        generation: 1,
        lastError: 'child failed while running job',
        lastExit: expect.objectContaining({ code: 1, signal: null }),
      }),
    );
  });

  it('sends child KB job abort requests over the control protocol', async () => {
    const child = new FakeChildProcess(161);
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

    const abort = supervisor.abortKbJobs?.(['kb-job-1']);
    await flushMicrotasks();
    const request = latestRequest(child);
    expect(request.method).toBe('kb.abort');
    expect(request.params).toEqual({ jobIds: ['kb-job-1'] });
    writeResponse(child, request.id, { aborted: ['kb-job-1'], notFound: [] });

    await expect(abort).resolves.toEqual({ aborted: ['kb-job-1'], notFound: [] });
  });

  it('lists active child KB jobs over the control protocol', async () => {
    const child = new FakeChildProcess(162);
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

    const list = supervisor.listActiveKbJobs?.();
    await flushMicrotasks();
    const request = latestRequest(child);
    expect(request.method).toBe('kb.jobs');
    expect(request.params).toBeUndefined();
    writeResponse(child, request.id, { active: ['kb-job-1', 'kb-job-2'] });

    await expect(list).resolves.toEqual({ active: ['kb-job-1', 'kb-job-2'] });
  });

  it('restarts once and retries read-only KB requests after the child exits', async () => {
    const first = new FakeChildProcess(171);
    const second = new FakeChildProcess(172);
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

    (first.stderr as unknown as PassThrough).write('first child failed\n');
    first.emitClose(1, null);
    await flushMicrotasks();
    expect(supervisor.read()).toMatchObject({
      phase: 'failed',
      generation: 1,
      lastError: 'first child failed',
    });

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note' });
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(2);

    writeReady(second);
    await flushMicrotasks(12);
    const request = latestRequest(second);
    expect(request.method).toBe('kb.read');
    expect(request.params).toEqual({ method: 'readNote', slug: 'alpha-note' });
    writeResponse(second, request.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'recovered-child' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'recovered-child' },
    });
    expect(supervisor.read()).toMatchObject({ phase: 'online', generation: 2, pid: 172, pendingRequests: 0 });
  });

  it('waits for an in-flight start before retrying read-only KB requests', async () => {
    const child = new FakeChildProcess(173);
    const { runtime, spawnCalls } = createRuntime([child]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note' });
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(1);

    writeReady(child);
    await start;
    await flushMicrotasks(12);

    const request = latestRequest(child);
    expect(request.method).toBe('kb.read');
    expect(request.params).toEqual({ method: 'readNote', slug: 'alpha-note' });
    writeResponse(child, request.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'started-child' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'started-child' },
    });
    expect(spawnCalls).toHaveLength(1);
  });

  it('restarts and retries read-only KB requests after a request timeout', async () => {
    const first = new FakeChildProcess(174);
    const second = new FakeChildProcess(175);
    const { runtime, spawnCalls, time } = createRuntime([first, second]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      requestTimeoutMs: 25,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(first);
    await start;

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note' });
    await flushMicrotasks();
    const firstRequest = latestRequest(first);
    expect(firstRequest.method).toBe('kb.read');

    time.tick(25);
    await flushMicrotasks(12);
    expect(first.stdin.destroyed).toBe(true);
    expect(first.stdin.chunks.join('')).toContain('"method":"shutdown"');
    expect(first.stdin.chunks.join('')).toContain('"reason":"read request recovery"');

    first.emitClose(0, null);
    await flushMicrotasks(12);
    expect(spawnCalls).toHaveLength(2);

    writeReady(second);
    await flushMicrotasks(12);
    const secondRequest = latestRequest(second);
    expect(secondRequest.method).toBe('kb.read');
    expect(secondRequest.params).toEqual({ method: 'readNote', slug: 'alpha-note' });
    writeResponse(second, secondRequest.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'timeout-recovered-child' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'timeout-recovered-child' },
    });
    expect(supervisor.read()).toMatchObject({ phase: 'online', generation: 2, pid: 175, pendingRequests: 0 });
  });

  it('does not retry KB mutation requests after a request timeout', async () => {
    const first = new FakeChildProcess(174);
    const second = new FakeChildProcess(175);
    const { runtime, spawnCalls, time } = createRuntime([first, second]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      requestTimeoutMs: 25,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(first);
    await start;

    const mutation = supervisor.mutateKb({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'body', owner: 'kang' },
      ctx: { projectRoot: '/workspace/project-a', pluginRoot: '/plugin' },
    });
    await flushMicrotasks();
    expect(latestRequest(first).method).toBe('kb.mutate');

    time.tick(25);
    await flushMicrotasks(12);

    await expect(mutation).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      message: expect.stringContaining('request was not retried'),
    });
    expect(first.stdin.destroyed).toBe(false);
    expect(first.stdin.chunks.join('')).not.toContain('"reason":"mutation request recovery"');
    expect(spawnCalls).toHaveLength(1);
  });

  it('uses the extended request timeout for KB job mutations', async () => {
    const child = new FakeChildProcess(176);
    const { runtime, time } = createRuntime([child]);
    const supervisor = createKbChildSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      requestTimeoutMs: 25,
      jobRequestTimeoutMs: 100,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(child);
    await start;

    let settled = false;
    const mutation = supervisor
      .mutateKb({
        method: 'createSource',
        args: { filePath: '/workspace/project-a/source.md', async: false },
        ctx: { projectRoot: '/workspace/project-a', pluginRoot: '/plugin' },
      })
      .finally(() => {
        settled = true;
      });
    await flushMicrotasks();
    expect(latestRequest(child).method).toBe('kb.mutate');

    time.tick(25);
    await flushMicrotasks(12);
    expect(settled).toBe(false);
    expect(supervisor.read()).toMatchObject({ pendingRequests: 1 });

    time.tick(75);
    await flushMicrotasks(12);
    await expect(mutation).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      message: expect.stringContaining('timed out after 100ms'),
    });
  });

  it('does not restart read-only KB requests after dispose is requested', async () => {
    const first = new FakeChildProcess(176);
    const second = new FakeChildProcess(177);
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

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note' });
    await flushMicrotasks();
    expect(latestRequest(first).method).toBe('kb.read');

    const dispose = supervisor.dispose('shutdown');
    await flushMicrotasks();
    expect(first.stdin.destroyed).toBe(true);

    first.emitClose(0, null);
    await flushMicrotasks(12);

    await expect(read).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      detail: { reason: 'kb_child_unavailable' },
    });
    await dispose;
    expect(spawnCalls).toHaveLength(1);
    expect(supervisor.read()).toMatchObject({ phase: 'stopped', generation: 1, pendingRequests: 0 });
  });

  it('keeps read recovery disabled when dispose is queued behind a restart', async () => {
    const first = new FakeChildProcess(178);
    const second = new FakeChildProcess(179);
    const third = new FakeChildProcess(180);
    const { runtime, spawnCalls } = createRuntime([first, second, third]);
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

    const probe = supervisor.probe();
    await flushMicrotasks();
    const probeRequest = latestRequest(first);
    expect(probeRequest.method).toBe('health');

    const restart = supervisor.restart('operator');
    const dispose = supervisor.dispose('shutdown');
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(1);

    writeResponse(first, probeRequest.id, {
      status: 'ready',
      pid: 178,
      startedAt: 1_000_000,
      uptimeMs: 10,
    });
    await probe;
    await flushMicrotasks(12);
    expect(first.stdin.chunks.join('')).toContain('"reason":"operator"');

    first.emitClose(0, null);
    await flushMicrotasks(12);
    expect(spawnCalls).toHaveLength(2);
    writeReady(second);
    await restart;
    await flushMicrotasks(12);
    expect(second.stdin.chunks.join('')).toContain('"reason":"shutdown"');

    second.emitClose(0, null);
    await dispose;

    await expect(supervisor.readKb({ method: 'readNote', slug: 'alpha-note' })).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
    });
    expect(spawnCalls).toHaveLength(2);
  });

  it('warms the child read runtime over the control protocol', async () => {
    const child = new FakeChildProcess(158);
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

    const warmup = supervisor.warmup();
    await flushMicrotasks();
    const request = latestRequest(child);
    expect(request.method).toBe('kb.warmup');
    writeResponse(child, request.id, { phase: 'ready', initializedAt: 1_000_200 });

    await expect(warmup).resolves.toMatchObject({
      phase: 'online',
      kbRead: { phase: 'ready', initializedAt: 1_000_200 },
      pendingRequests: 0,
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
