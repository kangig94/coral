import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { isDurableCliRuntime } from '#src/runtime/durable-runtime.js';
import { runScenario, type StepResult } from '#tools/simulation/runner.js';
import type { SimulationDocument } from '#tools/simulation/scenario-schema.js';
import { SimulationWorld } from '#tools/simulation/adversarial.js';

type LaunchReceipt = {
  decision: { status: 'running' | 'queued' };
  jobId: string;
  sessionId: string;
};

const COMPLETE_DETAIL_PROJECT_ROOT = '/tmp/sim/request-source';

const COMPLETE_SCENARIO: SimulationDocument = {
  world: {
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
      result: { content: 'final simulation result', outcome: { kind: 'completed' } },
    },
  },
  steps: [
    { type: 'boot' },
    { type: 'launch', provider: 'fake-provider', prompt: 'simulate complete lifecycle' },
    { type: 'wait', until: { phase: 'running' }, stepMs: 5, maxSteps: 5 },
    { type: 'wait', until: { runtimeRecorded: true }, stepMs: 5, maxSteps: 5 },
    { type: 'wait', until: { terminal: true }, stepMs: 500, maxSteps: 4 },
    {
      type: 'expect',
      phase: 'completed',
      progress: 'provider-progress-2',
      result: { content: 'final simulation result', outcome: { kind: 'completed' } },
      runtimeRecorded: true,
      noRealIO: true,
    },
  ],
};

const ABORT_SCENARIO: SimulationDocument = {
  world: {
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
  },
  steps: [
    { type: 'boot' },
    { type: 'launch', provider: 'fake-provider', prompt: 'simulate abort lifecycle' },
    { type: 'wait', until: { runtimeRecorded: true }, stepMs: 5, maxSteps: 5 },
    { type: 'abort' },
  ],
};

const RESET_SCENARIO: SimulationDocument = {
  world: {
    listen: { port: 4_303 },
    durable: [
      {
        pid: 30_303,
        runtimeDelayMs: 5,
        exit: { delayMs: 5, exitCode: 0 },
      },
    ],
    fakeProvider: {
      result: { content: 'reset world result', outcome: { kind: 'completed' } },
    },
  },
  steps: [
    { type: 'boot' },
    { type: 'launch', provider: 'fake-provider', prompt: 'simulate clean reset world' },
    { type: 'cycle' },
    {
      type: 'expect',
      jobCount: 0,
      sessionCount: { provider: 'fake-provider', count: 0 },
    },
    { type: 'launch', provider: 'fake-provider', prompt: 'simulate clean reset world' },
    { type: 'wait', until: { terminal: true }, stepMs: 500, maxSteps: 4 },
    {
      type: 'expect',
      phase: 'completed',
      result: { content: 'reset world result', outcome: { kind: 'completed' } },
      noRealIO: true,
    },
  ],
};

const worlds: SimulationWorld[] = [];

function getLaunchReceipt(step: StepResult): LaunchReceipt {
  if (!step.detail || typeof step.detail !== 'object') {
    throw new Error('Expected launch step detail to be an object');
  }

  const detail = step.detail as Partial<LaunchReceipt>;
  if (
    !detail.decision ||
    (detail.decision.status !== 'running' && detail.decision.status !== 'queued') ||
    typeof detail.jobId !== 'string' ||
    typeof detail.sessionId !== 'string'
  ) {
    throw new Error('Expected launch step detail to contain a launch receipt');
  }

  return detail as LaunchReceipt;
}

function getDurableRuntime(world: SimulationWorld, jobId: string) {
  const runtime = world.readArtifact(jobId, 'runtime', { freshness: 'cached' });
  const candidate = runtime as Parameters<typeof isDurableCliRuntime>[0];
  if (!isDurableCliRuntime(candidate)) {
    throw new Error(`Expected a durable runtime record for ${jobId}`);
  }
  return candidate;
}

afterEach(async () => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    if (!world) {
      continue;
    }
    await world.teardown();
  }
});

