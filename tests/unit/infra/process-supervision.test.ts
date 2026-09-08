import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import type { ProcessIncarnation, ProcessLiveness } from '#src/infra/node-process.js';
import {
  cleanupSpawnedProcessGroup,
  gracefulKill,
  gracefulKillByPid,
  liveChildAuthority,
  retainSpawnedProcessGroupCleanup,
  signalOwnedProcessGroup,
} from '#src/infra/process-supervision.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  readonly killedSignals: NodeJS.Signals[] = [];
  transportClosed = false;
  private collected = false;
  private returnFalseOnSignal: NodeJS.Signals | null = null;
  private throwOnSignal: NodeJS.Signals | null = null;

  constructor(...args: [] | [number | undefined]) {
    super();
    this.pid = args.length === 0 ? 4_242 : args[0];
  }

  /** Models the "child is already gone" race `safeKill`'s try/catch exists to absorb. */
  throwOnNextKill(signal: NodeJS.Signals): void {
    this.throwOnSignal = signal;
  }

  returnFalseOnNextKill(signal: NodeJS.Signals): void {
    this.returnFalseOnSignal = signal;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal && this.throwOnSignal === signal) {
      this.throwOnSignal = null;
      throw new Error(`simulated kill(${signal}) failure`);
    }
    if (signal) this.killedSignals.push(signal);
    if (signal && this.returnFalseOnSignal === signal) {
      this.returnFalseOnSignal = null;
      return false;
    }
    return true;
  }

  emitClose(): void {
    if (!this.collected) this.emitExit(0, null);
    this.transportClosed = true;
    this.emit('close', null, null);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.collected = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function fakeRuntime(time: VirtualTime): Runtime {
  return { time } as unknown as Runtime;
}

describe('live child authority', () => {
  it('is unavailable before the child has a pid', () => {
    expect(liveChildAuthority(new FakeChild(undefined))).toBeUndefined();
  });

  it('tracks collection from the child exit fields before transport close', () => {
    const child = new FakeChild();
    const authority = liveChildAuthority(child);

    expect(authority).toBeDefined();
    expect(authority?.hasExited()).toBe(false);
    child.emitExit(null, 'SIGTERM');
    expect(authority?.hasExited()).toBe(true);
    expect(child.transportClosed).toBe(false);
    child.emitClose();
    expect(child.transportClosed).toBe(true);
    expect(authority?.hasExited()).toBe(true);
  });
});

describe('signalOwnedProcessGroup', () => {
  it('signals the group while the leader remains uncollected', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];

    expect(
      signalOwnedProcessGroup(
        new FakeChild(),
        (pid, signal) => {
          calls.push({ pid, signal });
          return true;
        },
        'SIGTERM',
      ),
    ).toBe('delivered');
    expect(calls).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
  });

  it('returns leader-collected without signaling after exit', () => {
    const child = new FakeChild();
    child.emitExit(0, null);
    const calls: number[] = [];

    expect(
      signalOwnedProcessGroup(
        child,
        (pid) => {
          calls.push(pid);
          return true;
        },
        'SIGKILL',
      ),
    ).toBe('leader-collected');
    expect(calls).toEqual([]);
  });

  it('preserves a refused group signal as not-delivered', () => {
    expect(signalOwnedProcessGroup(new FakeChild(), () => false, 'SIGTERM')).toBe('not-delivered');
  });
});

