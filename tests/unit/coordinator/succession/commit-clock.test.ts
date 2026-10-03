import { describe, expect, it, vi } from 'vitest';
import { LaunchCoordinator, SUCCESSION_PAUSE_ATTEMPT_MS } from '#src/coordinator/live/admission.js';
import { createCommitWindowAdmission } from '#src/coordinator/succession/commit/window-admission.js';
import { createCommitPause } from '#src/coordinator/succession/commit/pause.js';
import { createCommitReadiness } from '#src/coordinator/succession/commit/readiness.js';
import { createCommitReclaim } from '#src/coordinator/succession/commit/reclaim.js';
import type { SuccessionAttempt } from '#src/coordinator/succession/attempt-child.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import { createCommitWriterPreparation } from '#src/coordinator/succession/commit/writer-preparation.js';
import type {
  CommitState,
  FailedCommit,
  IncumbentWriterPorts,
  SuccessionCommitPorts,
  reclaimIncumbentWriter,
} from '#src/coordinator/succession/commit/index.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { tmpdir } from 'node:os';
import type { Runtime } from '#src/runtime/ports.js';

function fixture() {
  const time = new VirtualTime();
  let offset = 0;
  Object.assign(time, { now: () => Number(time.monotonicNow()) + offset });
  const runtime = { time, ids: {} } as unknown as Runtime;
  const launch = new LaunchCoordinator({ runtime });
  const state = { attemptAbort: new AbortController() } as CommitState;
  const kbPark = vi.fn(async () => {});
  const preparation = createCommitWriterPreparation(
    { runtime, kbDaemon: { parkWriterTurn: kbPark } } as unknown as SuccessionCommitPorts,
    state,
  );
  return {
    time,
    launch,
    state,
    preparation,
    kbPark,
    jump: (ms: number) => {
      offset += ms;
    },
  };
}

function heldWriter() {
  let signal: AbortSignal | undefined;
  const writers = {
    parkProviderOperationMutations: (owned: AbortSignal) => {
      signal = owned;
      return new Promise<void>((_, reject) => {
        owned.throwIfAborted();
        owned.addEventListener(
          'abort',
          () => reject(owned.reason instanceof Error ? owned.reason : new Error('park aborted')),
          { once: true },
        );
      });
    },
  } as IncumbentWriterPorts;
  return { writers, signal: () => signal };
}

describe('succession commit clock', () => {
  it.each([0, -3_600_000, 3_600_000])('bounds writer park after a wall step of %s ms', async (step) => {
    const f = fixture();
    const pause = f.launch.beginSuccessionCommitWindow('attempt', 0);
    expect(pause.kind).toBe('paused');
    const deadline = Number(f.time.monotonicNow()) + SUCCESSION_PAUSE_ATTEMPT_MS - 2_500;
    f.launch.beginSuccessionWriterPark('attempt');
    f.time.tick(500);
    f.jump(step);
    const held = heldWriter();
    const parking = f.preparation.parkIncumbentWriters(held.writers, deadline);
    const rejected = expect(parking).rejects.toThrow('Writer park exceeded');
    f.time.tick(2_001);
    await flushMicrotasks();
    expect(held.signal()?.aborted).toBe(true);
    await rejected;
    expect(f.kbPark).not.toHaveBeenCalled();
    expect(f.launch.admitTopLevelLaunch()).toBe(false);
    f.launch.endSuccessionCommitWindow('attempt');
    expect(f.launch.admitTopLevelLaunch()).toBe(true);
  });

  it('interrupts a held park when shutdown aborts the attempt', async () => {
    const f = fixture();
    f.launch.beginSuccessionCommitWindow('attempt', 0);
    f.launch.beginSuccessionWriterPark('attempt');
    const held = heldWriter();
    const parking = f.preparation.parkIncumbentWriters(held.writers, Number(f.time.monotonicNow()) + 2_500);
    const rejected = expect(parking).rejects.toThrow('shutdown');
    f.state.attemptAbort.abort(new Error('shutdown'));
    await flushMicrotasks();
    expect(held.signal()?.aborted).toBe(true);
    await rejected;
    expect(f.launch.admitTopLevelLaunch()).toBe(false);
    f.launch.endSuccessionCommitWindow('attempt');
    expect(f.launch.admitTopLevelLaunch()).toBe(true);
  });

  it('completes both parks inside the budget', async () => {
    const f = fixture();
    const providerPark = vi.fn(async () => {});
    await f.preparation.parkIncumbentWriters(
      { parkProviderOperationMutations: providerPark } as unknown as IncumbentWriterPorts,
      Number(f.time.monotonicNow()) + 2_500,
    );
    expect(providerPark).toHaveBeenCalledOnce();
    expect(f.kbPark).toHaveBeenCalledOnce();
  });
});

