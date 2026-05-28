import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KB_ID } from '#src/coordinator/subsystems/contract.js';
import { createKbSubsystem, type CreateKbSubsystemDeps } from '#src/coordinator/subsystems/kb.js';
import type { KnowledgeBaseRuntime } from '#src/kb/subsystem.js';

const { buildKbRuntimeMock } = vi.hoisted(() => ({ buildKbRuntimeMock: vi.fn() }));

vi.mock('#src/kb/subsystem.js', () => ({
  createKbSubsystem: (...args: unknown[]) => buildKbRuntimeMock(...args),
}));

function fakeRuntime(): KnowledgeBaseRuntime {
  return {
    kb: {} as KnowledgeBaseRuntime['kb'],
    readDb: {} as KnowledgeBaseRuntime['readDb'],
    curateScheduler: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn(),
      scheduleDeferredCommit: vi.fn(),
      isRunning: vi.fn().mockReturnValue(false),
    } as unknown as KnowledgeBaseRuntime['curateScheduler'],
  };
}

function fakeDeps(overrides: Partial<CreateKbSubsystemDeps> = {}): CreateKbSubsystemDeps {
  return {
    db: {} as CreateKbSubsystemDeps['db'],
    paths: { markdownRoot: '/tmp/kb', runtimeDir: '/tmp/kb-runtime' },
    curateAssistant: {
      complete: async () => {
        throw new Error('curateAssistant not mocked');
      },
    } as CreateKbSubsystemDeps['curateAssistant'],
    processPort: {} as CreateKbSubsystemDeps['processPort'],
    storagePort: {} as CreateKbSubsystemDeps['storagePort'],
    envPort: {} as CreateKbSubsystemDeps['envPort'],
    timePort: {
      now: () => 0,
      setTimeout: () => ({}) as never,
      clearTimeout: () => {},
    } as unknown as CreateKbSubsystemDeps['timePort'],
    idsPort: { uuid: () => 'fake-uuid' } as CreateKbSubsystemDeps['idsPort'],
    time: {
      sleep: vi.fn().mockResolvedValue(undefined),
    },
    curateBridge: {
      attach: vi.fn(),
      detach: vi.fn(),
      onCorpusPublishFailure: vi.fn(),
      onCorpusPublishSuccess: vi.fn(),
    },
    runBootSequence: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createKbSubsystem (AC2)', () => {
  beforeEach(() => {
    buildKbRuntimeMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('transitions initializing(attempt=1) → online on first-attempt success', async () => {
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(fakeDeps());
    const phases: string[] = [];
    const attempts: number[] = [];
    sub.onStatusChange((s) => {
      phases.push(s.phase);
      if (s.phase === 'initializing') attempts.push(s.attempt);
    });

    const ctrl = new AbortController();
    await sub.init(ctrl.signal);

    expect(phases).toEqual(['initializing', 'online']);
    expect(attempts).toEqual([1]);
    expect(sub.status.phase).toBe('online');
  });

  it('retries runBootSequence and succeeds on attempt 2', async () => {
    const runtime = fakeRuntime();
    const runBootSequence = vi
      .fn()
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    buildKbRuntimeMock.mockResolvedValueOnce(runtime);
    const sub = createKbSubsystem(fakeDeps({ runBootSequence, time: { sleep } }));
    const attempts: number[] = [];
    sub.onStatusChange((s) => {
      if (s.phase === 'initializing') attempts.push(s.attempt);
    });

    const ctrl = new AbortController();
    await sub.init(ctrl.signal);

    expect(runBootSequence).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual([1, 2]);
    expect(sleep).toHaveBeenCalledWith(1_000, { signal: ctrl.signal });
    expect(sub.status.phase).toBe('online');
  });

  it('transitions offline with reason and last log line after all 4 attempts fail', async () => {
    const errors = [
      new Error('attempt one failed'),
      new Error('attempt two failed'),
      new Error('attempt three failed'),
      new Error('final attempt failed'),
    ];
    const runBootSequence = vi.fn();
    for (const error of errors) {
      runBootSequence.mockRejectedValueOnce(error);
    }
    const sleep = vi.fn().mockResolvedValue(undefined);
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(fakeDeps({ runBootSequence, time: { sleep } }));

    await sub.init(new AbortController().signal);

    expect(runBootSequence).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 4_000, 16_000]);
    expect(sub.status).toMatchObject({
      id: KB_ID,
      phase: 'offline',
      reason: 'final attempt failed',
    });
    expect(sub.status.phase === 'offline' ? sub.status.lastLogLine : undefined).toContain(
      '[subsystem:kb] init attempt 4/4 failed: final attempt failed',
    );
  });

  it('exposes runtime via resource() once online', async () => {
    const runtime = fakeRuntime();
    buildKbRuntimeMock.mockResolvedValueOnce(runtime);
    const sub = createKbSubsystem(fakeDeps());

    const ctrl = new AbortController();
    await sub.init(ctrl.signal);

    expect(sub.resource()).toBe(runtime);
  });

  it('throws SubsystemUnavailableError from resource() while initializing', () => {
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(fakeDeps());
    expect(() => sub.resource()).toThrow(/kb initializing/);
  });

  it('aborts before attempt-1 when signal is already aborted', async () => {
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(fakeDeps());
    const ctrl = new AbortController();
    ctrl.abort();

    await sub.init(ctrl.signal);

    expect(sub.status.phase).toBe('offline');
    expect(sub.status).toMatchObject({ phase: 'offline', reason: 'shutdown' });
  });

  it('emits phase changes via onStatusChange and unsubscribes cleanly', async () => {
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(fakeDeps());
    const observed: string[] = [];
    const unsub = sub.onStatusChange((s) => observed.push(s.phase));

    const ctrl = new AbortController();
    await sub.init(ctrl.signal);
    unsub();

    expect(observed).toContain('initializing');
    expect(observed).toContain('online');
  });

  it('transitions to offline on dispose() after online', async () => {
    const detach = vi.fn();
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(
      fakeDeps({
        curateBridge: {
          attach: vi.fn(),
          detach,
          onCorpusPublishFailure: vi.fn(),
          onCorpusPublishSuccess: vi.fn(),
        },
      }),
    );

    const ctrl = new AbortController();
    await sub.init(ctrl.signal);
    expect(sub.status.phase).toBe('online');

    await sub.dispose(ctrl.signal);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(sub.status).toMatchObject({ phase: 'offline', reason: 'disposed' });
  });

  it('maps curate bridge failures to degraded and self-heals on success', async () => {
    const attach = vi.fn();
    const detach = vi.fn();
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(
      fakeDeps({
        curateBridge: {
          attach,
          detach,
          onCorpusPublishFailure: vi.fn(),
          onCorpusPublishSuccess: vi.fn(),
        },
      }),
    );

    const ctrl = new AbortController();
    await sub.init(ctrl.signal);
    const transition = attach.mock.calls[0]?.[0] as ((reason: Parameters<typeof attach>[0]) => void) | undefined;
    expect(typeof transition).toBe('function');

    transition?.({ kind: 'curate-publish', consecutiveFailures: 3, lastError: 'publish queue full' });
    expect(sub.status).toEqual({
      id: KB_ID,
      phase: 'degraded',
      reason: { kind: 'curate-publish', consecutiveFailures: 3, lastError: 'publish queue full' },
    });

    transition?.(null);
    expect(sub.status).toEqual({ id: KB_ID, phase: 'online' });

    await sub.dispose(ctrl.signal);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('reports KB id consistently', () => {
    buildKbRuntimeMock.mockResolvedValueOnce(fakeRuntime());
    const sub = createKbSubsystem(fakeDeps());
    expect(sub.id).toBe(KB_ID);
    expect(sub.status.id).toBe(KB_ID);
  });
});
