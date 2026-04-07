import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EngineMod from '../engine.js';

type EngineModule = typeof EngineMod;

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_WORKERS;
const ORIGINAL_DISCUSS_MAX_CHILDREN = process.env.CORAL_DISCUSS_MAX_WORKERS;

function restoreEnv(name: 'CORAL_MAX_WORKERS' | 'CORAL_DISCUSS_MAX_WORKERS', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadEngine(): Promise<EngineModule> {
  vi.resetModules();
  return import('../engine.js');
}

function createProviderServerScript(): string {
  return [
    "const { createInterface } = require('node:readline');",
    'const rl = createInterface({ input: process.stdin });',
    "rl.on('line', (line) => {",
    '  const msg = JSON.parse(line);',
    "  if (typeof msg.id === 'number' && msg.method === 'ping') {",
    "    process.stdout.write(JSON.stringify({ id: msg.id, result: { pong: msg.params?.value ?? null } }) + '\\n');",
    '    return;',
    '  }',
    "  if (msg.method === 'notify-back') {",
    "    process.stdout.write(JSON.stringify({ method: 'tick', params: msg.params ?? {} }) + '\\n');",
    '    return;',
    '  }',
    "  if (typeof msg.id === 'number' && msg.method === 'hang') {",
    '    return;',
    '  }',
    "  if (typeof msg.id === 'number') {",
    "    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'unknown method' } }) + '\\n');",
    '  }',
    '});',
    "process.on('SIGTERM', () => process.exit(0));",
  ].join('');
}

async function waitForValue<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe('engine admission queue', () => {
  let engine: EngineModule;
  let coordinator: InstanceType<EngineModule['LaunchCoordinator']>;

  beforeEach(async () => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    engine = await loadEngine();
    coordinator = new engine.LaunchCoordinator();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns an immediate permit when capacity is available', () => {
    expect(engine.MAX_WORKERS).toBe(1);
    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('job-1')).toBeNull();
  });

  it('returns a queued handle with the current queue position when capacity is full', () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });

    const queued = coordinator.requestLaunch('job-2', 'codex');

    expect(queued).not.toBe('queue_full');
    expect(queued).toMatchObject({
      type: 'queued',
      queuePosition: 1,
    });
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-2')).toBe(1);
  });

  it('tracks default and discuss pool admission independently', async () => {
    expect(engine.MAX_WORKERS).toBe(1);
    expect(engine.DISCUSS_MAX_WORKERS).toBe(1);
    expect(coordinator.requestLaunch('default-1', 'codex')).toEqual({ type: 'immediate' });
    expect(coordinator.requestLaunch('discuss-1', 'codex', 'discuss')).toEqual({ type: 'immediate' });

    const queuedDefault = coordinator.requestLaunch('default-2', 'codex');
    const queuedDiscuss = coordinator.requestLaunch('discuss-2', 'codex', 'discuss');

    expect(queuedDefault).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(queuedDiscuss).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(coordinator.getActiveJobIds()).toEqual(['default-1']);
    expect(coordinator.getActiveJobIds('discuss')).toEqual(['discuss-1']);
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queueDepth('discuss')).toBe(1);

    if (queuedDefault === 'queue_full' || queuedDefault.type !== 'queued')
      throw new Error('expected queued default job');
    if (queuedDiscuss === 'queue_full' || queuedDiscuss.type !== 'queued')
      throw new Error('expected queued discuss job');

    const defaultPermit = queuedDefault.waitForPermit();
    const discussPermit = queuedDiscuss.waitForPermit();

    coordinator.releaseLaunch('default-1');
    await defaultPermit;
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queueDepth('discuss')).toBe(1);
    expect(coordinator.queuePosition('discuss-2', 'discuss')).toBe(1);

    coordinator.releaseLaunch('discuss-1', 'discuss');
    await discussPermit;
    expect(coordinator.queueDepth('discuss')).toBe(0);
    expect(coordinator.getActiveJobIds()).toEqual(['default-2']);
    expect(coordinator.getActiveJobIds('discuss')).toEqual(['discuss-2']);
  });

  it('consumes signal-bound permits from the stored pool', async () => {
    expect(coordinator.requestLaunch('default-1', 'codex')).toEqual({ type: 'immediate' });
    expect(coordinator.requestLaunch('discuss-1', 'codex', 'discuss')).toEqual({ type: 'immediate' });

    const controller = new AbortController();
    coordinator.bindLaunchPermit('discuss-1', controller.signal, 'discuss');

    await expect(
      coordinator.spawnCli({
        provider: 'codex',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      code: 0,
      aborted: false,
    });

    coordinator.releaseLaunch('default-1');
    coordinator.releaseLaunch('discuss-1', 'discuss');
  });

  it('returns queue_full when the internal queue limit (20) is reached', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });

    // Fill queue to capacity (internal limit is 20)
    const handles: Array<{ waitForPermit: () => Promise<void> }> = [];
    for (let i = 2; i <= 21; i += 1) {
      const result = coordinator.requestLaunch(`job-${i}`, 'codex');
      expect(result).toMatchObject({ type: 'queued' });
      if (result !== 'queue_full' && result.type === 'queued') {
        void result.waitForPermit().catch(() => null);
        handles.push(result);
      }
    }
    expect(coordinator.queueDepth()).toBe(20);

    // 22nd should be rejected
    expect(coordinator.requestLaunch('job-22', 'codex')).toBe('queue_full');

    // Cleanup
    coordinator.terminateAll();
  });

  it('admits queued jobs in strict FIFO order when a launch is released', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex');
    const queuedThird = coordinator.requestLaunch('job-3', 'codex');

    expect(queuedSecond).not.toBe('queue_full');
    expect(queuedThird).not.toBe('queue_full');
    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    let thirdGranted = false;
    const secondPermit = queuedSecond.waitForPermit();
    const thirdPermit = queuedThird.waitForPermit().then(() => {
      thirdGranted = true;
    });

    coordinator.releaseLaunch('job-1');
    await secondPermit;
    await Promise.resolve();

    expect(thirdGranted).toBe(false);
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-2')).toBeNull();
    expect(coordinator.queuePosition('job-3')).toBe(1);

    coordinator.releaseLaunch('job-2');
    await thirdPermit;
    expect(thirdGranted).toBe(true);
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('job-3')).toBeNull();
  });

  it('cancelQueued removes the entry, rejects its permit wait, and advances the queue head', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex');
    const queuedThird = coordinator.requestLaunch('job-3', 'codex');

    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    const rejected = queuedSecond.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(coordinator.cancelQueued('job-2')).toBe(true);
    expect((await rejected)?.message).toBe('Launch canceled while queued');
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-2')).toBeNull();
    expect(coordinator.queuePosition('job-3')).toBe(1);

    const thirdPermit = queuedThird.waitForPermit();
    coordinator.releaseLaunch('job-1');
    await thirdPermit;
    expect(coordinator.queuePosition('job-3')).toBeNull();
  });

  it('tracks queue depth and queue positions across admission changes', () => {
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('missing')).toBeNull();

    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    expect(coordinator.queueDepth()).toBe(0);

    const queuedSecond = coordinator.requestLaunch('job-2', 'codex');
    expect(queuedSecond).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-2')).toBe(1);

    const queuedThird = coordinator.requestLaunch('job-3', 'codex');
    expect(queuedThird).toMatchObject({ type: 'queued', queuePosition: 2 });
    expect(coordinator.queueDepth()).toBe(2);
    expect(coordinator.queuePosition('job-3')).toBe(2);

    if (queuedSecond !== 'queue_full' && queuedSecond.type === 'queued') {
      void queuedSecond.waitForPermit().catch(() => null);
    }
    if (queuedThird !== 'queue_full' && queuedThird.type === 'queued') {
      void queuedThird.waitForPermit().catch(() => null);
    }

    expect(coordinator.cancelQueued('job-2')).toBe(true);
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-3')).toBe(1);

    coordinator.releaseLaunch('job-1');
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('job-3')).toBeNull();
  });

  it('terminateAll drains the queued launch list and rejects every queued promise', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex');
    const queuedThird = coordinator.requestLaunch('job-3', 'codex');

    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    const secondRejected = queuedSecond.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );
    const thirdRejected = queuedThird.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );

    coordinator.terminateAll();

    expect((await secondRejected)?.message).toBe('Launch canceled while queue was drained');
    expect((await thirdRejected)?.message).toBe('Launch canceled while queue was drained');
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('job-2')).toBeNull();
    expect(coordinator.queuePosition('job-3')).toBeNull();
  });
});

