import { EventEmitter } from 'node:events';

import type { ProcessIncarnation, ProcessLiveness } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { liveChildAuthority, type LiveChildAuthority } from '#src/infra/process-supervision.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it } from 'vitest';

import { createMonotonicClock, type MonotonicInstant } from '#src/infra/monotonic-clock.js';
import {
  abortRecordedContainment,
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '#src/infra/process-containment.js';

const containment: RecordedContainmentIdentity = {
  pid: 100,
  incarnation: testIncarnation(1),
  processGroupId: 100,
};
const providerRoot: RecordedProcessIdentity = { pid: 101, incarnation: testIncarnation(2) };
const containmentClockScope = Symbol('process-containment-test');

type FakeState = {
  groupAlive: boolean;
  leaderAlive: boolean;
  providerRootAlive: boolean;
};

class FakeKnownChild extends EventEmitter implements ChildProcessLike {
  readonly pid: number;
  readonly stdin = null;
  readonly stdout = null;
  readonly stderr = null;
  private readonly collected: () => boolean;

  constructor(pid: number, collected: () => boolean) {
    super();
    this.pid = pid;
    this.collected = collected;
  }

  get exitCode(): number | null {
    return this.collected() ? 0 : null;
  }

  get signalCode(): NodeJS.Signals | null {
    return null;
  }

  kill(): boolean {
    return true;
  }
}

function knownChildAuthority(pid: number, collected: () => boolean): LiveChildAuthority {
  const authority = liveChildAuthority(new FakeKnownChild(pid, collected));
  if (authority === undefined) throw new Error('fake child must have a pid');
  return authority;
}

function createFakeEnvironment(
  state: FakeState,
  options: {
    signalCostMs?: number;
    unreadablePids?: ReadonlySet<number>;
    refusedPids?: ReadonlySet<number>;
    groupLiveness?: ProcessLiveness;
    leaderIncarnation?: ProcessIncarnation;
    observationCostMs?: number;
    platform?: NodeJS.Platform;
    knownLivePids?: ReadonlySet<number>;
    exitedPids?: ReadonlySet<number>;
  } = {},
): {
  environment: ProcessContainmentEnvironment<typeof containmentClockScope>;
  now: () => number;
  observedPids: number[];
  observedIdentityPids: number[];
  signals: Array<{ pid: number; signal: NodeJS.Signals | 0; at: number }>;
} {
  let elapsedMs = 0;
  const observedPids: number[] = [];
  const observedIdentityPids: number[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0; at: number }> = [];
  const observeLiveness = (pid: number): ProcessLiveness => {
    observedPids.push(pid);
    if (pid === -containment.processGroupId) {
      return options.groupLiveness ?? (state.groupAlive ? 'alive' : 'absent');
    }
    if (pid === containment.pid) return state.leaderAlive ? 'alive' : 'absent';
    if (pid === providerRoot.pid) return state.providerRootAlive ? 'alive' : 'absent';
    return 'absent';
  };

  const clock = createMonotonicClock(containmentClockScope, {
    readMilliseconds: () => BigInt(elapsedMs),
    sleep: async (ms) => {
      elapsedMs += ms;
    },
  });

  const readProcessIncarnation = (pid: number): ProcessIncarnation | null => {
    if (options.unreadablePids?.has(pid)) return null;
    if (pid === containment.pid && state.leaderAlive) {
      return options.leaderIncarnation ?? containment.incarnation;
    }
    if (pid === providerRoot.pid && state.providerRootAlive) return providerRoot.incarnation;
    return null;
  };

  return {
    now: () => elapsedMs,
    observedPids,
    observedIdentityPids,
    signals,
    environment: {
      clock,
      process: {
        observeLiveness,
        observeRecordedProcessAsync: async (identity, signal) => {
          observedIdentityPids.push(identity.pid);
          if (signal?.aborted) return 'unknown';
          elapsedMs += options.observationCostMs ?? 0;
          const liveness = observeLiveness(identity.pid);
          if (liveness === 'absent') return 'absent';
          const observedIncarnation = readProcessIncarnation(identity.pid);
          if (observedIncarnation === null || liveness === 'unknown') return 'unknown';
          return observedIncarnation === identity.incarnation ? 'alive' : 'absent';
        },
        kill: (pid, signal) => {
          signals.push({ pid, signal, at: elapsedMs });
          elapsedMs += options.signalCostMs ?? 0;
          if (options.refusedPids?.has(pid)) return false;
          if (signal === 'SIGKILL') {
            if (pid === -containment.processGroupId) {
              state.groupAlive = false;
              state.leaderAlive = false;
            }
            if (pid === providerRoot.pid) state.providerRootAlive = false;
          }
          return observeLiveness(pid) !== 'absent';
        },
      },
      platform: options.platform ?? 'linux',
      maxRecordedRoots: 128,
      readProcessIncarnation,
      knownLiveChildFor: (pid) =>
        options.knownLivePids?.has(pid) === true
          ? knownChildAuthority(
              pid,
              () =>
                options.exitedPids?.has(pid) === true ||
                (pid === containment.pid && !state.leaderAlive) ||
                (pid === providerRoot.pid && !state.providerRootAlive),
            )
          : undefined,
    },
  };
}

function deadlineAfter(
  environment: ProcessContainmentEnvironment<typeof containmentClockScope>,
  milliseconds: number,
): MonotonicInstant<typeof containmentClockScope> {
  return environment.clock.shiftMilliseconds(environment.clock.now(), milliseconds);
}

describe('recorded process containment', () => {
  it('refuses an abort before signaling when the wrapper pid was recycled', () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: true },
      { leaderIncarnation: testIncarnation('recycled') },
    );

    expect(
      abortRecordedContainment(
        { ...containment, childRoot: providerRoot },
        deadlineAfter(fake.environment, 1_001),
        fake.environment,
      ),
    ).toMatchObject({ kind: 'refused' });
    expect(fake.signals).toEqual([]);
  });

  it('uses TERM then KILL and confirms absence within one absolute deadline', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: true },
      { signalCostMs: 125 },
    );

    await reapRecordedContainment(
      containment,
      [providerRoot],
      deadlineAfter(fake.environment, 6_500),
      fake.environment,
    );

    expect(fake.signals).toEqual([
      { pid: -100, signal: 'SIGTERM', at: 0 },
      { pid: 101, signal: 'SIGTERM', at: 125 },
      { pid: -100, signal: 'SIGKILL', at: 5_250 },
      { pid: 101, signal: 'SIGKILL', at: 5_375 },
    ]);
    expect(fake.now()).toBe(6_500);
  });
});
