import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';
import { gracefulKill } from '#src/infra/process-supervision.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type { Runtime } from '#src/runtime/ports.js';
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

    gracefulKill(child, fakeRuntime(time));
    expect(child.killedSignals).toEqual(['SIGTERM']);

    time.tick(SIGTERM_GRACE_MS - 1);
    expect(child.killedSignals).toEqual(['SIGTERM']);

    time.tick(1);
    expect(child.killedSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not escalate to SIGKILL when the child closes during the grace period', () => {
    const time = new VirtualTime();
    const child = new FakeChild();

    gracefulKill(child, fakeRuntime(time));
    time.tick(SIGTERM_GRACE_MS / 2);
    child.emitClose();

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGTERM']);
  });

  it('still escalates to SIGKILL after the grace even when the SIGTERM call throws', () => {
    const time = new VirtualTime();
    const child = new FakeChild();
    child.throwOnNextKill('SIGTERM');

    expect(() => gracefulKill(child, fakeRuntime(time))).not.toThrow();
    expect(child.killedSignals).toEqual([]);

    time.tick(SIGTERM_GRACE_MS);
    expect(child.killedSignals).toEqual(['SIGKILL']);
  });
});
