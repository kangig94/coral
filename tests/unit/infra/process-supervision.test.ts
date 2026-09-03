import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import type { ProcessIncarnation, ProcessLiveness } from '#src/infra/node-process.js';
import { gracefulKill, gracefulKillByPid } from '#src/infra/process-supervision.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly pid = 4_242;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  readonly killedSignals: NodeJS.Signals[] = [];
  private throwOnSignal: NodeJS.Signals | null = null;

  /** Models the "child is already gone" race `safeKill`'s try/catch exists to absorb. */
  throwOnNextKill(signal: NodeJS.Signals): void {
    this.throwOnSignal = signal;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal && this.throwOnSignal === signal) {
      this.throwOnSignal = null;
      throw new Error(`simulated kill(${signal}) failure`);
    }
    if (signal) this.killedSignals.push(signal);
    return true;
  }

  emitClose(): void {
    this.emit('close', null, null);
  }
}

function fakeRuntime(time: VirtualTime): Runtime {
  return { time } as unknown as Runtime;
}

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

  it('does not escalate to SIGKILL when the child closes during the grace period', () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    gracefulKill(child, fakeRuntime(time), () => 'alive');
    time.tick(SIGTERM_GRACE_MS / 2);
    child.emitClose();

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGTERM']);
  });

  it('still escalates to SIGKILL after the grace even when the SIGTERM call throws', () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.throwOnNextKill('SIGTERM');

    expect(() => gracefulKill(child, fakeRuntime(time), () => 'alive')).not.toThrow();
    expect(child.killedSignals).toEqual([]);

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGKILL']);
  });

  it('refuses SIGKILL when the delayed observation finds the child absent', () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    gracefulKill(child, fakeRuntime(time), () => 'absent');
    time.tick(SIGTERM_GRACE_MS);

    expect(child.killedSignals).toEqual(['SIGTERM']);
  });

  it('refuses SIGKILL when the delayed observation is unknown', () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    gracefulKill(child, fakeRuntime(time), () => 'unknown');
    time.tick(SIGTERM_GRACE_MS);

    expect(child.killedSignals).toEqual(['SIGTERM']);
  });

  it('refuses SIGKILL when the delayed observation throws', () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    gracefulKill(child, fakeRuntime(time), () => {
      throw new Error('observation failed');
    });
    time.tick(SIGTERM_GRACE_MS);

    expect(child.killedSignals).toEqual(['SIGTERM']);
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

    await expect(disposition.settlement).resolves.toEqual({ kind: 'observed-absent', pid: 4_242 });
    expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports an observed-live target after SIGKILL is delivered', async () => {
    const time = new VirtualTime();
    const { runtime, killedSignals } = pidRuntime(time, Array<ProcessIncarnation>(10).fill(incarnation));

    const disposition = gracefulKillByPid(runtime, 4_242, incarnation);
    if (disposition.kind !== 'escalation-scheduled') throw new Error('expected SIGTERM delivery');
    time.tick(SIGTERM_GRACE_MS);

    await expect(disposition.settlement).resolves.toEqual({
      kind: 'target-alive',
      pid: 4_242,
      stage: 'after-sigkill',
    });
    expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