describe('gracefulKill', () => {
  it('sends SIGTERM immediately and escalates to SIGKILL exactly SIGTERM_GRACE_MS later', () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    gracefulKill(child, fakeRuntime(time), () => 'alive');
    expect(child.killedSignals).toEqual(['SIGTERM']);

    time.tick(SIGTERM_GRACE_MS - 1);
    expect(child.killedSignals).toEqual(['SIGTERM']);

    time.tick(1);
    expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('settles observed absence when the child closes during the grace period', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    const disposition = gracefulKill(child, fakeRuntime(time), () => 'alive');
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS / 2);
    child.emitClose();

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGTERM']);
    await expect(disposition.settlement).resolves.toEqual({ kind: 'observed-absent', pid: 4_242 });
  });

  it('reports when SIGTERM delivery throws', () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.throwOnNextKill('SIGTERM');

    expect(gracefulKill(child, fakeRuntime(time), () => 'alive')).toEqual({
      kind: 'signal-failed',
      pid: 4_242,
      signal: 'SIGTERM',
      reason: 'kill-port-threw',
    });
    expect(child.killedSignals).toEqual([]);

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual([]);
  });

  it('reports when SIGTERM delivery returns false', () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.returnFalseOnNextKill('SIGTERM');

    expect(gracefulKill(child, fakeRuntime(time), () => 'alive')).toEqual({
      kind: 'signal-failed',
      pid: 4_242,
      signal: 'SIGTERM',
      reason: 'kill-port-returned-false',
    });
    expect(child.killedSignals).toEqual(['SIGTERM']);

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGTERM']);
  });

  it('settles observed absence when the delayed observation finds the child absent', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    const disposition = gracefulKill(child, fakeRuntime(time), () => 'absent');
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS);

    expect(child.killedSignals).toEqual(['SIGTERM']);
    await expect(disposition.settlement).resolves.toEqual({ kind: 'observed-absent', pid: 4_242 });
  });

  it('settles an unobservable target when the delayed observation is unknown', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    const disposition = gracefulKill(child, fakeRuntime(time), () => 'unknown');
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS);

    expect(child.killedSignals).toEqual(['SIGTERM']);
    await expect(disposition.settlement).resolves.toEqual({
      kind: 'target-unobservable',
      pid: 4_242,
      stage: 'after-sigterm',
    });
  });

  it('settles an unobservable target when the delayed observation throws', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    const disposition = gracefulKill(child, fakeRuntime(time), () => {
      throw new Error('observation failed');
    });
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS);

    expect(child.killedSignals).toEqual(['SIGTERM']);
    await expect(disposition.settlement).resolves.toEqual({
      kind: 'target-unobservable',
      pid: 4_242,
      stage: 'after-sigterm',
    });
  });

  it('settles an observed-live target after SIGKILL', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    const disposition = gracefulKill(child, fakeRuntime(time), () => 'alive');
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
    time.tick(SIGKILL_GRACE_MS);

    await expect(disposition.settlement).resolves.toEqual({
      kind: 'target-alive',
      pid: 4_242,
      stage: 'after-sigkill',
    });
  });

  it('reports when SIGKILL delivery throws', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.throwOnNextKill('SIGKILL');
    const disposition = gracefulKill(child, fakeRuntime(time), () => 'alive');
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');

    time.tick(SIGTERM_GRACE_MS);

    await expect(disposition.settlement).resolves.toEqual({
      kind: 'signal-failed',
      pid: 4_242,
      signal: 'SIGKILL',
      reason: 'kill-port-threw',
    });
  });

  it('reports when SIGKILL delivery returns false', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.returnFalseOnNextKill('SIGKILL');
    const disposition = gracefulKill(child, fakeRuntime(time), () => 'alive');
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');

    time.tick(SIGTERM_GRACE_MS);

    await expect(disposition.settlement).resolves.toEqual({
      kind: 'signal-failed',
      pid: 4_242,
      signal: 'SIGKILL',
      reason: 'kill-port-returned-false',
    });
    expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('retains a delivered SIGTERM on child close when no pid is available for escalation', async () => {
    const time = new VirtualTime();
    const child = new FakeChild(undefined);

    const disposition = gracefulKill(child, fakeRuntime(time), () => 'alive');
    expect(disposition).toMatchObject({
      kind: 'signal-delivered-escalation-unavailable',
      pid: null,
      signal: 'SIGTERM',
      reason: 'child-pid-unavailable',
      settlement: expect.any(Promise),
    });
    expect(child.killedSignals).toEqual(['SIGTERM']);
    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGTERM']);
    if (!('settlement' in disposition)) throw new Error('expected close-backed SIGTERM ownership');
    child.emitClose();
    await expect(disposition.settlement).resolves.toEqual({ kind: 'observed-absent', pid: null });
  });
});

