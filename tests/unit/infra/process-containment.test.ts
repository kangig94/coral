import { CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS } from '#src/infra/process-constants.js';
import { EventEmitter } from 'node:events';

import type { ProcessIncarnation, ProcessLiveness } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { liveChildAuthority, type LiveChildAuthority } from '#src/infra/process-supervision.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';
import type { FailureDomainContainment, FailureDomainObservation } from '#src/infra/failure-domain.js';

import { createMonotonicClock, type MonotonicInstant } from '#src/infra/monotonic-clock.js';
import {
  abortRecordedContainment,
  createFailureDomainAbsenceObserver,
  confirmRecordedGroupMemberAbsence,
  observeRecordedGroupMember,
  observeRecordedContainment,
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

  const member: RecordedContainmentIdentity = { pid: 150, incarnation: testIncarnation(3), processGroupId: 100 };

  it.each([
    ['member and group gone', { groupAlive: false }, {}, 'absent'],
    ['group outlives the member', { groupAlive: true }, {}, 'unobservable'],
    ['group unobservable', { groupAlive: false }, { groupLiveness: 'unknown' }, 'unobservable'],
  ] as const)('decides a group member from its own and its group liveness: %s', async (_case, state, options, kind) => {
    const fake = createFakeEnvironment({ leaderAlive: false, providerRootAlive: false, ...state }, options);

    expect(observeRecordedGroupMember({ ...member, childRoot: null }, fake.environment)).toMatchObject({ kind });
    await expect(confirmRecordedGroupMemberAbsence(member, [], fake.environment)).resolves.toMatchObject({ kind });
    expect(fake.signals).toEqual([]);
  });

  it('keeps a member absent only when it stays absent across the confirmation window', async () => {
    const fake = createFakeEnvironment({ groupAlive: false, leaderAlive: false, providerRootAlive: false });
    const observe = fake.environment.process.observeLiveness;
    fake.environment.process.observeLiveness = (pid) =>
      pid === -member.processGroupId && fake.now() >= 500 ? 'alive' : observe(pid);

    await expect(confirmRecordedGroupMemberAbsence(member, [], fake.environment)).resolves.toMatchObject({
      kind: 'unobservable',
    });
  });

  it('refuses to reap a group member record without signaling anything', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: false, providerRootAlive: false });

    await expect(
      reapRecordedContainment(member, [], deadlineAfter(fake.environment, 2_000), fake.environment),
    ).rejects.toThrow(/not a detached process-group leader/u);
    expect(fake.signals).toEqual([]);
  });
});