describe('recovery helpers', () => {
  let engine: EngineModule;
  let coordinator: InstanceType<EngineModule['LaunchCoordinator']>;

  beforeEach(async () => {
    process.env.CORAL_MAX_WORKERS = '2';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '2';
    engine = await loadEngine();
    coordinator = new engine.LaunchCoordinator();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('active sums all pool active maps', () => {
    expect(coordinator.active).toBe(0);

    coordinator.restoreActiveLaunch('default-1', 'codex', 'default');
    coordinator.restoreActiveLaunch('discuss-1', 'codex', 'discuss');
    coordinator.restoreActiveLaunch('curate-1', 'codex', 'curate');
    expect(coordinator.active).toBe(3);

    coordinator.releaseLaunch('default-1', 'default');
    expect(coordinator.active).toBe(2);

    coordinator.releaseLaunch('discuss-1', 'discuss');
    coordinator.releaseLaunch('curate-1', 'curate');
    expect(coordinator.active).toBe(0);
  });

  it('restoreActiveLaunch inserts directly into active map', () => {
    coordinator.restoreActiveLaunch('job-1', 'codex', 'default');
    expect(coordinator.getActiveJobIds('default')).toContain('job-1');
    coordinator.releaseLaunch('job-1', 'default'); // cleanup
  });

  it('restoreActiveLaunch works for discuss pool', () => {
    coordinator.restoreActiveLaunch('discuss-job-1', 'codex', 'discuss');
    expect(coordinator.getActiveJobIds('discuss')).toContain('discuss-job-1');
    coordinator.releaseLaunch('discuss-job-1', 'discuss'); // cleanup
  });

  it('restoreActiveLaunch counts toward capacity', () => {
    // MAX_WORKERS = 2 for this test suite
    coordinator.restoreActiveLaunch('restored-1', 'codex', 'default');
    coordinator.restoreActiveLaunch('restored-2', 'codex', 'default');

    // Third launch should be queued since capacity is 2
    const result = coordinator.requestLaunch('job-3', 'codex', 'default');
    expect(result).toMatchObject({ type: 'queued' });

    // Cleanup
    if (result !== 'queue_full' && result.type === 'queued') {
      void result.waitForPermit().catch(() => null);
      result.cancel();
    }
    coordinator.releaseLaunch('restored-1', 'default');
    coordinator.releaseLaunch('restored-2', 'default');
  });

  it('restoreQueuedLaunch creates a queued handle', async () => {
    // Fill capacity
    coordinator.restoreActiveLaunch('fill-1', 'codex', 'default');
    coordinator.restoreActiveLaunch('fill-2', 'codex', 'default');

    const handle = coordinator.restoreQueuedLaunch('queued-1', 'codex', 'default');
    expect(handle.type).toBe('queued');
    expect(coordinator.queueDepth('default')).toBe(1);
    expect(coordinator.queuePosition('queued-1', 'default')).toBe(1);

    // Catch the rejection before canceling to avoid unhandled rejection
    const rejected = handle.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );
    handle.cancel();
    expect((await rejected)?.message).toBe('Launch canceled while queued');

    coordinator.releaseLaunch('fill-1', 'default');
    coordinator.releaseLaunch('fill-2', 'default');
  });

  it('restoreQueuedLaunch entries are admitted in order on release', async () => {
    coordinator.restoreActiveLaunch('fill-1', 'codex', 'default');
    coordinator.restoreActiveLaunch('fill-2', 'codex', 'default');

    const handleA = coordinator.restoreQueuedLaunch('queued-a', 'codex', 'default');
    const handleB = coordinator.restoreQueuedLaunch('queued-b', 'codex', 'default');
    expect(coordinator.queueDepth('default')).toBe(2);

    let bGranted = false;
    const permitA = handleA.waitForPermit();
    const permitB = handleB.waitForPermit().then(() => {
      bGranted = true;
    });

    // Release one slot — first queued entry should be admitted
    coordinator.releaseLaunch('fill-1', 'default');
    await permitA;
    expect(coordinator.getActiveJobIds('default')).toContain('queued-a');
    expect(bGranted).toBe(false);

    // Release another slot — second queued entry should be admitted
    coordinator.releaseLaunch('fill-2', 'default');
    await permitB;
    expect(bGranted).toBe(true);
    expect(coordinator.getActiveJobIds('default')).toContain('queued-b');

    // Cleanup
    coordinator.releaseLaunch('queued-a', 'default');
    coordinator.releaseLaunch('queued-b', 'default');
  });
});

describe('spawnDurableJob', () => {
  let engine: EngineModule;
  let coordinator: InstanceType<EngineModule['LaunchCoordinator']>;
  let tmpRoot: string;

  beforeEach(async () => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    engine = await loadEngine();
    coordinator = new engine.LaunchCoordinator();
    tmpRoot = mkdtempSync(join(tmpdir(), 'coral-engine-durable-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('streams progress from stdout and persists runtime and exit artifacts', async () => {
    const jobDir = join(tmpRoot, 'job-1');
    mkdirSync(jobDir, { recursive: true });
    const onEvent = vi.fn();

    const result = await coordinator.spawnDurableJob({
      provider: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdout.write(\'{"step":"one"}\\n\');',
          'setTimeout(() => process.stdout.write(\'{"step":"two"}\\n\'), 25);',
          "setTimeout(() => process.stderr.write('warn\\n'), 35);",
          'setTimeout(() => process.exit(0), 50);',
        ].join(''),
      ],
      jobDir,
      onEvent,
    });

    expect(result).toMatchObject({
      code: 0,
      aborted: false,
    });
    expect(result.stdout).toContain('{"step":"one"}');
    expect(result.stdout).toContain('{"step":"two"}');
    expect(result.stderr).toContain('warn');
    expect(onEvent).toHaveBeenCalledWith('{"step":"one"}');
    expect(onEvent).toHaveBeenCalledWith('{"step":"two"}');
    expect(existsSync(join(jobDir, 'runtime.json'))).toBe(true);
    expect(existsSync(join(jobDir, 'exit.json'))).toBe(true);

    const runtimeRecord = JSON.parse(readFileSync(join(jobDir, 'runtime.json'), 'utf-8')) as { tailWatermark?: number };
    expect(runtimeRecord.tailWatermark).toBeGreaterThan(0);
  });

  it('terminates the durable child when aborted', async () => {
    const jobDir = join(tmpRoot, 'job-2');
    mkdirSync(jobDir, { recursive: true });
    const controller = new AbortController();

    const run = coordinator.spawnDurableJob({
      provider: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdout.write(\'{"step":"start"}\\n\');',
          'setInterval(() => process.stdout.write(\'{"step":"tick"}\\n\'), 20);',
        ].join(''),
      ],
      jobDir,
      signal: controller.signal,
      onEvent: (line: string) => {
        if (line.includes('"start"')) controller.abort();
      },
    });

    const result = await run;

    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout).toContain('{"step":"start"}');
    const exitRecord = JSON.parse(readFileSync(join(jobDir, 'exit.json'), 'utf-8')) as { signal: string | null };
    expect(exitRecord.signal).toBe('SIGTERM');
  });
});

