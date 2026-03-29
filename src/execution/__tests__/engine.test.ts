import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EngineModule = typeof import('../engine.js');

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_SESSIONS;
const ORIGINAL_DISCUSS_MAX_CHILDREN = process.env.CORAL_DISCUSS_MAX_SESSIONS;

function restoreEnv(name: 'CORAL_MAX_SESSIONS' | 'CORAL_DISCUSS_MAX_SESSIONS', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadEngine(): Promise<EngineModule> {
  vi.resetModules();
  return import('../engine.js');
}

describe('engine admission queue', () => {
  let engine: EngineModule;

  beforeEach(async () => {
    process.env.CORAL_MAX_SESSIONS = '1';
    process.env.CORAL_DISCUSS_MAX_SESSIONS = '1';
    engine = await loadEngine();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_SESSIONS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_SESSIONS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns an immediate permit when capacity is available', () => {
    expect(engine.MAX_ACTIVE_SESSIONS).toBe(1);
    expect(engine.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    expect(engine.queueDepth()).toBe(0);
    expect(engine.queuePosition('job-1')).toBeNull();
  });

  it('returns a queued handle with the current queue position when capacity is full', () => {
    expect(engine.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });

    const queued = engine.requestLaunch('job-2', 'codex');

    expect(queued).not.toBe('queue_full');
    expect(queued).toMatchObject({
      type: 'queued',
      queuePosition: 1,
    });
    expect(engine.queueDepth()).toBe(1);
    expect(engine.queuePosition('job-2')).toBe(1);
  });

  it('tracks default and discuss pool admission independently', async () => {
    expect(engine.MAX_ACTIVE_SESSIONS).toBe(1);
    expect(engine.DISCUSS_MAX_ACTIVE_SESSIONS).toBe(1);
    expect(engine.requestLaunch('default-1', 'codex')).toEqual({ type: 'immediate' });
    expect(engine.requestLaunch('discuss-1', 'codex', 'discuss')).toEqual({ type: 'immediate' });

    const queuedDefault = engine.requestLaunch('default-2', 'codex');
    const queuedDiscuss = engine.requestLaunch('discuss-2', 'codex', 'discuss');

    expect(queuedDefault).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(queuedDiscuss).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(engine.getActiveJobIds()).toEqual(['default-1']);
    expect(engine.getActiveJobIds('discuss')).toEqual(['discuss-1']);
    expect(engine.queueDepth()).toBe(1);
    expect(engine.queueDepth('discuss')).toBe(1);

    if (queuedDefault === 'queue_full' || queuedDefault.type !== 'queued') throw new Error('expected queued default job');
    if (queuedDiscuss === 'queue_full' || queuedDiscuss.type !== 'queued') throw new Error('expected queued discuss job');

    const defaultPermit = queuedDefault.waitForPermit();
    const discussPermit = queuedDiscuss.waitForPermit();

    engine.releaseLaunch('default-1');
    await defaultPermit;
    expect(engine.queueDepth()).toBe(0);
    expect(engine.queueDepth('discuss')).toBe(1);
    expect(engine.queuePosition('discuss-2', 'discuss')).toBe(1);

    engine.releaseLaunch('discuss-1', 'discuss');
    await discussPermit;
    expect(engine.queueDepth('discuss')).toBe(0);
    expect(engine.getActiveJobIds()).toEqual(['default-2']);
    expect(engine.getActiveJobIds('discuss')).toEqual(['discuss-2']);
  });

  it('consumes signal-bound permits from the stored pool', async () => {
    expect(engine.requestLaunch('default-1', 'codex')).toEqual({ type: 'immediate' });
    expect(engine.requestLaunch('discuss-1', 'codex', 'discuss')).toEqual({ type: 'immediate' });

    const controller = new AbortController();
    engine.bindLaunchPermit('discuss-1', controller.signal, 'discuss');

    await expect(engine.spawnCli({
      provider: 'codex',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      signal: controller.signal,
    })).resolves.toMatchObject({
      code: 0,
      aborted: false,
    });

    engine.releaseLaunch('default-1');
    engine.releaseLaunch('discuss-1', 'discuss');
  });

  it('returns queue_full when the internal queue limit (20) is reached', async () => {
    expect(engine.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });

    // Fill queue to capacity (internal limit is 20)
    const handles: Array<{ waitForPermit: () => Promise<void> }> = [];
    for (let i = 2; i <= 21; i += 1) {
      const result = engine.requestLaunch(`job-${i}`, 'codex');
      expect(result).toMatchObject({ type: 'queued' });
      if (result !== 'queue_full' && result.type === 'queued') {
        void result.waitForPermit().catch(() => null);
        handles.push(result);
      }
    }
    expect(engine.queueDepth()).toBe(20);

    // 22nd should be rejected
    expect(engine.requestLaunch('job-22', 'codex')).toBe('queue_full');

    // Cleanup
    engine.killAllChildren();
  });

  it('admits queued jobs in strict FIFO order when a launch is released', async () => {
    expect(engine.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    const queuedSecond = engine.requestLaunch('job-2', 'codex');
    const queuedThird = engine.requestLaunch('job-3', 'codex');

    expect(queuedSecond).not.toBe('queue_full');
    expect(queuedThird).not.toBe('queue_full');
    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    let thirdGranted = false;
    const secondPermit = queuedSecond.waitForPermit();
    const thirdPermit = queuedThird.waitForPermit().then(() => {
      thirdGranted = true;
    });

    engine.releaseLaunch('job-1');
    await secondPermit;
    await Promise.resolve();

    expect(thirdGranted).toBe(false);
    expect(engine.queueDepth()).toBe(1);
    expect(engine.queuePosition('job-2')).toBeNull();
    expect(engine.queuePosition('job-3')).toBe(1);

    engine.releaseLaunch('job-2');
    await thirdPermit;
    expect(thirdGranted).toBe(true);
    expect(engine.queueDepth()).toBe(0);
    expect(engine.queuePosition('job-3')).toBeNull();
  });

  it('cancelQueued removes the entry, rejects its permit wait, and advances the queue head', async () => {
    expect(engine.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    const queuedSecond = engine.requestLaunch('job-2', 'codex');
    const queuedThird = engine.requestLaunch('job-3', 'codex');

    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    const rejected = queuedSecond.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(engine.cancelQueued('job-2')).toBe(true);
    expect((await rejected)?.message).toBe('Launch canceled while queued');
    expect(engine.queueDepth()).toBe(1);
    expect(engine.queuePosition('job-2')).toBeNull();
    expect(engine.queuePosition('job-3')).toBe(1);

    const thirdPermit = queuedThird.waitForPermit();
    engine.releaseLaunch('job-1');
    await thirdPermit;
    expect(engine.queuePosition('job-3')).toBeNull();
  });

  it('tracks queue depth and queue positions across admission changes', () => {
    expect(engine.queueDepth()).toBe(0);
    expect(engine.queuePosition('missing')).toBeNull();

    expect(engine.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    expect(engine.queueDepth()).toBe(0);

    const queuedSecond = engine.requestLaunch('job-2', 'codex');
    expect(queuedSecond).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(engine.queueDepth()).toBe(1);
    expect(engine.queuePosition('job-2')).toBe(1);

    const queuedThird = engine.requestLaunch('job-3', 'codex');
    expect(queuedThird).toMatchObject({ type: 'queued', queuePosition: 2 });
    expect(engine.queueDepth()).toBe(2);
    expect(engine.queuePosition('job-3')).toBe(2);

    if (queuedSecond !== 'queue_full' && queuedSecond.type === 'queued') {
      void queuedSecond.waitForPermit().catch(() => null);
    }
    if (queuedThird !== 'queue_full' && queuedThird.type === 'queued') {
      void queuedThird.waitForPermit().catch(() => null);
    }

    expect(engine.cancelQueued('job-2')).toBe(true);
    expect(engine.queueDepth()).toBe(1);
    expect(engine.queuePosition('job-3')).toBe(1);

    engine.releaseLaunch('job-1');
    expect(engine.queueDepth()).toBe(0);
    expect(engine.queuePosition('job-3')).toBeNull();
  });

  it('killAllChildren drains the queued launch list and rejects every queued promise', async () => {
    expect(engine.requestLaunch('job-1', 'codex')).toEqual({ type: 'immediate' });
    const queuedSecond = engine.requestLaunch('job-2', 'codex');
    const queuedThird = engine.requestLaunch('job-3', 'codex');

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

    engine.killAllChildren();

    expect((await secondRejected)?.message).toBe('Launch canceled while queue was drained');
    expect((await thirdRejected)?.message).toBe('Launch canceled while queue was drained');
    expect(engine.queueDepth()).toBe(0);
    expect(engine.queuePosition('job-2')).toBeNull();
    expect(engine.queuePosition('job-3')).toBeNull();
  });
});

describe('recovery helpers', () => {
  let engine: EngineModule;

  beforeEach(async () => {
    process.env.CORAL_MAX_SESSIONS = '2';
    process.env.CORAL_DISCUSS_MAX_SESSIONS = '2';
    engine = await loadEngine();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_SESSIONS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_SESSIONS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('restoreActiveLaunch inserts directly into active map', () => {
    engine.restoreActiveLaunch('job-1', 'codex', 'default');
    expect(engine.getActiveJobIds('default')).toContain('job-1');
    engine.releaseLaunch('job-1', 'default'); // cleanup
  });

  it('restoreActiveLaunch works for discuss pool', () => {
    engine.restoreActiveLaunch('discuss-job-1', 'codex', 'discuss');
    expect(engine.getActiveJobIds('discuss')).toContain('discuss-job-1');
    engine.releaseLaunch('discuss-job-1', 'discuss'); // cleanup
  });

  it('restoreActiveLaunch counts toward capacity', () => {
    // MAX_ACTIVE_SESSIONS = 2 for this test suite
    engine.restoreActiveLaunch('restored-1', 'codex', 'default');
    engine.restoreActiveLaunch('restored-2', 'codex', 'default');

    // Third launch should be queued since capacity is 2
    const result = engine.requestLaunch('job-3', 'codex', 'default');
    expect(result).toMatchObject({ type: 'queued' });

    // Cleanup
    if (result !== 'queue_full' && result.type === 'queued') {
      void result.waitForPermit().catch(() => null);
      result.cancel();
    }
    engine.releaseLaunch('restored-1', 'default');
    engine.releaseLaunch('restored-2', 'default');
  });

  it('restoreQueuedLaunch creates a queued handle', async () => {
    // Fill capacity
    engine.restoreActiveLaunch('fill-1', 'codex', 'default');
    engine.restoreActiveLaunch('fill-2', 'codex', 'default');

    const handle = engine.restoreQueuedLaunch('queued-1', 'codex', 'default');
    expect(handle.type).toBe('queued');
    expect(engine.queueDepth('default')).toBe(1);
    expect(engine.queuePosition('queued-1', 'default')).toBe(1);

    // Catch the rejection before canceling to avoid unhandled rejection
    const rejected = handle.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );
    handle.cancel();
    expect((await rejected)?.message).toBe('Launch canceled while queued');

    engine.releaseLaunch('fill-1', 'default');
    engine.releaseLaunch('fill-2', 'default');
  });

  it('restoreQueuedLaunch entries are admitted in order on release', async () => {
    engine.restoreActiveLaunch('fill-1', 'codex', 'default');
    engine.restoreActiveLaunch('fill-2', 'codex', 'default');

    const handleA = engine.restoreQueuedLaunch('queued-a', 'codex', 'default');
    const handleB = engine.restoreQueuedLaunch('queued-b', 'codex', 'default');
    expect(engine.queueDepth('default')).toBe(2);

    let bGranted = false;
    const permitA = handleA.waitForPermit();
    const permitB = handleB.waitForPermit().then(() => { bGranted = true; });

    // Release one slot — first queued entry should be admitted
    engine.releaseLaunch('fill-1', 'default');
    await permitA;
    expect(engine.getActiveJobIds('default')).toContain('queued-a');
    expect(bGranted).toBe(false);

    // Release another slot — second queued entry should be admitted
    engine.releaseLaunch('fill-2', 'default');
    await permitB;
    expect(bGranted).toBe(true);
    expect(engine.getActiveJobIds('default')).toContain('queued-b');

    // Cleanup
    engine.releaseLaunch('queued-a', 'default');
    engine.releaseLaunch('queued-b', 'default');
  });
});

describe('spawnDurableJob', () => {
  let engine: EngineModule;
  let tmpRoot: string;

  beforeEach(async () => {
    process.env.CORAL_MAX_SESSIONS = '1';
    process.env.CORAL_DISCUSS_MAX_SESSIONS = '1';
    engine = await loadEngine();
    tmpRoot = mkdtempSync(join(tmpdir(), 'coral-engine-durable-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    restoreEnv('CORAL_MAX_SESSIONS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_SESSIONS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('streams progress from stdout and persists runtime and exit artifacts', async () => {
    const jobDir = join(tmpRoot, 'job-1');
    mkdirSync(jobDir, { recursive: true });
    const onEvent = vi.fn();

    const result = await engine.spawnDurableJob({
      provider: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          "process.stdout.write('{\"step\":\"one\"}\\n');",
          "setTimeout(() => process.stdout.write('{\"step\":\"two\"}\\n'), 25);",
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

    const run = engine.spawnDurableJob({
      provider: 'codex',
      command: process.execPath,
      args: [
        '-e',
        [
          "process.stdout.write('{\"step\":\"start\"}\\n');",
          "setInterval(() => process.stdout.write('{\"step\":\"tick\"}\\n'), 20);",
        ].join(''),
      ],
      jobDir,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 75);

    const result = await run;

    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout).toContain('{"step":"start"}');
    const exitRecord = JSON.parse(readFileSync(join(jobDir, 'exit.json'), 'utf-8')) as { signal: string | null };
    expect(exitRecord.signal).toBe('SIGTERM');
  });
});
