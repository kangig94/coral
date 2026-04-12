import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDurableCliRuntime } from '../../shared/types.js';
import { createReplayCursor } from '../progress-store.js';
import { SessionManager } from '../session-manager.js';
import { createSimulationBackend, type SimulationBackend } from './simulation-runtime.js';

class MockRequest extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;

  constructor(method: string, url: string, token: string) {
    super();
    this.method = method;
    this.url = url;
    this.headers = {
      'x-coral-backend-token': token,
    };
  }

  resume(): void {}

  destroy(): void {}
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly headers = new Map<string, string | number | string[]>();
  body = '';

  setHeader(name: string, value: string | number | string[]): void {
    this.headers.set(name, value);
  }

  writeHead(statusCode: number): void {
    this.statusCode = statusCode;
    this.headersSent = true;
  }

  write(chunk: string | Buffer): boolean {
    this.headersSent = true;
    this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.headersSent = true;
    this.writableEnded = true;
    this.emit('finish');
    this.emit('close');
    return this;
  }
}

async function advanceUntil(
  world: SimulationBackend,
  predicate: () => boolean,
  options: { stepMs: number; maxSteps: number; label: string },
): Promise<void> {
  for (let step = 0; step < options.maxSteps; step += 1) {
    if (predicate()) {
      return;
    }
    await world.advance(options.stepMs);
  }

  throw new Error(`Timed out waiting for ${options.label}`);
}

async function invokeHandler(
  world: SimulationBackend,
  request: {
    method: string;
    url: string;
    token: string;
  },
): Promise<{ statusCode: number; body: string }> {
  const handler = world.hooks.createServerCalls[0];
  if (!handler) {
    throw new Error('Expected simulation backend to capture the HTTP handler');
  }

  const req = new MockRequest(request.method, request.url, request.token);
  const res = new MockResponse();
  await handler(req as never, res as never);
  return { statusCode: res.statusCode, body: res.body };
}

