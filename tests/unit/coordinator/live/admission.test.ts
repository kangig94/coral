import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_WORKERS;
const ORIGINAL_DISCUSS_MAX_CHILDREN = process.env.CORAL_DISCUSS_MAX_WORKERS;

function restoreEnv(name: 'CORAL_MAX_WORKERS' | 'CORAL_DISCUSS_MAX_WORKERS', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createCoordinator(): LaunchCoordinator {
  return new LaunchCoordinator({ runtime: createRealRuntime('prod') });
}

describe('launch admission', () => {
  let coordinator: LaunchCoordinator;

  beforeEach(() => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    coordinator = createCoordinator();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
  });

  it('returns an admitted outcome when capacity is available', () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toEqual({
      outcome: 'admitted',
      permit: { type: 'immediate' },
      type: 'immediate',
    });
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('job-1')).toBeNull();
  });

  it('returns a queued outcome with the current position when capacity is full', () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toMatchObject({ outcome: 'admitted' });

    const queued = coordinator.requestLaunch('job-2', 'codex');

    expect(queued).not.toBe('queue_full');
    expect(queued).toMatchObject({
      outcome: 'queued',
      position: 1,
      type: 'queued',
      queuePosition: 1,
    });
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-2')).toBe(1);
  });

  it('tracks default and discuss pools independently', async () => {
    expect(coordinator.requestLaunch('default-1', 'codex')).toMatchObject({ outcome: 'admitted' });
    expect(coordinator.requestLaunch('discuss-1', 'codex', 'discuss')).toMatchObject({ outcome: 'admitted' });

    const queuedDefault = coordinator.requestLaunch('default-2', 'codex');
    const queuedDiscuss = coordinator.requestLaunch('discuss-2', 'codex', 'discuss');

    expect(queuedDefault).toMatchObject({ outcome: 'queued', position: 1 });
    expect(queuedDiscuss).toMatchObject({ outcome: 'queued', position: 1 });

    if (queuedDefault === 'queue_full' || queuedDefault.outcome !== 'queued') throw new Error('expected queued default');
    if (queuedDiscuss === 'queue_full' || queuedDiscuss.outcome !== 'queued') throw new Error('expected queued discuss');

    const defaultPermit = queuedDefault.waitForPermit();
    const discussPermit = queuedDiscuss.waitForPermit();

    coordinator.releaseLaunch('default-1');
    await defaultPermit;
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queueDepth('discuss')).toBe(1);

    coordinator.releaseLaunch('discuss-1', 'discuss');
    await discussPermit;
    expect(coordinator.queueDepth('discuss')).toBe(0);
    expect(coordinator.getActiveJobIds()).toEqual(['default-2']);
    expect(coordinator.getActiveJobIds('discuss')).toEqual(['discuss-2']);
  });

  it('returns queue_full when the internal queue limit is reached', () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toMatchObject({ outcome: 'admitted' });

    for (let i = 2; i <= 21; i += 1) {
      const result = coordinator.requestLaunch(`job-${i}`, 'codex');
      expect(result).not.toBe('queue_full');
      if (result !== 'queue_full' && result.outcome === 'queued') {
        void result.waitForPermit().catch(() => null);
      }
    }

    expect(coordinator.queueDepth()).toBe(20);
    expect(coordinator.requestLaunch('job-22', 'codex')).toBe('queue_full');
    coordinator.terminateAll();
  });

  it('admits queued jobs in strict FIFO order when a launch is released', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toMatchObject({ outcome: 'admitted' });
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex');
    const queuedThird = coordinator.requestLaunch('job-3', 'codex');

    if (queuedSecond === 'queue_full' || queuedSecond.outcome !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.outcome !== 'queued') throw new Error('expected queued job-3');

    let thirdGranted = false;
    const secondPermit = queuedSecond.waitForPermit();
    const thirdPermit = queuedThird.waitForPermit().then(() => {
      thirdGranted = true;
    });

    coordinator.releaseLaunch('job-1');
    await secondPermit;
    await Promise.resolve();

    expect(thirdGranted).toBe(false);
    expect(coordinator.queuePosition('job-3')).toBe(1);

    coordinator.releaseLaunch('job-2');
    await thirdPermit;
    expect(thirdGranted).toBe(true);
    expect(coordinator.queueDepth()).toBe(0);
  });

  it('cancelQueued rejects the queued permit and advances the queue head', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex')).toMatchObject({ outcome: 'admitted' });
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex');
    const queuedThird = coordinator.requestLaunch('job-3', 'codex');

    if (queuedSecond === 'queue_full' || queuedSecond.outcome !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.outcome !== 'queued') throw new Error('expected queued job-3');

    const rejected = queuedSecond.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(coordinator.cancelQueued('job-2')).toBe(true);
    expect((await rejected)?.message).toBe('Launch canceled while queued');

    const thirdPermit = queuedThird.waitForPermit();
    coordinator.releaseLaunch('job-1');
    await thirdPermit;
    expect(coordinator.queuePosition('job-3')).toBeNull();
  });

  it('restores active and queued launches for recovery bookkeeping', async () => {
    coordinator.restoreActiveLaunch('default-1', 'codex', 'default');
    coordinator.restoreActiveLaunch('discuss-1', 'codex', 'discuss');
    expect(coordinator.active).toBe(2);

    const restored = coordinator.restoreQueuedLaunch('queued-1', 'codex', 'default');
    expect(restored).toMatchObject({ outcome: 'queued', position: 1 });
    expect(coordinator.queueDepth()).toBe(1);

    const permit = restored.waitForPermit();
    coordinator.releaseLaunch('default-1');
    await permit;
    expect(coordinator.getActiveJobIds('default')).toContain('queued-1');
  });
});