it('captures one admission budget before deadline transmission and recertification', async () => {
  const f = fixture();
  const attempt = {
    attemptId: 'attempt',
    setDeadline: vi.fn(async () => {
      f.time.tick(500);
      f.jump(-3_600_000);
    }),
    forwardConnections: () => () => {},
  } as unknown as SuccessionAttempt;
  const state = { ...f.state, pausedAttemptId: null } as CommitState;
  const ports = {
    runtime: { time: f.time, paths: { coral: { coordinator: { runDir: '/unused' } } } },
    launchCoordinator: f.launch,
    listener: () => ({}),
    waitHandover: { abort: vi.fn() },
    reconciler: () => ({ recertify: () => new Promise(() => {}) }),
  } as unknown as SuccessionCommitPorts;
  const pause = createCommitPause(ports, state);
  const readiness = createCommitReadiness(ports);
  const admission = createCommitWindowAdmission(ports, state, {
    ...pause,
    recertifyObligations: readiness.recertifyObligations,
    updateAttempt: vi.fn(),
    writersOrThrow: vi.fn(),
    ...f.preparation,
  });
  const admittedAt = Number(f.time.monotonicNow());
  const window = await admission.openCommitWindow(attempt, { admissionRevision: 0 } as SuccessionPreparation, null);
  expect(window.pauseDeadlineMonotonicMs).toBe(admittedAt + 5_000);
  expect(window.deadlineMonotonicMs).toBe(admittedAt + 2_500);
  expect(attempt.setDeadline).toHaveBeenCalledWith(admittedAt + 2_500, 2_500);
  const held = heldWriter();
  const parking = f.preparation.parkIncumbentWriters(held.writers, window.deadlineMonotonicMs);
  const rejected = expect(parking).rejects.toThrow('Writer park exceeded');
  f.time.tick(1_999);
  expect(held.signal()?.aborted).toBe(false);
  f.time.tick(1);
  await rejected;
  f.jump(-3_600_000);
  const recertifying = readiness.recertifyObligations('attempt', window.deadlineMonotonicMs);
  const recertificationFailed = expect(recertifying).rejects.toThrow('not re-certified before the deadline');
  f.time.tick(1);
  await recertificationFailed;
  pause.closePause();
});

it.each(['reclaimed', 'same-build-succession'] as const)(
  'retains expired admission until writer reclaim is %s',
  async (kind) => {
    const f = fixture();
    const pause = f.launch.beginSuccessionCommitWindow('attempt', 0);
    if (pause.kind !== 'paused') throw new Error('expected admission');
    f.launch.beginSuccessionWriterPark('attempt');
    f.time.tick(3_000);
    f.jump(-3_600_000);
    const adopted = vi.fn();
    const closePause = vi.fn(() => f.launch.endSuccessionCommitWindow('attempt'));
    let complete!: (value: unknown) => void;
    const reclaim = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const owner = createCommitReclaim(
      {
        runtime: {
          ...createRealRuntime('prod', { baseDir: tmpdir() }),
          time: f.time,
          storage: {
            readFileSync: () => {
              throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            },
          },
        },
        incumbent: { build: null, instanceId: 'incumbent' },
        storeDb: () => ({}),
        providerHosts: { reclaimTransferred: vi.fn() },
        setLaunchFenceActive: vi.fn(),
        log: vi.fn(),
        reconciler: () => ({ notifyObligationChange: vi.fn() }),
      } as unknown as SuccessionCommitPorts,
      {
        closePause,
        clearAttempt: vi.fn(async () => ({ kind: 'settled' }) as never),
        writersOrThrow: () => ({ adoptProviderOperationAdmission: adopted }) as unknown as IncumbentWriterPorts,
        childHoldBlockers: () => [],
        reclaimIncumbentWriter: reclaim as unknown as typeof reclaimIncumbentWriter,
      },
    );
    const failure = {
      preparation: { attemptId: 'attempt', epochKey: 'epoch' },
      writer: { generation: { generation: 1 } },
      pauseDeadlineMonotonicMs: pause.deadlineMonotonicMs,
      retry: { kind: 'target-change' },
      unservedMintDiscard: null,
    } as unknown as FailedCommit;
    const reclaiming = owner.reclaimInPlace(failure, false);
    await flushMicrotasks();
    expect(reclaim).toHaveBeenCalledWith(expect.objectContaining({ deadlineMs: 2_000 }));
    f.time.tick(2_001);
    expect(f.launch.admitTopLevelLaunch()).toBe(false);
    expect(closePause).not.toHaveBeenCalled();
    complete({ kind, generation: {}, providerOperationAdmission: {} });
    await reclaiming;
    expect(adopted).toHaveBeenCalledTimes(kind === 'reclaimed' ? 1 : 0);
    expect(f.launch.admitTopLevelLaunch()).toBe(kind === 'reclaimed');
  },
);