describe('recorded leaf containment evidence', () => {
  function setup(observation: FailureDomainObservation, platform: NodeJS.Platform = 'linux') {
    const fake = createFakeEnvironment(
      { groupAlive: false, leaderAlive: false, providerRootAlive: false },
      { platform },
    );
    const domain = {
      hasEntered: () => true,
      observe: vi.fn(() => observation),
      kill: vi.fn<FailureDomainContainment['kill']>(() => ({ kind: 'entered' })),
    } satisfies FailureDomainContainment;
    const environment = { ...fake.environment, failureDomain: domain };
    return { ...fake, domain, environment };
  }

  it.each([
    ['unknown', 'unobservable'],
    ['unresolved', 'unobservable'],
    ['populated', 'alive'],
    ['missing', 'absent'],
  ] as const)('refreshes an initially missing leaf after synchronous probes become %s', (after, kind) => {
    const { environment, domain } = setup({ kind: 'missing' });
    const observed = {
      ...environment,
      readProcessIncarnation: () => {
        domain.observe.mockReturnValue(
          after === 'unknown' || after === 'unresolved' ? { kind: after, reason: 'EACCES' } : { kind: after },
        );
        return null;
      },
    };
    expect(observeRecordedContainment({ ...containment, childRoot: null }, observed).kind).toBe(kind);
  });

  it.each(['unknown', 'missing', 'populated'] as const)(
    'refreshes initially missing leaf evidence after process-group confirmation becomes %s',
    async (after) => {
      const { environment, domain } = setup({ kind: 'missing' });
      const observed = {
        ...environment,
        process: {
          ...environment.process,
          observeRecordedProcessAsync: async () => {
            domain.observe.mockReturnValue(
              after === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: after },
            );
            return 'absent' as const;
          },
        },
      };
      const result = await reapRecordedContainment(containment, [], deadlineAfter(environment, 2000), observed);
      expect(result.kind).toBe(after === 'missing' ? 'containment-absent' : 'identity-unobservable');
    },
  );

  it.each([
    [{ kind: 'absent' }, 'absent'],
    [{ kind: 'populated' }, 'alive'],
    [{ kind: 'unknown', reason: 'EACCES' }, 'unobservable'],
    [{ kind: 'missing' }, 'absent'],
  ] as const)('observes %j with otherwise absent process-group evidence as %s', (leaf, kind) => {
    const { environment } = setup(leaf);
    expect(observeRecordedContainment({ ...containment, childRoot: null }, environment)).toMatchObject({ kind });
  });

  it('does not finalize an empty leaf when an exact recorded target is unobservable', async () => {
    const { environment: base, signals, domain } = setup({ kind: 'absent' });
    const environment = {
      ...base,
      process: {
        ...base.process,
        observeLiveness: () => 'unknown' as const,
        observeRecordedProcessAsync: async () => 'unknown' as const,
      },
    };
    expect(observeRecordedContainment({ ...containment, childRoot: null }, environment)).toMatchObject({
      kind: 'unobservable',
    });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), environment),
    ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: false });
    expect(domain.kill).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it.each(['populated', 'missing', 'unknown'] as const)(
    'rechecks a leaf that becomes %s during synchronous exact-target observation',
    (kind) => {
      const { environment, domain } = setup({ kind: 'absent' });
      environment.readProcessIncarnation = () => {
        domain.observe.mockReturnValue(kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind });
        return null;
      };
      expect(observeRecordedContainment({ ...containment, childRoot: null }, environment)).toMatchObject({
        kind: kind === 'populated' ? 'alive' : 'unobservable',
      });
      expect(domain.kill).not.toHaveBeenCalled();
    },
  );

  it('reclaims the inherited process group when leaf creation succeeded but target entry was refused', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: true, providerRootAlive: true });
    const domain = { observe: () => ({ kind: 'absent' as const }), kill: vi.fn(() => ({ kind: 'entered' as const })) };
    const environment = { ...fake.environment, failureDomain: domain };
    expect(observeRecordedContainment({ ...containment, childRoot: providerRoot }, environment)).toMatchObject({
      kind: 'alive',
    });
    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(environment, 6500), environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(fake.signals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL']);
    expect(domain.kill).not.toHaveBeenCalled();
  });

  it.each(['entry unproven', 'root unknown'] as const)(
    'retains unplaced descendants with exited recorded identities when %s',
    async (placement) => {
      const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: false, providerRootAlive: false });
      const domain: FailureDomainContainment = {
        observe: () => ({ kind: 'absent' }),
        kill: vi.fn<FailureDomainContainment['kill']>(() => ({ kind: 'entered' })),
        hasEntered: () => false,
      };
      const environment = {
        ...fake.environment,
        failureDomain: placement === 'root unknown' ? undefined : domain,
      };
      expect(observeRecordedContainment({ ...containment, childRoot: providerRoot }, environment).kind).not.toBe(
        'absent',
      );
      await expect(
        reapRecordedContainment(containment, [providerRoot], deadlineAfter(environment, 2000), environment),
      ).resolves.toEqual({ kind: 'recorded-group-unattributable' });
      expect(domain.kill).not.toHaveBeenCalled();
      expect(fake.signals).toEqual([]);
    },
  );

  it('falls back to complete process-group confirmation for an unproven empty leaf', async () => {
    const fake = createFakeEnvironment({ groupAlive: false, leaderAlive: false, providerRootAlive: false });
    const domain: FailureDomainContainment = {
      observe: () => ({ kind: 'absent' }),
      kill: vi.fn<FailureDomainContainment['kill']>(() => ({ kind: 'entered' })),
    };
    const environment = { ...fake.environment, failureDomain: domain };
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 2000), environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(fake.observedPids).toContain(-containment.processGroupId);
    expect(fake.now()).toBeGreaterThan(0);
    expect(domain.kill).not.toHaveBeenCalled();
  });

  it('uses an entered empty leaf despite an unattributable numeric group', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: false, providerRootAlive: false });
    const domain: FailureDomainContainment = {
      observe: () => ({ kind: 'absent' }),
      kill: vi.fn<FailureDomainContainment['kill']>(() => ({ kind: 'entered' })),
      hasEntered: () => true,
    };
    const environment = { ...fake.environment, failureDomain: domain };
    expect(observeRecordedContainment({ ...containment, childRoot: providerRoot }, environment).kind).toBe('absent');
    await expect(
      reapRecordedContainment(containment, [providerRoot], deadlineAfter(environment, 100), environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
  });

  it('does not upgrade process-group evidence after killing an unproven populated leaf', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: false, providerRootAlive: false });
    let populated = true;
    const domain: FailureDomainContainment = {
      observe: () => ({ kind: populated ? 'populated' : 'absent' }),
      kill: vi.fn<FailureDomainContainment['kill']>(() => {
        populated = false;
        return { kind: 'entered' };
      }),
    };
    const environment = { ...fake.environment, failureDomain: domain };
    expect(observeRecordedContainment({ ...containment, childRoot: null }, environment).kind).toBe('alive');
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 2000), environment),
    ).resolves.toEqual({ kind: 'recorded-group-unattributable' });
    expect(domain.kill).toHaveBeenCalledOnce();
    expect(fake.signals).toEqual([]);
  });

  it('atomically kills a populated leaf and requires a subsequent existing empty observation', async () => {
    const { environment, domain, signals } = setup({ kind: 'populated' });
    domain.observe
      .mockReturnValueOnce({ kind: 'populated' })
      .mockReturnValueOnce({ kind: 'populated' })
      .mockReturnValue({ kind: 'absent' });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(domain.kill).toHaveBeenCalledOnce();
    expect(signals).toEqual([]);
  });

  it('reclaims a leaf that first becomes populated during polling', async () => {
    const { environment, domain, signals } = setup({ kind: 'absent' });
    const authorize = vi.fn();
    domain.observe.mockReturnValueOnce({ kind: 'absent' }).mockReturnValue({ kind: 'populated' });
    domain.kill.mockImplementation(() => {
      expect(authorize).toHaveBeenCalled();
      domain.observe.mockReturnValue({ kind: 'absent' });
      return { kind: 'entered' };
    });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), {
        ...environment,
        assertSignalAuthorized: authorize,
      }),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(domain.kill).toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it.each(['authority', 'cancellation', 'deadline'] as const)(
    'revalidates %s before killing a leaf first populated during polling',
    async (guard) => {
      const { environment, domain } = setup({ kind: 'absent' });
      const controller = new AbortController();
      const refusal = new Error('cleanup authority lost');
      domain.observe.mockReturnValueOnce({ kind: 'absent' }).mockReturnValue({ kind: 'populated' });
      const authorize = vi.fn(() => {
        if (guard === 'authority') throw refusal;
        if (guard === 'cancellation') controller.abort(refusal);
        if (guard === 'deadline') void environment.clock.sleep(100);
      });
      const operation = reapRecordedContainment(containment, [], deadlineAfter(environment, 100), {
        ...environment,
        signal: controller.signal,
        assertSignalAuthorized: authorize,
      });
      if (guard === 'deadline')
        await expect(operation).rejects.toMatchObject({ code: 'process_containment_reap_failed' });
      else await expect(operation).rejects.toBe(refusal);
      expect(authorize).toHaveBeenCalled();
      expect(domain.kill).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'unknown'] as const)(
    'never falls back when an observed leaf becomes %s after kill',
    async (kind) => {
      const { environment, domain, signals } = setup({ kind: 'populated' });
      domain.observe
        .mockReturnValueOnce({ kind: 'populated' })
        .mockReturnValue(kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind });
      await expect(
        reapRecordedContainment(containment, [], deadlineAfter(environment, 100), environment),
      ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: true });
      expect(signals).toEqual([]);
    },
  );

  it.each(['populated', 'missing', 'unknown'] as const)(
    'rechecks a leaf that becomes %s while exact process observation is pending',
    async (kind) => {
      const { environment, domain, signals } = setup({ kind: 'absent' });
      let leaf: FailureDomainObservation = { kind: 'absent' };
      domain.observe.mockImplementation(() => leaf);
      domain.kill.mockImplementation(() => {
        leaf = { kind: 'absent' };
        return { kind: 'entered' };
      });
      let release!: () => void;
      const pendingIdentity = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observer = vi.fn(async () => {
        await pendingIdentity;
        return 'absent' as const;
      });
      const observedEnvironment = {
        ...environment,
        process: { ...environment.process, observeRecordedProcessAsync: observer },
      };
      const operation = reapRecordedContainment(containment, [], deadlineAfter(environment, 100), observedEnvironment);
      expect(observer).toHaveBeenCalledOnce();
      leaf = kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind };
      release();
      await expect(operation).resolves.toEqual(
        kind === 'populated'
          ? { kind: 'containment-absent' }
          : { kind: 'identity-unobservable', signalDelivered: false },
      );
      expect(domain.kill).toHaveBeenCalledTimes(kind === 'populated' ? 1 : 0);
      if (kind === 'populated') expect(domain.observe()).toEqual({ kind: 'absent' });
      expect(signals).toEqual([]);
    },
  );

  it('revalidates signal authority when an empty leaf populates during process observation', async () => {
    const { environment, domain } = setup({ kind: 'absent' });
    const observedEnvironment = {
      ...environment,
      process: {
        ...environment.process,
        observeRecordedProcessAsync: async () => {
          domain.observe.mockReturnValue({ kind: 'populated' });
          return 'absent' as const;
        },
      },
    };
    const refusal = new Error('observation only');
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), {
        ...observedEnvironment,
        assertSignalAuthorized: () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(domain.kill).not.toHaveBeenCalled();
  });

  it('does not kill a repopulated leaf after cancellation during awaited exact-target observation', async () => {
    const { environment, domain, signals } = setup({ kind: 'absent' });
    const controller = new AbortController();
    const cancelled = new Error('cleanup cancelled during identity observation');
    let completeObservation!: (value: 'absent') => void;
    const observation = new Promise<'absent'>((resolve) => {
      completeObservation = resolve;
    });
    const observeRecordedProcessAsync = vi.fn(() => observation);
    const result = reapRecordedContainment(containment, [], deadlineAfter(environment, 100), {
      ...environment,
      signal: controller.signal,
      process: { ...environment.process, observeRecordedProcessAsync },
    });
    const rejected = expect(result).rejects.toBe(cancelled);
    expect(observeRecordedProcessAsync).toHaveBeenCalledOnce();
    domain.observe.mockReturnValue({ kind: 'populated' });
    controller.abort(cancelled);
    completeObservation('absent');
    await rejected;
    expect(domain.kill).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it('bounds repeated population during process observation by the exit deadline', async () => {
    const { environment, domain, now } = setup({ kind: 'absent' });
    domain.kill.mockImplementation(() => {
      domain.observe.mockReturnValue({ kind: 'absent' });
      return { kind: 'entered' };
    });
    const observedEnvironment = {
      ...environment,
      process: {
        ...environment.process,
        observeRecordedProcessAsync: async () => {
          domain.observe.mockReturnValue({ kind: 'populated' });
          return 'absent' as const;
        },
      },
    };
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), observedEnvironment),
    ).rejects.toThrow(/remained populated/);
    expect(now()).toBe(100);
  });

  it('does not finalize while the leaf remains populated after a successful kill call', async () => {
    const { environment, domain, signals } = setup({ kind: 'populated' });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), environment),
    ).rejects.toThrow(/remained populated/);
    expect(domain.kill).toHaveBeenCalledOnce();
    expect(signals).toEqual([]);
  });

  it('retains unreadable leaves without signalling', async () => {
    const { environment, domain, signals } = setup({ kind: 'unknown', reason: 'EACCES' });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), environment),
    ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: false });
    expect(domain.kill).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it('retains a leaf whose kill is refused', async () => {
    const { environment, domain, signals } = setup({ kind: 'populated' });
    domain.kill.mockReturnValue({ kind: 'refused', errno: 'EACCES' });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), environment),
    ).resolves.toEqual({ kind: 'identity-unobservable', signalDelivered: false });
    expect(signals).toEqual([]);
  });

  it('does not kill a populated leaf when its exit deadline has expired', async () => {
    const { environment, domain } = setup({ kind: 'populated' });
    await expect(reapRecordedContainment(containment, [], deadlineAfter(environment, 0), environment)).rejects.toThrow(
      /no time remaining/,
    );
    expect(domain.kill).not.toHaveBeenCalled();
  });

  it('rechecks the exit deadline after signal authorization before killing a leaf', async () => {
    const { environment, domain } = setup({ kind: 'populated' });
    const deadline = deadlineAfter(environment, 1);
    await expect(
      reapRecordedContainment(containment, [], deadline, {
        ...environment,
        assertSignalAuthorized: () => {
          void environment.clock.sleep(1);
        },
      }),
    ).rejects.toThrow(/no time remaining/);
    expect(domain.kill).not.toHaveBeenCalled();
  });

  it.each(['entered', 'refused'] as const)(
    'bounds a %s leaf kill by the process-control call limit',
    async (result) => {
      const { environment, domain } = setup({ kind: 'populated' });
      domain.kill.mockImplementation(() => {
        void environment.clock.sleep(CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS + 1);
        domain.observe.mockReturnValue({ kind: 'absent' });
        return result === 'entered' ? { kind: 'entered' } : { kind: 'refused', errno: 'EACCES' };
      });
      await expect(
        reapRecordedContainment(containment, [], deadlineAfter(environment, 2000), environment),
      ).rejects.toThrow(/process-control call exceeded/);
      expect(domain.kill).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves signal authorization for observation-only callers', async () => {
    const { environment, domain } = setup({ kind: 'populated' });
    const refusal = new Error('observation only');
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 100), {
        ...environment,
        assertSignalAuthorized: () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(domain.kill).not.toHaveBeenCalled();
  });

  it('does not read or kill a leaf on macOS', async () => {
    const { environment, domain } = setup({ kind: 'populated' }, 'darwin');
    expect(observeRecordedContainment({ ...containment, childRoot: null }, environment)).toEqual({ kind: 'absent' });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 2000), environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(domain.observe).not.toHaveBeenCalled();
    expect(domain.kill).not.toHaveBeenCalled();
  });

  it('falls back from a missing old-build leaf to a still-live process group', async () => {
    const fake = createFakeEnvironment({ groupAlive: true, leaderAlive: true, providerRootAlive: false });
    const kill = vi.fn(() => ({ kind: 'entered' as const }));
    const environment = { ...fake.environment, failureDomain: { observe: () => ({ kind: 'missing' as const }), kill } };
    expect(observeRecordedContainment({ ...containment, childRoot: null }, environment)).toEqual({ kind: 'alive' });
    await expect(
      reapRecordedContainment(containment, [], deadlineAfter(environment, 6500), environment),
    ).resolves.toEqual({ kind: 'containment-absent' });
    expect(fake.signals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(kill).not.toHaveBeenCalled();
  });
});

it('does not lose an existing leaf when an outer observer has no direct capability', () => {
  const permitsIndependentAbsenceDecision = createFailureDomainAbsenceObserver(undefined);
  expect(permitsIndependentAbsenceDecision()).toBe(true);
  expect(permitsIndependentAbsenceDecision({ kind: 'absent' })).toBe(true);
  expect(permitsIndependentAbsenceDecision()).toBe(false);
});
