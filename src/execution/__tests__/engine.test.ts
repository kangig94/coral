import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EngineModule = typeof import('../engine.js');

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_SESSIONS;

function restoreEnv(name: 'CORAL_MAX_SESSIONS', value: string | undefined): void {
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
    engine = await loadEngine();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_SESSIONS', ORIGINAL_MAX_CHILDREN);
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
