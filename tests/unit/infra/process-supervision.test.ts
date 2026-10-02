import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { SIGKILL_GRACE_MS, SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import type { ProcessIncarnation, ProcessLiveness } from '#src/infra/node-process.js';
import {
  cleanupSpawnedProcessGroup,
  gracefulKill,
  gracefulKillByPid,
  retainSpawnedProcessGroupCleanup,
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

  constructor(...args: [] | [number | undefined]) {
    super();
    this.pid = args.length === 0 ? 4_242 : args[0];
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal) this.killedSignals.push(signal);
    return true;
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
});