describe('deterministic simulation lifecycle replay', () => {
  it('requires a booted world before launching, waiting, aborting, or killing jobs', async () => {
    const world = new SimulationWorld({});

    try {
      await expect(world.launchJob('launch before boot')).rejects.toThrow(
        'Simulation world must be booted before launch',
      );
      await expect(world.waitUntil('job-1', { terminal: true }, 5, { maxSteps: 1 })).rejects.toThrow(
        'Simulation world must be booted before wait',
      );
      await expect(world.abort('job-1')).rejects.toThrow('Simulation world must be booted before abort');
      await expect(world.kill({ pid: 123 })).rejects.toThrow('Simulation world must be booted before kill');
    } finally {
      world.dispose();
    }
  });

  it('replays a complete lifecycle with hooks, artifacts, ordering, idle cleanup, and zero real I/O', async () => {
    const wallStart = performance.now();
    const { result, world } = await runScenario(COMPLETE_SCENARIO);
    worlds.push(world);

    expect(result.passed).toBe(true);
    expect(result.steps[0]).toMatchObject({
      ok: true,
      detail: {
        info: {
          port: 4_301,
        },
      },
    });

    const launch = getLaunchReceipt(result.steps[1]);
    expect(result.steps[5]).toMatchObject({
      ok: true,
      actual: {
        jobId: launch.jobId,
        phase: 'completed',
        runtimeRecorded: true,
        result: {
          content: 'final simulation result',
          outcome: { kind: 'completed' },
        },
      },
    });

    expect(world.getHookLog().listenCalls).toEqual([{ host: '127.0.0.1', port: 4_301 }]);
    expect(world.hasProjectSourceCache(COMPLETE_DETAIL_PROJECT_ROOT)).toBe(false);

    const detailResponse = await world.invokeHttp(
      'GET',
      `/discuss/sessions/missing?projectRoot=${encodeURIComponent(COMPLETE_DETAIL_PROJECT_ROOT)}`,
    );
    expect(detailResponse).toMatchObject({
      statusCode: 404,
      body: JSON.stringify({ code: 'session_not_found', message: 'Session not found' }),
    });
    expect(world.hasProjectSourceCache(COMPLETE_DETAIL_PROJECT_ROOT)).toBe(true);

    const runtime = getDurableRuntime(world, launch.jobId);
    expect(runtime.pid).toBe(30_101);
    expect(world.getJobStatus(launch.jobId)).toMatchObject({
      jobId: launch.jobId,
      sessionId: launch.sessionId,
      provider: 'fake-provider',
      phase: 'completed',
      result: {
        content: 'final simulation result',
        outcome: { kind: 'completed' },
      },
    });
    expect(world.readArtifact(launch.jobId, 'exit', { freshness: 'cached' })).toMatchObject({
      exitCode: 0,
      signal: null,
    });
    expect(world.readArtifact(launch.jobId, 'result', { freshness: 'cached' })).toBe('final simulation result');
    expect(world.readArtifact(launch.jobId, 'stdout', { freshness: 'cached' })).toBe('durable-progress\n');
    expect(world.readArtifact(launch.jobId, 'stderr', { freshness: 'cached' })).toBe('durable-warning\n');

    const replay = world.replay(launch.jobId);
    expect(replay.map((event) => event.type)).toEqual(['progress', 'progress', 'terminal']);
    expect(replay[0]?.type === 'progress' ? replay[0].message : '').toContain('provider-progress-1');
    expect(replay[1]?.type === 'progress' ? replay[1].message : '').toContain('provider-progress-2');
    expect(world.getProgress(launch.jobId)).toHaveLength(2);
    expect(world.getProgress(launch.jobId)[0]).toContain('provider-progress-1');
    expect(world.getProgress(launch.jobId)[1]).toContain('provider-progress-2');
    expect(world.getPhaseTransitions(launch.jobId)).toEqual([
      { previousPhase: 'launching', phase: 'running' },
      { previousPhase: 'running', phase: 'completed' },
    ]);

    expect(world.getBackendLifecycle()).toBe('running');
    expect(world.backendInfoExists()).toBe(true);

    await world.advance(60_000);
    await world.waitForShutdown();

    expect(world.getBackendLifecycle()).toBe('stopped');
    expect(world.backendInfoExists()).toBe(false);
    expect(world.getNoRealIoReport()).toEqual({
      realKillCalls: 0,
      realFetchCalls: 0,
      violations: [],
    });
    expect(performance.now() - wallStart).toBeLessThan(1_000);
  });

  it('replays an abort lifecycle with kill log and PID liveness checks', async () => {
    const { result, world } = await runScenario(ABORT_SCENARIO);
    worlds.push(world);

    expect(result.passed).toBe(true);

    const launch = getLaunchReceipt(result.steps[1]);
    const runtime = getDurableRuntime(world, launch.jobId);
    expect(result.steps[2]).toMatchObject({
      ok: true,
      actual: {
        phase: 'running',
        runtimeRecorded: true,
      },
    });
    expect(result.steps[3]).toMatchObject({
      ok: true,
      actual: {
        jobId: launch.jobId,
      },
    });

    expect(world.isPidAlive(runtime.pid)).toBe(true);
    expect(world.getKillLog()).toContainEqual({ pid: runtime.pid, signal: 'SIGTERM' });

    await world.advance(25);

    expect(world.isPidAlive(runtime.pid)).toBe(false);
    const terminalWait = await world.waitUntil(launch.jobId, { terminal: true }, 500, { maxSteps: 4 });
    expect(terminalWait.ok).toBe(true);
    expect(world.getJobStatus(launch.jobId)).toMatchObject({
      phase: 'aborted',
      result: {
        outcome: { kind: 'aborted', reason: 'signal_abort' },
      },
    });

    await world.shutdown('abort-verified');
    await world.waitForShutdown();

    expect(world.getBackendLifecycle()).toBe('stopped');
    expect(world.getNoRealIoReport()).toEqual({
      realKillCalls: 0,
      realFetchCalls: 0,
      violations: [],
    });
  });

  it('recreates a fresh world on cycle, proves empty reset state, and relaunches with identical IDs', async () => {
    const { result, world } = await runScenario(RESET_SCENARIO);
    worlds.push(world);

    expect(result.passed).toBe(true);
    expect(result.steps[2]).toMatchObject({
      ok: true,
      detail: {
        generation: 1,
      },
    });
    expect(result.steps[3]).toMatchObject({
      ok: true,
      actual: {
        jobCount: 0,
        sessionCount: 0,
      },
    });

    const firstLaunch = getLaunchReceipt(result.steps[1]);
    const secondLaunch = getLaunchReceipt(result.steps[4]);

    expect(secondLaunch).toMatchObject({
      jobId: firstLaunch.jobId,
      sessionId: firstLaunch.sessionId,
      decision: { status: 'running' },
    });

    expect(world.listJobIds()).toEqual([secondLaunch.jobId]);
    expect(world.listSessions('fake-provider')).toHaveLength(1);
    expect(world.getJobStatus(secondLaunch.jobId)).toMatchObject({
      jobId: secondLaunch.jobId,
      sessionId: secondLaunch.sessionId,
      phase: 'completed',
      result: {
        content: 'reset world result',
        outcome: { kind: 'completed' },
      },
    });
    expect(world.getNoRealIoReport()).toEqual({
      realKillCalls: 0,
      realFetchCalls: 0,
      violations: [],
    });
  });

  it('tracks generation snapshots across repeated cycle() calls', async () => {
    const world = new SimulationWorld({
      listen: { port: 4_304 },
    });
    worlds.push(world);

    expect(world.generation()).toMatchObject({
      index: 0,
      startedInfo: null,
    });

    const initialInfo = await world.boot();
    const initialGeneration = world.generation();
    expect(initialGeneration).toMatchObject({
      index: 0,
      startedInfo: initialInfo,
    });

    const initialBackend = initialGeneration.backend;
    const cycledInfo = await world.cycle();
    const cycledGeneration = world.generation();
    expect(cycledGeneration).toMatchObject({
      index: 1,
      startedInfo: cycledInfo,
    });
    expect(cycledGeneration.backend).not.toBe(initialBackend);

    const cycledBackend = cycledGeneration.backend;
    const restartedInfo = await world.cycle();
    expect(world.generation()).toMatchObject({
      index: 2,
      startedInfo: restartedInfo,
    });
    expect(world.generation().backend).not.toBe(cycledBackend);
  });

  it('writes env.json and records runtime metadata through the Journal', async () => {
    const world = new SimulationWorld({
      env: {
        KEEP_BASE: 'base-value',
        CORAL_BACKEND_IDLE_MS: '1',
      },
      durable: [
        {
          pid: 30_404,
          runtimeDelayMs: 5,
          exit: { delayMs: 5, exitCode: 0 },
        },
      ],
      fakeProvider: {
        result: { content: 'env artifact result', outcome: { kind: 'completed' } },
      },
    });
    worlds.push(world);

    await world.boot();
    const launch = await world.launchJob('capture durable env', {
      coralEnv: {
        CORAL_OWNER: 'session-123',
        EXTRA_ENV: 'extra-value',
      },
    });

    expect(launch.status).toBe('running');
    if (launch.status !== 'running' && launch.status !== 'queued') {
      throw new Error(`Expected a launched job, received ${launch.status}`);
    }

    const runtimeWait = await world.waitUntil(launch.job, { runtimeRecorded: true }, 5, { maxSteps: 5 });
    expect(runtimeWait.ok).toBe(true);

    const runtime = getDurableRuntime(world, launch.job);
    const jobDir = dirname(runtime.stdoutPath);
    const generation = world.generation();
    const envPath = join(jobDir, 'env.json');
    const env = JSON.parse(generation.backend.runtime.storage.readFileSync(envPath, 'utf-8')) as Record<string, string>;

    expect(env).toMatchObject({
      KEEP_BASE: 'base-value',
      EXTRA_ENV: 'extra-value',
      CORAL_OWNER: 'session-123',
      CORAL_CHILD: '1',
    });
    expect(env).not.toHaveProperty('CORAL_BACKEND_IDLE_MS');
    expect(runtime).toMatchObject({
      pid: 30_404,
      stdoutPath: join(jobDir, 'stdout'),
      stderrPath: join(jobDir, 'stderr'),
    });
    expect(generation.backend.runtime.storage.existsSync(join(jobDir, 'runtime.json'))).toBe(false);
  });
});
