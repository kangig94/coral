import { EventEmitter } from 'node:events';

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createKbDaemonSupervisor,
  type KbDaemonCurateAssistantHandler,
} from '#src/coordinator/live/kb-daemon-supervisor/index.js';
import type { Runtime, RuntimeSpawnOptions } from '#src/runtime/ports.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';

class FakeStdin extends EventEmitter {
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

class FakeDaemonProcess extends EventEmitter implements ChildProcessLike {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedSignals: NodeJS.Signals[] = [];
  readonly pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function createRuntime(daemonProcesses: FakeDaemonProcess[]) {
  const time = new VirtualTime();
  const spawnCalls: RuntimeSpawnOptions[] = [];
  const runtime = {
    time,
    process: {
      spawn: vi.fn((options: RuntimeSpawnOptions) => {
        spawnCalls.push(options);
        return daemonProcesses.shift();
      }),
      observeLiveness: () => 'alive' as const,
    },
    storage: {},
    env: { get: () => undefined, coralSnapshot: () => ({}) },
    ids: {},
    paths: {},
  } as unknown as Runtime;
  return { runtime, spawnCalls, time };
}

function daemonCtx(projectRoot = '/workspace/project-a') {
  const canonicalProjectRoot = fixtureCanonicalWorkDir(projectRoot);
  return {
    projectRoot: canonicalProjectRoot,
    pluginRoot: '/plugin',
    principal: {
      subject: 'operator' as const,
      binding: { kind: 'project' as const, root: canonicalProjectRoot },
    },
  };
}

function writeReady(daemonProcess: FakeDaemonProcess, pid = daemonProcess.pid): void {
  (daemonProcess.stdout as unknown as PassThrough).write(
    `${JSON.stringify({ type: 'coral.kb_daemon.ready', pid, startedAt: 1_000_000, readyAt: 1_000_123 })}\n`,
  );
}

function latestRequest(daemonProcess: FakeDaemonProcess): { id: string; method: string; params?: unknown } {
  const parsed = requestMessages(daemonProcess).at(-1) ?? {};
  if (typeof parsed.id !== 'string' || typeof parsed.method !== 'string') {
    throw new Error('Expected a daemon request');
  }
  return { id: parsed.id, method: parsed.method, params: parsed.params };
}

function requestMessages(
  daemonProcess: FakeDaemonProcess,
): Array<{ id?: unknown; method?: unknown; params?: unknown }> {
  return daemonProcess.stdin.chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown });
}

function writeResponse(daemonProcess: FakeDaemonProcess, id: string, result: unknown): void {
  (daemonProcess.stdout as unknown as PassThrough).write(
    `${JSON.stringify({ type: 'coral.kb_daemon.response', id, ok: true, result })}\n`,
  );
}

function writeParentRequest(daemonProcess: FakeDaemonProcess, id: string, method: string, params?: unknown): void {
  (daemonProcess.stdout as unknown as PassThrough).write(
    `${JSON.stringify({ type: 'coral.kb_daemon.parent_request', id, method, params })}\n`,
  );
}

