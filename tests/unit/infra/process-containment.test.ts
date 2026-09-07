import { EventEmitter } from 'node:events';

import type { ProcessIncarnation, ProcessLiveness } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { liveChildAuthority, type LiveChildAuthority } from '#src/infra/process-supervision.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicInstant } from '#src/infra/monotonic-clock.js';
import {
  abortRecordedContainment,
  observeRecordedContainment,
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '#src/infra/process-containment.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '#src/provider-proxy/ledger.js';

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
  it('observes a surviving child after the wrapper and group disappear', () => {
    const fake = createFakeEnvironment({ groupAlive: false, leaderAlive: false, providerRootAlive: true });

    expect(observeRecordedContainment({ ...containment, childRoot: providerRoot }, fake.environment)).toEqual({
      kind: 'alive',
    });
  });

  it('observes absence only after the wrapper group and child root are all absent', () => {
    const fake = createFakeEnvironment({ groupAlive: false, leaderAlive: false, providerRootAlive: false });

    expect(observeRecordedContainment({ ...containment, childRoot: providerRoot }, fake.environment)).toEqual({
      kind: 'absent',
    });
  });

  it('keeps an unattributable recorded group unobservable', () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { leaderIncarnation: testIncarnation('recycled') },
    );

    expect(observeRecordedContainment({ ...containment, childRoot: providerRoot }, fake.environment)).toMatchObject({
      kind: 'unobservable',
    });
  });

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

  it('refuses an abort when any live containment target rejects SIGTERM', () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: true },
      { refusedPids: new Set([providerRoot.pid]) },
    );

    expect(
      abortRecordedContainment(
        { ...containment, childRoot: providerRoot },
        deadlineAfter(fake.environment, 1_001),
        fake.environment,
      ),
    ).toMatchObject({ kind: 'refused' });
    expect(fake.signals.map(({ pid }) => pid)).toEqual([-containment.processGroupId, providerRoot.pid]);
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

  it('returns a retained refusal on Darwin when no live child handle authorizes the signals', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: true },
      { platform: 'darwin' },
    );

    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(fake.environment, 6_500), fake.environment),
    ).resolves.toEqual({ kind: 'signal-authorization-refused' });
    expect(fake.signals).toEqual([]);
  });

  it('allows Darwin signals while live child handles still own every target', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: true },
      { platform: 'darwin', knownLivePids: new Set([containment.pid, providerRoot.pid]) },
    );

    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(fake.environment, 6_500), fake.environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(fake.signals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL']);
  });

  it('uses live child authority without reading a Linux incarnation', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { knownLivePids: new Set([containment.pid]), unreadablePids: new Set([containment.pid]) },
    );

    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 6_500), fake.environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(fake.signals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('uses a live group leader authority without authorizing an unowned root signal', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: true },
      { platform: 'darwin', knownLivePids: new Set([containment.pid]) },
    );

    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(fake.environment, 6_500), fake.environment),
    ).resolves.toEqual({ kind: 'signal-authorization-refused' });
    expect(fake.signals).toEqual([{ pid: -containment.processGroupId, signal: 'SIGTERM', at: 0 }]);
  });

  it.each(['darwin', 'linux'] as const)(
    'refuses %s signals after a retained child handle has observed exit',
    async (platform) => {
      const fake = createFakeEnvironment(
        { groupAlive: true, leaderAlive: true, providerRootAlive: false },
        {
          platform,
          knownLivePids: new Set([containment.pid]),
          exitedPids: new Set([containment.pid]),
        },
      );

      await expect(
        reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 6_500), fake.environment),
      ).resolves.toEqual({ kind: 'signal-authorization-refused' });
      expect(fake.signals).toEqual([]);
    },
  );

  it('reserves an unattributable result for a mismatched recorded leader identity', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { leaderIncarnation: testIncarnation('replacement-leader') },
    );

    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 6_500), fake.environment),
    ).resolves.toEqual({ kind: 'recorded-group-unattributable' });
    expect(fake.signals).toEqual([]);
  });

  it('stops a partial observation at the deadline without reporting absence', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: false, leaderAlive: false, providerRootAlive: false },
      { observationCostMs: 1_000 },
    );
    const roots = [
      providerRoot,
      { pid: 102, incarnation: testIncarnation(3) },
      { pid: 103, incarnation: testIncarnation(4) },
    ];

    await expect(
      reapRecordedContainment(containment, roots, deadlineAfter(fake.environment, 1_500), fake.environment),
    ).rejects.toMatchObject({ code: 'process_containment_reap_failed' });
    expect(fake.observedIdentityPids).toEqual([containment.pid, providerRoot.pid]);
    expect(fake.signals).toEqual([]);
  });

  it('does not probe remaining roots once a wait observes the containment present', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: true, providerRootAlive: true });

    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(fake.environment, 100), fake.environment),
    ).rejects.toMatchObject({ code: 'process_containment_reap_failed' });
    expect(fake.observedIdentityPids.filter((pid) => pid === providerRoot.pid)).toHaveLength(2);
    expect(fake.signals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGTERM']);
  });

  it('revalidates caller authority immediately before each signal and reports only delivered signals', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: true, providerRootAlive: true });
    const delivered: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const assertSignalAuthorized = vi
      .fn<() => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('authorization moved');
      });

    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(fake.environment, 6_500), {
        ...fake.environment,
        assertSignalAuthorized,
        onSignal: (effect) => delivered.push(effect),
      }),
    ).rejects.toMatchObject({ code: 'process_containment_reap_failed' });

    expect(assertSignalAuthorized).toHaveBeenCalledTimes(2);
    expect(fake.signals).toEqual([{ pid: -100, signal: 'SIGTERM', at: 0 }]);
    expect(delivered).toEqual([{ pid: -100, signal: 'SIGTERM' }]);
  });

  it('does not give a late KILL step a fresh deadline', async () => {
    const state = { groupAlive: true, leaderAlive: true, providerRootAlive: true };
    const fake = createFakeEnvironment(state, { signalCostMs: 125 });

    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(fake.environment, 5_300), fake.environment),
    ).rejects.toMatchObject({
      code: 'process_containment_reap_failed',
    });

    expect(fake.signals).toEqual([
      { pid: -100, signal: 'SIGTERM', at: 0 },
      { pid: 101, signal: 'SIGTERM', at: 125 },
      { pid: -100, signal: 'SIGKILL', at: 5_250 },
    ]);
    expect(fake.now()).toBe(5_375);
    expect(state.providerRootAlive).toBe(true);
  });

  it('accepts a process-control call at the 500ms bound', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { signalCostMs: 500 },
    );

    await reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 7_000), fake.environment);

    expect(fake.signals).toEqual([
      { pid: -100, signal: 'SIGTERM', at: 0 },
      { pid: -100, signal: 'SIGKILL', at: 5_500 },
    ]);
    expect(fake.now()).toBe(7_000);
  });

  it('reports a process-control call beyond the 500ms bound', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { signalCostMs: 501 },
    );

    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 10_000), fake.environment),
    ).rejects.toMatchObject({
      code: 'process_containment_reap_failed',
      context: { callDurationMs: 501, limit: 500 },
    });
    expect(fake.signals).toEqual([{ pid: -100, signal: 'SIGTERM', at: 0 }]);
  });

  it('fails closed before signalling when a live process incarnation cannot be read', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { unreadablePids: new Set([containment.pid]) },
    );

    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 10_000), fake.environment),
    ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: false });
    expect(fake.signals).toEqual([]);
  });

  // The third answer at a signalling boundary. A group whose liveness cannot be observed is not a group that
  // may be signalled: SIGTERM and then SIGKILL would land on a numeric group nobody saw, and the leader's id
  // may have been reused since. This is the case `!== 'absent'` silently authorized.
  it('refuses to signal a recorded group whose liveness cannot be observed', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { groupLiveness: 'unknown' },
    );

    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 10_000), fake.environment),
    ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: false });
    expect(fake.signals, 'nothing may be signalled on an answer nobody has').toEqual([]);
  });

  it('retains delivered-signal evidence when identity observation becomes unavailable during the wait', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: true, providerRootAlive: false });
    const observeRecordedProcessAsync = fake.environment.process.observeRecordedProcessAsync;
    if (observeRecordedProcessAsync === undefined) throw new Error('fake environment must observe asynchronously');
    let observations = 0;

    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 10_000), {
        ...fake.environment,
        process: {
          ...fake.environment.process,
          observeRecordedProcessAsync: async (identity, signal) => {
            observations += 1;
            return observations > 2 ? 'unknown' : observeRecordedProcessAsync(identity, signal);
          },
        },
      }),
    ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: true });
    expect(fake.signals).toEqual([{ pid: -containment.processGroupId, signal: 'SIGTERM', at: 0 }]);
  });

  it('retains a partial delivery when a later target becomes unobservable during signal authorization', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: true, providerRootAlive: true });
    const observeRecordedProcessAsync = fake.environment.process.observeRecordedProcessAsync;
    if (observeRecordedProcessAsync === undefined) throw new Error('fake environment must observe asynchronously');
    let observations = 0;

    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(fake.environment, 10_000), {
        ...fake.environment,
        process: {
          ...fake.environment.process,
          observeRecordedProcessAsync: async (identity, signal) => {
            observations += 1;
            return observations > 3 ? 'unknown' : observeRecordedProcessAsync(identity, signal);
          },
        },
      }),
    ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: true });
    expect(fake.signals).toEqual([{ pid: -containment.processGroupId, signal: 'SIGTERM', at: 0 }]);
  });

  it.each(['alive', 'unknown'] as const)(
    'returns the named no-verdict when the leader identity is gone and group liveness is %s',
    async (groupLiveness) => {
      const fake = createFakeEnvironment(
        { groupAlive: true, leaderAlive: true, providerRootAlive: false },
        { groupLiveness, leaderIncarnation: testIncarnation('recycled') },
      );

      await expect(
        reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 10_000), fake.environment),
      ).resolves.toEqual({ kind: 'recorded-group-unattributable' });
      expect(fake.observedPids).toContain(-containment.processGroupId);
      expect(fake.signals).toEqual([]);
    },
  );

  it('confirms absence after a leader identity mismatch only when the group probe observes absence', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: false, leaderAlive: true, providerRootAlive: false },
      { leaderIncarnation: testIncarnation('recycled') },
    );

    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(fake.environment, 10_000), fake.environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(fake.observedPids).toContain(-containment.processGroupId);
    expect(fake.signals).toEqual([]);
  });

  it('rejects provider root 129 before probing or signalling', async () => {
    let probed = false;
    const fake = createFakeEnvironment({ groupAlive: false, leaderAlive: false, providerRootAlive: false });
    const environment: ProcessContainmentEnvironment<typeof containmentClockScope> = {
      ...fake.environment,
      readProcessIncarnation: () => {
        probed = true;
        return null;
      },
    };
    const roots = Array.from({ length: MAX_PROXY_OPERATION_LEDGERS + 1 }, (_, index) => ({
      pid: 1_000 + index,
      incarnation: testIncarnation(1),
    }));

    await expect(
      reapRecordedContainment(containment, roots, deadlineAfter(environment, 10_000), environment),
    ).rejects.toMatchObject({
      code: 'process_containment_reap_failed',
    });
    expect(probed).toBe(false);
    expect(fake.signals).toEqual([]);
  });
});
