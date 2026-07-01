import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createDisabledKbDaemonSupervisor,
  createKbDaemonSupervisor,
  type KbDaemonCurateAssistantHandler,
} from '#src/coordinator/live/kb-daemon-supervisor.js';
import type { Runtime, RuntimeSpawnOptions } from '#src/runtime/ports.js';
import { CORAL_KB_EXTRA_LANGS_ENV } from '#src/kb/extra-langs.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

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

class FakeDaemonProcess extends EventEmitter {
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
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

function createRuntime(
  daemonProcesses: FakeDaemonProcess[],
  time = new VirtualTime(),
  envVars: Record<string, string | undefined> = {},
) {
  const spawnCalls: RuntimeSpawnOptions[] = [];
  const runtime = {
    time,
    process: {
      spawn: vi.fn((options: RuntimeSpawnOptions) => {
        spawnCalls.push(options);
        const daemonProcess = daemonProcesses.shift();
        if (!daemonProcess) {
          throw new Error('unexpected spawn');
        }
        return daemonProcess;
      }),
    },
    storage: {},
    env: {
      get: (key: string): string | undefined => envVars[key],
      coralSnapshot: (): Readonly<Record<string, string>> =>
        Object.fromEntries(
          Object.entries(envVars).filter(
            (entry): entry is [string, string] => entry[0].startsWith('CORAL_') && entry[1] !== undefined,
          ),
        ),
    },
    ids: {},
    paths: {},
  } as unknown as Runtime;

  return { runtime, spawnCalls, time };
}

function daemonCtx(projectRoot = '/workspace/project-a') {
  return {
    projectRoot,
    pluginRoot: '/plugin',
    principal: {
      subject: 'operator' as const,
      binding: { kind: 'project' as const, root: projectRoot },
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

function parentResponses(daemonProcess: FakeDaemonProcess): Array<{
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
}> {
  return daemonProcess.stdin.chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown },
    )
    .filter((message) => message.type === 'coral.kb_daemon.parent_response');
}

describe('KB daemon supervisor', () => {
  it('spawns the backend bundle in KB daemon mode and records ready health', async () => {
    const daemonProcess = new FakeDaemonProcess(101);
    const { runtime, spawnCalls } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
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
        args: ['/plugin/bridge/coral-backend.cjs'],
        cwd: '/plugin',
        envAdditions: expect.objectContaining({
          CORAL_KB_DAEMON: '1',
          CORAL_KB_DAEMON_GENERATION: '1',
          CORAL_KB_DAEMON_INSTANCE_ID: 'instance-1',
        }),
      }),
    ]);

    writeReady(daemonProcess);

    await expect(start).resolves.toMatchObject({
      enabled: true,
      phase: 'online',
      generation: 1,
      pid: 101,
      startedAt: 1_000_000,
      readyAt: 1_000_123,
    });
  });

  it('forwards every inherited CORAL_KB_* config var into the spawn env (composeChildEnv strips inherited CORAL_*)', async () => {
    const daemonProcess = new FakeDaemonProcess(111);
    const { runtime, spawnCalls } = createRuntime([daemonProcess], new VirtualTime(), {
      [CORAL_KB_EXTRA_LANGS_ENV]: 'ko,ja',
      CORAL_KB_IMPORT_MARKER_DEVICE: 'cuda',
      CORAL_KB_CORPUS_SCAN_MAX_FILES: '9000',
    });
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    void supervisor.start();
    await flushMicrotasks();

    // Values are forwarded verbatim — parsing stays in the daemon.
    expect(spawnCalls[0]?.envAdditions).toMatchObject({
      [CORAL_KB_EXTRA_LANGS_ENV]: 'ko,ja',
      CORAL_KB_IMPORT_MARKER_DEVICE: 'cuda',
      CORAL_KB_CORPUS_SCAN_MAX_FILES: '9000',
    });
  });

  it('does not forward CORAL_* vars that lack the CORAL_KB_ prefix and are not allowlisted', async () => {
    const daemonProcess = new FakeDaemonProcess(112);
    const { runtime, spawnCalls } = createRuntime([daemonProcess], new VirtualTime(), {
      CORAL_MAX_WORKERS: '4',
      CORAL_ENV_PASSTHROUGH: 'FOO',
    });
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    void supervisor.start();
    await flushMicrotasks();

    // Guard against a vacuous pass: the spawn must have happened for the negative
    // assertions below to mean anything.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.envAdditions).not.toHaveProperty('CORAL_MAX_WORKERS');
    expect(spawnCalls[0]?.envAdditions).not.toHaveProperty('CORAL_ENV_PASSTHROUGH');
  });

  it('forwards allowlisted parent-owned knobs that do not carry the CORAL_KB_ prefix', async () => {
    const daemonProcess = new FakeDaemonProcess(113);
    const { runtime, spawnCalls } = createRuntime([daemonProcess], new VirtualTime(), {
      CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
    });
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    void supervisor.start();
    await flushMicrotasks();

    expect(spawnCalls[0]?.envAdditions).toMatchObject({ CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000' });
  });

  it('lets daemon-identity vars override any inherited CORAL_KB_DAEMON_* collision', async () => {
    const daemonProcess = new FakeDaemonProcess(114);
    const { runtime, spawnCalls } = createRuntime([daemonProcess], new VirtualTime(), {
      CORAL_KB_DAEMON_GENERATION: '999',
    });
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    void supervisor.start();
    await flushMicrotasks();

    // First start → generation 1, not the stale inherited 999.
    expect(spawnCalls[0]?.envAdditions).toMatchObject({ CORAL_KB_DAEMON_GENERATION: '1' });
  });

  it('reports failed when the daemon closes before emitting ready', async () => {
    const daemonProcess = new FakeDaemonProcess(102);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    daemonProcess.emitClose(1, null);

    await expect(start).resolves.toMatchObject({ phase: 'failed', generation: 1, pid: null });
  });

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

  it('probes the daemon over the JSONL control protocol and records heartbeat health', async () => {
    const daemonProcess = new FakeDaemonProcess(151);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const probe = supervisor.probe();
    await flushMicrotasks();
    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('health');
    writeResponse(daemonProcess, request.id, {
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
      daemonUptimeMs: 250,
      kbRead: { phase: 'ready', initializedAt: 1_000_100 },
      pendingRequests: 0,
    });
  });

  it('coalesces concurrent health probes into one daemon request', async () => {
    const daemonProcess = new FakeDaemonProcess(155);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const first = supervisor.probe();
    const second = supervisor.probe();
    await flushMicrotasks();
    const requests = requestMessages(daemonProcess);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('health');

    writeResponse(daemonProcess, String(requests[0]?.id), {
      status: 'ready',
      pid: 155,
      startedAt: 1_000_000,
      uptimeMs: 300,
    });

    await expect(first).resolves.toMatchObject({ phase: 'online', daemonUptimeMs: 300, pendingRequests: 0 });
    await expect(second).resolves.toMatchObject({ phase: 'online', daemonUptimeMs: 300, pendingRequests: 0 });
  });

  it('sends read-only KB requests over the daemon control protocol', async () => {
    const daemonProcess = new FakeDaemonProcess(157);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
    await flushMicrotasks();
    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('kb.read');
    expect(request.params).toEqual({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
    writeResponse(daemonProcess, request.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'daemon' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'daemon' },
    });
  });

  it('aborts a pending daemon KB read when the caller signal aborts', async () => {
    const daemonProcess = new FakeDaemonProcess(158);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });
    const controller = new AbortController();

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const read = supervisor.readKb(
      { method: 'readSearch', args: { query: 'abort' }, ctx: daemonCtx() },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('kb.read');
    expect(supervisor.read().pendingRequests).toBe(1);

    controller.abort();
    await expect(read).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      message: 'KB daemon read request aborted.',
    });
    expect(supervisor.read().pendingRequests).toBe(0);
  });

  it('sends KB mutation requests over the daemon control protocol', async () => {
    const daemonProcess = new FakeDaemonProcess(159);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const mutation = supervisor.mutateKb({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'body', owner: 'kang' },
      ctx: daemonCtx(),
    });
    await flushMicrotasks();
    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('kb.mutate');
    expect(request.params).toEqual({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'body', owner: 'kang' },
      ctx: daemonCtx(),
    });
    writeResponse(daemonProcess, request.id, {
      ok: true,
      data: { filename: 'memo.md' },
    });

    await expect(mutation).resolves.toEqual({
      ok: true,
      data: { filename: 'memo.md' },
    });
  });

  it('forwards daemon event messages to the supervisor event callback', async () => {
    const daemonProcess = new FakeDaemonProcess(160);
    const { runtime } = createRuntime([daemonProcess]);
    const onEvent = vi.fn();
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      onEvent,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    (daemonProcess.stdout as unknown as PassThrough).write(
      `${JSON.stringify({
        type: 'coral.kb_daemon.event',
        event: 'journal',
        appended: [
          {
            seq: 1,
            ts: '2026-06-26T00:00:00.000Z',
            type: 'job.progress.emitted',
            stream: { kind: 'job', id: 'job-1' },
          },
        ],
      })}\n`,
    );
    await flushMicrotasks();

    expect(onEvent).toHaveBeenCalledWith({
      type: 'coral.kb_daemon.event',
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

  it('serves daemon curate assistant parent requests through the configured handler', async () => {
    const daemonProcess = new FakeDaemonProcess(160);
    const { runtime } = createRuntime([daemonProcess]);
    const curateAssistant = vi.fn<KbDaemonCurateAssistantHandler>(async () => 'curate-result');
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
      model: 'sonnet',
      permissionMode: 'auto',
    });
    await flushMicrotasks(4);

    expect(curateAssistant).toHaveBeenCalledWith(
      {
        prompt: 'classify this',
        purpose: 'classification',
        model: 'sonnet',
        permissionMode: 'auto',
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(parentResponses(daemonProcess)).toContainEqual(
      expect.objectContaining({
        id: 'parent:1',
        ok: true,
        result: 'curate-result',
      }),
    );
  });

  it('returns parent request errors when the configured curate handler throws synchronously', async () => {
    const daemonProcess = new FakeDaemonProcess(160);
    const { runtime } = createRuntime([daemonProcess]);
    const curateAssistant = vi.fn<KbDaemonCurateAssistantHandler>(() => {
      throw new Error('startup not ready');
    });
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
    await flushMicrotasks(4);

    expect(parentResponses(daemonProcess)).toContainEqual(
      expect.objectContaining({
        id: 'parent:1',
        ok: false,
        error: { message: 'startup not ready' },
      }),
    );
  });

  it('continues processing control lines that arrive in the same chunk as daemon ready', async () => {
    const daemonProcess = new FakeDaemonProcess(160);
    const { runtime } = createRuntime([daemonProcess]);
    const curateAssistant = vi.fn<KbDaemonCurateAssistantHandler>(async () => 'curate-result');
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      curateAssistant,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    (daemonProcess.stdout as unknown as PassThrough).write(
      `${JSON.stringify({
        type: 'coral.kb_daemon.ready',
        pid: 160,
        startedAt: 1_000_000,
        readyAt: 1_000_123,
      })}\n${JSON.stringify({
        type: 'coral.kb_daemon.parent_request',
        id: 'parent:1',
        method: 'curate.assistant.complete',
        params: {
          prompt: 'classify this',
          purpose: 'classification',
        },
      })}\n`,
    );

    await start;
    await flushMicrotasks(4);

    expect(curateAssistant).toHaveBeenCalledWith(
      {
        prompt: 'classify this',
        purpose: 'classification',
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(parentResponses(daemonProcess)).toContainEqual(
      expect.objectContaining({
        id: 'parent:1',
        ok: true,
        result: 'curate-result',
      }),
    );
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

    writeParentRequest(daemonProcess, 'parent:2', 'curate.assistant.cancel', {
      requestId: 'parent:1',
      reason: 'scheduler stopped',
    });
    await flushMicrotasks(4);

    expect(observed.signal?.aborted).toBe(true);
    expect(parentResponses(daemonProcess)).toContainEqual(
      expect.objectContaining({
        id: 'parent:2',
        ok: true,
        result: { canceled: true },
      }),
    );
    expect(parentResponses(daemonProcess)).not.toContainEqual(expect.objectContaining({ id: 'parent:1' }));
  });

  it('notifies exit listeners when the active daemon process closes', async () => {
    const daemonProcess = new FakeDaemonProcess(160);
    const { runtime } = createRuntime([daemonProcess]);
    const onExit = vi.fn();
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });
    supervisor.onExit?.(onExit);

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    (daemonProcess.stderr as unknown as PassThrough).write('daemon failed while running job\n');
    daemonProcess.emitClose(1, null);
    await flushMicrotasks();

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'failed',
        generation: 1,
        lastError: 'daemon failed while running job',
        lastExit: expect.objectContaining({ code: 1, signal: null }),
      }),
    );
  });

  it('sends daemon KB job abort requests over the control protocol', async () => {
    const daemonProcess = new FakeDaemonProcess(161);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const abort = supervisor.abortKbJobs?.(['kb-job-1']);
    await flushMicrotasks();
    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('kb.abort');
    expect(request.params).toEqual({ jobIds: ['kb-job-1'] });
    writeResponse(daemonProcess, request.id, { aborted: ['kb-job-1'], notFound: [] });

    await expect(abort).resolves.toEqual({ aborted: ['kb-job-1'], notFound: [] });
  });

  it('lists active daemon KB jobs over the control protocol', async () => {
    const daemonProcess = new FakeDaemonProcess(162);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const list = supervisor.listActiveKbJobs?.();
    await flushMicrotasks();
    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('kb.jobs');
    expect(request.params).toBeUndefined();
    writeResponse(daemonProcess, request.id, { active: ['kb-job-1', 'kb-job-2'] });

    await expect(list).resolves.toEqual({ active: ['kb-job-1', 'kb-job-2'] });
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
    expect(request.params).toEqual({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
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

  it('waits for an in-flight start before retrying read-only KB requests', async () => {
    const daemonProcess = new FakeDaemonProcess(173);
    const { runtime, spawnCalls } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
    await flushMicrotasks();
    expect(spawnCalls).toHaveLength(1);

    writeReady(daemonProcess);
    await start;
    await flushMicrotasks(12);

    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('kb.read');
    expect(request.params).toEqual({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
    writeResponse(daemonProcess, request.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'started-daemon' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'started-daemon' },
    });
    expect(spawnCalls).toHaveLength(1);
  });

  it('restarts and retries read-only KB requests after a request timeout', async () => {
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

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
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
    expect(secondRequest.params).toEqual({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
    writeResponse(second, secondRequest.id, {
      ok: true,
      data: { slug: 'alpha-note', source: 'timeout-recovered-daemon' },
    });

    await expect(read).resolves.toEqual({
      ok: true,
      data: { slug: 'alpha-note', source: 'timeout-recovered-daemon' },
    });
    expect(supervisor.read()).toMatchObject({ phase: 'online', generation: 2, pid: 175, pendingRequests: 0 });
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
    const daemonProcess = new FakeDaemonProcess(176);
    const { runtime, time } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      requestTimeoutMs: 25,
      jobRequestTimeoutMs: 100,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    let settled = false;
    const mutation = supervisor
      .mutateKb({
        method: 'createSource',
        args: { filePath: '/workspace/project-a/source.md', async: false },
        ctx: daemonCtx(),
      })
      .finally(() => {
        settled = true;
      });
    await flushMicrotasks();
    expect(latestRequest(daemonProcess).method).toBe('kb.mutate');

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
    const first = new FakeDaemonProcess(176);
    const second = new FakeDaemonProcess(177);
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

    const read = supervisor.readKb({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });
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
      detail: { reason: 'kb_daemon_unavailable' },
    });
    await dispose;
    expect(spawnCalls).toHaveLength(1);
    expect(supervisor.read()).toMatchObject({ phase: 'stopped', generation: 1, pendingRequests: 0 });
  });

  it('keeps read recovery disabled when dispose is queued behind a restart', async () => {
    const first = new FakeDaemonProcess(178);
    const second = new FakeDaemonProcess(179);
    const third = new FakeDaemonProcess(180);
    const { runtime, spawnCalls } = createRuntime([first, second, third]);
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

    await expect(
      supervisor.readKb({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
    });
    expect(spawnCalls).toHaveLength(2);
  });

  it('warms the daemon read runtime over the control protocol', async () => {
    const daemonProcess = new FakeDaemonProcess(158);
    const { runtime } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const warmup = supervisor.warmup();
    await flushMicrotasks();
    const request = latestRequest(daemonProcess);
    expect(request.method).toBe('kb.warmup');
    writeResponse(daemonProcess, request.id, { phase: 'ready', initializedAt: 1_000_200 });

    await expect(warmup).resolves.toMatchObject({
      phase: 'online',
      kbRead: { phase: 'ready', initializedAt: 1_000_200 },
      pendingRequests: 0,
    });
  });

  it('times out an unanswered daemon health probe and clears the pending request', async () => {
    const daemonProcess = new FakeDaemonProcess(161);
    const { runtime, time } = createRuntime([daemonProcess]);
    const supervisor = createKbDaemonSupervisor({
      runtime,
      pluginRoot: '/plugin',
      entrypoint: '/plugin/bridge/coral-backend.cjs',
      command: '/node',
      requestTimeoutMs: 25,
    });

    const start = supervisor.start();
    await flushMicrotasks();
    writeReady(daemonProcess);
    await start;

    const probe = supervisor.probe();
    await flushMicrotasks();
    expect(latestRequest(daemonProcess).method).toBe('health');
    expect(supervisor.read()).toMatchObject({ pendingRequests: 1 });

    time.tick(25);
    await flushMicrotasks();

    await expect(probe).resolves.toMatchObject({
      phase: 'online',
      pendingRequests: 0,
      lastError: 'health probe failed: KB daemon request timed out after 25ms',
    });
  });

  it('restarts by asking the current daemon to shut down before spawning the next generation', async () => {
    const first = new FakeDaemonProcess(201);
    const second = new FakeDaemonProcess(202);
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

describe('createDisabledKbDaemonSupervisor', () => {
  it('reports a terminal disabled snapshot from read/start/probe', async () => {
    const supervisor = createDisabledKbDaemonSupervisor('disabled (CORAL_KB_ENABLE=0)');

    expect(supervisor.read()).toMatchObject({
      enabled: false,
      phase: 'disabled',
      generation: 0,
      pid: null,
      reason: 'disabled (CORAL_KB_ENABLE=0)',
    });
    await expect(supervisor.start()).resolves.toMatchObject({ phase: 'disabled', enabled: false });
    await expect(supervisor.probe()).resolves.toMatchObject({ phase: 'disabled' });
  });

  it('returns a kb_disabled envelope for reads, mutations, and expansion RPC without spawning', async () => {
    const supervisor = createDisabledKbDaemonSupervisor();

    await expect(supervisor.readKb({ method: 'readNote', args: {} } as never)).resolves.toMatchObject({
      ok: false,
      code: 'kb_disabled',
      detail: { reason: 'kb_daemon_disabled' },
    });
    await expect(supervisor.mutateKb({ method: 'createNote', args: {} } as never)).resolves.toMatchObject({
      ok: false,
      code: 'kb_disabled',
    });
    await expect(supervisor.expansionRpc({ method: 'listExpansion', args: {} } as never)).resolves.toMatchObject({
      ok: false,
      code: 'kb_disabled',
    });
  });

  it('reports every requested job as not found on abort and disposes cleanly', async () => {
    const supervisor = createDisabledKbDaemonSupervisor();

    await expect(supervisor.abortKbJobs?.(['jb-1', 'jb-2'])).resolves.toEqual({
      aborted: [],
      notFound: ['jb-1', 'jb-2'],
    });
    await expect(supervisor.dispose()).resolves.toBeUndefined();
  });
});