describe('KB daemon supervisor', () => {
  it('reports failed and escalates SIGTERM→SIGKILL when the daemon misses the start timeout', async () => {
    const daemonProcess = new FakeDaemonProcess(103);
    const { runtime, time } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      startTimeoutMs: 50,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    time.tick(50);

    await expect(start).resolves.toMatchObject({ phase: 'failed', generation: 1 });
    expect(daemonProcess.killedSignals).toContain('SIGTERM');

    time.tick(5_000);
    expect(daemonProcess.killedSignals).toContain('SIGKILL');
  });

  it('does not spawn another daemon while a failed-phase child is still live', async () => {
    const first = new FakeDaemonProcess(104);
    const second = new FakeDaemonProcess(105);
    const { runtime, spawnCalls, time } = createRuntime([first, second]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      startTimeoutMs: 25,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    time.tick(25);

    await expect(start).resolves.toMatchObject({ phase: 'failed', generation: 1, pid: 104 });
    expect(first.killedSignals).toContain('SIGTERM');
    expect(spawnCalls).toHaveLength(1);

    const secondStart = supervisor.start();
    await flushMicrotasks();

    expect(spawnCalls).toHaveLength(1);
    await expect(secondStart).resolves.toMatchObject({ phase: 'failed', generation: 1, pid: 104 });
  });

  it('aborts an active daemon curate assistant parent request when the daemon cancels it', async () => {
    const daemonProcess = new FakeDaemonProcess(160);
    const { runtime } = createRuntime([daemonProcess]);
    const observed: { signal?: AbortSignal } = {};
    const curateAssistant = vi.fn<KbDaemonCurateAssistantHandler>(
      async (_request, { signal }: { signal: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          observed.signal = signal;
          signal.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))),
            { once: true },
          );
        }),
    );
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      curateAssistant,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    writeParentRequest(daemonProcess, 'parent:1', 'curate.assistant.complete', {
      prompt: 'classify this',
      purpose: 'classification',
    });
    await flushMicrotasks();
    expect(observed.signal?.aborted).toBe(false);

    writeParentRequest(daemonProcess, 'parent:2', 'curate.request.cancel', {
      requestId: 'parent:1',
      reason: 'scheduler stopped',
    });
    await flushMicrotasks(4);

    expect(observed.signal?.aborted).toBe(true);
  });

  it('restarts once and retries read-only KB requests after the daemon exits', async () => {
    const first = new FakeDaemonProcess(171);
    const second = new FakeDaemonProcess(172);
    const { runtime, spawnCalls } = createRuntime([first, second]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(first);
    await start;

    (first.stderr as unknown as PassThrough).write('first daemon failed\n');
    first.emitClose(1, null);
    await flushMicrotasks();
    expect(supervisor.read()).toMatchObject({
      phase: 'failed',
      generation: 1,
      lastError: 'first daemon failed',
    });

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(2);

    writeReady(second);
    await flushMicrotasks(12);
    const request = latestRequest(second);
    expect(request.method).toBe('kb.read');
    writeResponse(second, request.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'recovered-daemon' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'recovered-daemon' },
    });
    expect(supervisor.read()).toMatchObject({ phase: 'online', generation: 2, pid: 172, pendingRequests: 0 });
  });

  it('does not retry KB mutation requests after a request timeout', async () => {
    const first = new FakeDaemonProcess(174);
    const second = new FakeDaemonProcess(175);
    const { runtime, spawnCalls, time } = createRuntime([first, second]);
    const supervisor = createKbDaemonSupervisor({
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
      ctx: daemonCtx(),
    });
    await flushMicrotasks();

    time.tick(25);
    await flushMicrotasks(12);

    await expect(mutation).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      message: expect.stringContaining('request was not retried'),
    });
    expect(first.stdin.destroyed).toBe(false);
    expect(spawnCalls).toHaveLength(1);
  });

  it('holds disposal until close and prevents a queued restart', async () => {
    const daemonProcess = new FakeDaemonProcess(183);
    const { runtime, time, spawnCalls } = createRuntime([daemonProcess, new FakeDaemonProcess(184)]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      stopTimeoutMs: 100,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const disposal = supervisor.dispose('shutdown');
    const restart = supervisor.restart('queued restart');
    await flushMicrotasks();
    time.tick(100);
    await flushMicrotasks(12);
    const held = await disposal;

    expect(held).toMatchObject({
      kind: 'holding',
      snapshot: { phase: 'failed', pid: 183 },
      reason: expect.stringContaining('has not been observed absent'),
      exit: 'kb-daemon-process-close',
      retryAfter: expect.any(Promise),
      retry: expect.any(Function),
    });
    if (held.kind !== 'holding') throw new Error('Expected daemon disposal to remain held');

    await expect(restart).resolves.toMatchObject({ phase: 'failed', pid: 183 });
    expect(spawnCalls).toHaveLength(1);
    const retry = held.retry();
    await flushMicrotasks();
    daemonProcess.emitClose(0, null);

    await expect(held.retryAfter).resolves.toBeUndefined();
    await expect(retry).resolves.toMatchObject({
      kind: 'confirmed-absent',
      snapshot: { phase: 'stopped', pid: null },
    });
    await expect(supervisor.restart('after close')).resolves.toMatchObject({ phase: 'stopped', pid: null });
    expect(spawnCalls).toHaveLength(1);
  });
});