function pidRuntime(
  time: VirtualTime,
  incarnations: readonly (ProcessIncarnation | null)[],
  observeLiveness: () => ProcessLiveness = () => 'alive',
  platform: NodeJS.Platform = 'linux',
  killResults: readonly boolean[] = [],
): { runtime: Runtime; killedSignals: NodeJS.Signals[] } {
  const remainingIncarnations = [...incarnations];
  const remainingKillResults = [...killResults];
  const killedSignals: NodeJS.Signals[] = [];
  const runtime = {
    time,
    env: { platform: () => platform },
    process: {
      kill: (_pid: number, signal: NodeJS.Signals) => {
        killedSignals.push(signal);
        return remainingKillResults.shift() ?? true;
      },
      observeLiveness,
      readProcessIncarnation: () => remainingIncarnations.shift() ?? null,
    },
  } as unknown as Runtime;
  return { runtime, killedSignals };
}

describe('gracefulKillByPid', () => {
  const incarnation = testIncarnation(42);

  it('escalates only after the recorded incarnation is re-observed alive', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation, incarnation]);

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);
    expect(disposition).toMatchObject({ kind: 'escalation-scheduled', pid: 4_242 });
    expect(killedSignals).toEqual(['SIGTERM']);

    time.tick(SIGTERM_GRACE_MS);
    expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('refuses every signal when no recorded incarnation is supplied', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation]);

    const disposition = gracefulKillByPid(runtime, 4_242, null);

    expect(disposition).toEqual({
      kind: 'signal-refused',
      pid: 4_242,
      reason: 'recorded-incarnation-unavailable',
    });
    expect(killedSignals).toEqual([]);

    time.tick(SIGTERM_GRACE_MS);
    expect(killedSignals).toEqual([]);
  });

  it('refuses escalation when the recorded incarnation cannot be re-established', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation, null]);

    gracefulKillByPid(runtime, 4_242, incarnation);
    time.tick(SIGTERM_GRACE_MS);

    expect(killedSignals).toEqual(['SIGTERM']);
  });

  it('refuses escalation when the re-established process has unknown liveness', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation, incarnation], () => 'unknown');

    gracefulKillByPid(runtime, 4_242, incarnation);
    time.tick(SIGTERM_GRACE_MS);

    expect(killedSignals).toEqual(['SIGTERM']);
  });

  it('refuses escalation when the liveness observation throws', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation, incarnation], () => {
      throw new Error('observation failed');
    });

    gracefulKillByPid(runtime, 4_242, incarnation);
    time.tick(SIGTERM_GRACE_MS);

    expect(killedSignals).toEqual(['SIGTERM']);
  });

  it('sends the first SIGTERM when a passed expected incarnation still matches', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation]);

    gracefulKillByPid(runtime, 4_242, incarnation);

    expect(killedSignals).toEqual(['SIGTERM']);
  });

  it('refuses the first SIGTERM when the pid no longer carries the expected incarnation', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [testIncarnation(43)]);

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);

    expect(disposition).toEqual({
      kind: 'signal-refused',
      pid: 4_242,
      reason: 'expected-incarnation-mismatch',
    });
    expect(killedSignals).toEqual([]);
  });

  it('refuses the first SIGTERM when an expected incarnation is passed but none can be observed', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [null]);

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);

    expect(disposition).toEqual({
      kind: 'signal-refused',
      pid: 4_242,
      reason: 'signal-authorizing-incarnation-unavailable',
    });
    expect(killedSignals).toEqual([]);
  });

  it('refuses every signal on a platform whose incarnation cannot authorize a signal', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [testIncarnation(43)], () => 'alive', 'darwin');

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);

    expect(disposition).toEqual({
      kind: 'signal-refused',
      pid: 4_242,
      reason: 'platform-incarnation-cannot-authorize-signal',
    });
    expect(killedSignals).toEqual([]);
  });

  it('reports when SIGTERM could not be delivered', () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation], () => 'alive', 'linux', [false]);

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);

    expect(disposition).toEqual({
      kind: 'signal-failed',
      pid: 4_242,
      signal: 'SIGTERM',
      reason: 'kill-port-returned-false',
    });
    expect(killedSignals).toEqual(['SIGTERM']);
    time.tick(SIGTERM_GRACE_MS);
    expect(killedSignals).toEqual(['SIGTERM']);
  });

  it('reports when SIGKILL could not be delivered', async () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, [incarnation, incarnation], () => 'alive', 'linux', [
      true,
      false,
    ]);

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS);

    await expect(disposition.settlement).resolves.toEqual({
      kind: 'signal-failed',
      pid: 4_242,
      signal: 'SIGKILL',
      reason: 'kill-port-returned-false',
    });
    expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('settles only after absence is observed following escalation', async () => {
    const time = new VirtualTime();
    const liveness = ['alive', 'alive', 'absent'] satisfies ProcessLiveness[];
    const { runtime, killedSignals } = pidRuntime(time, [incarnation, incarnation, null], () => {
      return liveness.shift() ?? 'absent';
    });

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS);
    let settled = false;
    void disposition.settlement.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    time.tick(SIGKILL_GRACE_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    time.tick(1);

    await expect(disposition.settlement).resolves.toEqual({ kind: 'observed-absent', pid: 4_242 });
    expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports an observed-live target after SIGKILL is delivered', async () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, Array<ProcessIncarnation>(10).fill(incarnation));

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS);
    time.tick(SIGKILL_GRACE_MS);

    await expect(disposition.settlement).resolves.toEqual({
      kind: 'target-alive',
      pid: 4_242,
      stage: 'after-sigkill',
    });
    expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('cleanupSpawnedProcessGroup', () => {
  function processGroupRuntime(
    time: VirtualTime,
    observeLiveness: (pid: number) => ProcessLiveness = () => 'alive',
  ): { runtime: Runtime; signals: Array<{ pid: number; signal: NodeJS.Signals }> } {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    return {
      runtime: {
        time,
        env: { platform: () => 'darwin' },
        process: {
          observeLiveness,
          kill: (pid: number, signal: NodeJS.Signals | 0) => {
            if (signal !== 0) signals.push({ pid, signal });
            return true;
          },
        },
      } as unknown as Runtime,
      signals,
    };
  }

  it('signals a retained own-child group without a platform or incarnation gate', async () => {
    const time = new VirtualTime();
    const { runtime, signals } = processGroupRuntime(time);
    const cleanup = retainSpawnedProcessGroupCleanup(new FakeChild());
    const abort = new AbortController();

    const disposition = cleanupSpawnedProcessGroup(cleanup, runtime, abort.signal);
    expect(signals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
    abort.abort();
    await flushMicrotasks();

    await expect(disposition).resolves.toMatchObject({ kind: 'held-alive', observation: 'alive' });
  });

  it('holds without signaling when the group is present after the leader was collected', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.emitExit(0, null);
    const { runtime, signals } = processGroupRuntime(time);
    const cleanup = retainSpawnedProcessGroupCleanup(child);

    await expect(cleanupSpawnedProcessGroup(cleanup, runtime)).resolves.toMatchObject({
      kind: 'held-unobservable',
      observation: 'unobservable',
    });
    expect(signals).toEqual([]);
  });

  it('does not signal again when the leader is collected during the SIGTERM grace', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    const { runtime, signals } = processGroupRuntime(time);
    const cleanup = retainSpawnedProcessGroupCleanup(child);

    const disposition = cleanupSpawnedProcessGroup(cleanup, runtime);
    expect(signals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
    child.emitExit(0, null);
    time.tick(SIGTERM_GRACE_MS);
    await flushMicrotasks();

    await expect(disposition).resolves.toMatchObject({ kind: 'held-unobservable', observation: 'unobservable' });
    expect(signals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
  });

  it('observes absence without signaling after the leader was collected', async () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.emitExit(null, 'SIGTERM');
    const { runtime, signals } = processGroupRuntime(time, (pid) => (pid === -4_242 ? 'absent' : 'alive'));
    const cleanup = retainSpawnedProcessGroupCleanup(child);

    await expect(cleanupSpawnedProcessGroup(cleanup, runtime)).resolves.toMatchObject({
      kind: 'observed-absent',
      evidence: { subject: { kind: 'process-group', processGroupId: 4_242 } },
    });
    expect(signals).toEqual([]);
  });

  it('does not escalate after its abort signal settles the SIGTERM grace', async () => {
    const time = new VirtualTime();
    const { runtime, signals } = processGroupRuntime(time);
    const cleanup = retainSpawnedProcessGroupCleanup(new FakeChild());
    const abort = new AbortController();

    const disposition = cleanupSpawnedProcessGroup(cleanup, runtime, abort.signal);
    expect(signals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
    abort.abort();
    await flushMicrotasks();

    await expect(disposition).resolves.toMatchObject({ kind: 'held-alive', observation: 'alive' });
    expect(signals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
  });
});