describe('deterministic simulation lifecycle replay', () => {
  const worlds: SimulationBackend[] = [];

  afterEach(async () => {
    while (worlds.length > 0) {
      const world = worlds.pop();
      if (!world) {
        continue;
      }
      await world.backend.shutdown('test-cleanup');
      await world.backend.waitForShutdown();
    }
    vi.restoreAllMocks();
  });

  it('replays a complete in-process lifecycle with deterministic aborts, idle shutdown, runtime-backed request helpers, and clean reset state', async () => {
    const wallStart = performance.now();
    const realProcessKillSpy = vi.spyOn(process, 'kill');
    const realFetchSpy = vi.spyOn(globalThis, 'fetch');

    const completedWorld = createSimulationBackend({
      listen: { port: 4_301 },
      env: { CORAL_BACKEND_IDLE_MS: '1' },
      durable: [
        {
          pid: 30_101,
          runtimeDelayMs: 5,
          stdout: [{ delayMs: 20, data: 'durable-progress\n' }],
          stderr: [{ delayMs: 20, data: 'durable-warning\n' }],
          exit: { delayMs: 25, exitCode: 0 },
        },
      ],
      fakeProvider: {
        progress: [
          { delayMs: 5, message: 'provider-progress-1' },
          { delayMs: 5, message: 'provider-progress-2' },
        ],
        result: { content: 'final simulation result' },
      },
    });
    worlds.push(completedWorld);

    const completedPhases: Array<{ previousPhase: string; phase: string }> = [];
    const completedProgressMessages: string[] = [];
    completedWorld.eventBus.on('job:phase_changed', (payload) => {
      completedPhases.push({
        previousPhase: payload.previousPhase,
        phase: payload.phase,
      });
    });
    completedWorld.eventBus.on('job:progress', (payload) => {
      completedProgressMessages.push(payload.message);
    });

    const started = await completedWorld.backend.start();
    expect(started.port).toBe(4_301);
    expect(completedWorld.backend.server.listening).toBe(false);
    expect(completedWorld.hooks.listenCalls).toEqual([{ host: '127.0.0.1', port: 4_301 }]);

    const detailProjectRoot = '/tmp/sim/request-source';
    completedWorld.storage.mkdirSync(detailProjectRoot, { recursive: true });
    expect(
      completedWorld.storage
        .snapshot()
        .projectSourceCache.some(([path]) => path === detailProjectRoot),
    ).toBe(false);

    const detailResponse = await invokeHandler(completedWorld, {
      method: 'GET',
      url: `/discuss/sessions/missing?projectRoot=${encodeURIComponent(detailProjectRoot)}`,
      token: started.token,
    });
    expect(detailResponse.statusCode).toBe(404);
    expect(detailResponse.body).toBe(JSON.stringify({ error: 'session_not_found' }));
    expect(
      completedWorld.storage
        .snapshot()
        .projectSourceCache.some(([path]) => path === detailProjectRoot),
    ).toBe(true);

    const completedDecision = await completedWorld.service.start(
      'fake-provider',
      { prompt: 'simulate complete lifecycle' },
      completedWorld.createCallerContext(),
    );
    expect(completedDecision.status).toBe('running');
    if (completedDecision.status !== 'running') {
      throw new Error('Expected completed job launch to start immediately');
    }

    expect(completedWorld.progressStore.readStatus(completedDecision.job)).toMatchObject({
      jobId: completedDecision.job,
      sessionId: completedDecision.session,
      provider: 'fake-provider',
      phase: 'launching',
      launch: { state: 'pending' },
    });

    await advanceUntil(
      completedWorld,
      () => completedWorld.progressStore.readStatus(completedDecision.job)?.phase === 'running',
      { stepMs: 5, maxSteps: 5, label: 'completed job to enter running phase' },
    );
    expect(completedWorld.progressStore.readStatus(completedDecision.job)?.phase).toBe('running');

    await advanceUntil(
      completedWorld,
      () => completedWorld.progressStore.hasRuntimeRecord(completedDecision.job),
      { stepMs: 5, maxSteps: 5, label: 'completed job runtime record' },
    );

    const completedRuntime = completedWorld.progressStore.readRuntimeRecord(completedDecision.job);
    expect(isDurableCliRuntime(completedRuntime)).toBe(true);
    if (!isDurableCliRuntime(completedRuntime)) {
      throw new Error('Expected completed job to persist a durable runtime record');
    }
    expect(completedRuntime.pid).toBe(30_101);

    await advanceUntil(
      completedWorld,
      () => completedWorld.progressStore.readStatus(completedDecision.job)?.phase === 'completed',
      { stepMs: 500, maxSteps: 4, label: 'completed job terminal result' },
    );

    const completedStatus = completedWorld.progressStore.readStatus(completedDecision.job);
    expect(completedStatus).toMatchObject({
      phase: 'completed',
      launch: { state: 'ready' },
      result: {
        content: 'final simulation result',
        aborted: false,
      },
    });
    expect(completedWorld.progressStore.hasExitRecord(completedDecision.job)).toBe(true);
    expect(
      completedWorld.storage.readFileSync(completedWorld.progressStore.resultPath(completedDecision.job), 'utf-8'),
    ).toBe('final simulation result');
    expect(completedWorld.storage.readFileSync(completedRuntime.stdoutPath, 'utf-8')).toBe('durable-progress\n');
    expect(completedWorld.storage.readFileSync(completedRuntime.stderrPath, 'utf-8')).toBe('durable-warning\n');
    expect(fs.existsSync(completedWorld.progressStore.jobDir(completedDecision.job))).toBe(false);
    expect(fs.existsSync(completedWorld.progressStore.resultPath(completedDecision.job))).toBe(false);

    const completedReplay = completedWorld.progressStore.replayFrom(completedDecision.job, 0, createReplayCursor());
    expect(completedReplay.map((event) => event.type)).toEqual(['progress', 'progress', 'terminal']);
    expect(completedReplay[0]?.message).toContain('provider-progress-1');
    expect(completedReplay[1]?.message).toContain('provider-progress-2');
    expect(completedProgressMessages).toHaveLength(2);
    expect(completedProgressMessages[0]).toContain('provider-progress-1');
    expect(completedProgressMessages[1]).toContain('provider-progress-2');
    expect(completedPhases).toEqual([
      { previousPhase: 'launching', phase: 'running' },
      { previousPhase: 'running', phase: 'completed' },
    ]);

    expect(completedWorld.backend.getLifecycle()).toBe('running');
    await completedWorld.advance(60_000);
    await completedWorld.backend.waitForShutdown();
    expect(completedWorld.backend.getLifecycle()).toBe('stopped');
    expect(
      completedWorld.storage.existsSync(completedWorld.storage.backendInfoPath(completedWorld.pluginRoot)),
    ).toBe(false);
    expect(fs.existsSync(completedWorld.storage.backendInfoPath(completedWorld.pluginRoot))).toBe(false);

    const abortedWorld = createSimulationBackend({
      listen: { port: 4_302 },
      durable: [
        {
          pid: 30_202,
          runtimeDelayMs: 5,
          stdout: [{ delayMs: 20, data: 'abort-progress\n' }],
          exit: null,
          kills: [{ signal: 'SIGTERM', delayMs: 25, exitSignal: 'SIGTERM' }],
        },
      ],
      fakeProvider: {
        progress: [{ delayMs: 5, message: 'provider-progress' }],
      },
    });
    worlds.push(abortedWorld);

    await abortedWorld.backend.start();
    const abortedDecision = await abortedWorld.service.start(
      'fake-provider',
      { prompt: 'simulate abort lifecycle' },
      abortedWorld.createCallerContext(),
    );
    expect(abortedDecision.status).toBe('running');
    if (abortedDecision.status !== 'running') {
      throw new Error('Expected aborted job launch to start immediately');
    }

    await advanceUntil(
      abortedWorld,
      () => abortedWorld.progressStore.hasRuntimeRecord(abortedDecision.job),
      { stepMs: 5, maxSteps: 5, label: 'aborted job runtime record' },
    );

    const abortedRuntime = abortedWorld.progressStore.readRuntimeRecord(abortedDecision.job);
    expect(isDurableCliRuntime(abortedRuntime)).toBe(true);
    if (!isDurableCliRuntime(abortedRuntime)) {
      throw new Error('Expected aborted job to persist a durable runtime record');
    }

    expect(abortedWorld.runtime.process.isAlive(abortedRuntime.pid)).toBe(true);
    expect(abortedWorld.service.abort([abortedDecision.job])).toEqual({
      aborted: [abortedDecision.job],
      notFound: [],
    });
    expect(abortedWorld.spawner.killCalls).toContainEqual({ pid: abortedRuntime.pid, signal: 'SIGTERM' });
    expect(abortedWorld.runtime.process.isAlive(abortedRuntime.pid)).toBe(true);

    await abortedWorld.advance(25);
    expect(abortedWorld.runtime.process.isAlive(abortedRuntime.pid)).toBe(false);

    await advanceUntil(
      abortedWorld,
      () => abortedWorld.progressStore.readStatus(abortedDecision.job)?.phase === 'aborted',
      { stepMs: 500, maxSteps: 4, label: 'aborted job terminal result' },
    );

    expect(abortedWorld.progressStore.readStatus(abortedDecision.job)).toMatchObject({
      phase: 'aborted',
      result: {
        aborted: true,
      },
    });

    await abortedWorld.backend.shutdown('abort-verified');
    await abortedWorld.backend.waitForShutdown();
    expect(abortedWorld.backend.getLifecycle()).toBe('stopped');

    const resetWorld = createSimulationBackend({
      listen: { port: 4_303 },
      durable: [
        {
          pid: 30_303,
          runtimeDelayMs: 5,
          exit: { delayMs: 5, exitCode: 0 },
        },
      ],
      fakeProvider: {
        result: { content: 'reset world result' },
      },
    });
    worlds.push(resetWorld);

    const resetSessions = new SessionManager(resetWorld.projectRoot, resetWorld.runtime);
    expect(resetWorld.progressStore.listJobIds()).toEqual([]);
    expect(resetSessions.list('fake-provider')).toEqual([]);
    expect(resetSessions.get('fake-provider', completedDecision.session)).toBeNull();

    await resetWorld.backend.start();
    const resetDecision = await resetWorld.service.start(
      'fake-provider',
      { prompt: 'simulate clean reset world' },
      resetWorld.createCallerContext(),
    );
    expect(resetDecision).toMatchObject({
      status: 'running',
      session: completedDecision.session,
      job: completedDecision.job,
    });

    expect(realProcessKillSpy).not.toHaveBeenCalled();
    expect(realFetchSpy).not.toHaveBeenCalled();
    expect(performance.now() - wallStart).toBeLessThan(1_000);
  });
});