describe('provider servers', () => {
  let engine: EngineModule;
  let coordinator: InstanceType<EngineModule['LaunchCoordinator']>;

  beforeEach(async () => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    engine = await loadEngine();
    coordinator = new engine.LaunchCoordinator();
  });

  afterEach(() => {
    coordinator.terminateAll();
    restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('spawns a provider server with JSON-RPC transport and a stable generation id', async () => {
    const handle = await coordinator.spawnProviderServer({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', createProviderServerScript()],
    });

    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.generation).toBe(1);

    const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const unsubscribe = handle.onNotification((message: { method: string; params?: Record<string, unknown> }) => {
      notifications.push(message);
    });

    await expect(handle.rpc.request('ping', { value: 'pong' })).resolves.toEqual({ pong: 'pong' });
    handle.rpc.notify('notify-back', { ready: true });

    expect(await waitForValue(() => notifications[0] ?? null)).toEqual({
      method: 'tick',
      params: { ready: true },
    });

    unsubscribe();
    await handle.close();
  });

  it('markExpectedClose treats broker exits as expected without tearing down the transport first', async () => {
    const handle = await coordinator.spawnProviderServer({
      provider: 'claude',
      command: process.execPath,
      args: ['-e', createProviderServerScript()],
    });

    handle.markExpectedClose();
    handle.child.kill('SIGTERM');

    await expect(handle.closePromise).resolves.toBeUndefined();
  });

  it('sends initializeRequest before returning the handle when configured', async () => {
    const script = [
      "const { createInterface } = require('node:readline');",
      'let initialized = false;',
      'const rl = createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  const msg = JSON.parse(line);',
      "  if (typeof msg.id === 'number' && msg.method === 'initialize') {",
      '    initialized = true;',
      "    process.stdout.write(JSON.stringify({ id: msg.id, result: { ready: true } }) + '\\n');",
      '    return;',
      '  }',
      "  if (typeof msg.id === 'number' && msg.method === 'ping') {",
      "    process.stdout.write(JSON.stringify({ id: msg.id, result: { initialized } }) + '\\n');",
      '    return;',
      '  }',
      '});',
      "process.on('SIGTERM', () => process.exit(0));",
    ].join('');

    const handle = await coordinator.spawnProviderServer({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', script],
      initializeRequest: {
        method: 'initialize',
        params: { clientInfo: { name: 'test', version: '0.0.1' } },
      },
    });

    // By the time we get the handle, initialize has already been sent
    await expect(handle.rpc.request('ping', {})).resolves.toEqual({ initialized: true });
    await handle.close();
  });

  it('terminateAll leaves provider servers to the host manager', async () => {
    const handle = await coordinator.spawnProviderServer({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', createProviderServerScript()],
    });

    coordinator.terminateAll();

    await expect(handle.rpc.request('ping', { value: 'still-live' })).resolves.toEqual({
      pong: 'still-live',
    });
    await handle.close();
  });
});
