import { describe, expect, it } from 'vitest';

import {
  ProcessContainmentError,
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '#src/infra/process-containment.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '#src/infra/process-constants.js';

const containment: RecordedContainmentIdentity = {
  pid: 100,
  processStartedAtSeconds: 1,
  processGroupId: 100,
};
const providerRoot: RecordedProcessIdentity = { pid: 101, processStartedAtSeconds: 2 };

type FakeState = {
  groupAlive: boolean;
  leaderAlive: boolean;
  providerRootAlive: boolean;
};

function createFakeEnvironment(
  state: FakeState,
  options: { signalCostMs?: number; unreadablePids?: ReadonlySet<number> } = {},
): {
  environment: ProcessContainmentEnvironment;
  now: () => number;
  signals: Array<{ pid: number; signal: NodeJS.Signals | 0; at: number }>;
} {
  let elapsedMs = 0;
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0; at: number }> = [];
  const isAlive = (pid: number): boolean => {
    if (pid === -containment.processGroupId) return state.groupAlive;
    if (pid === containment.pid) return state.leaderAlive;
    if (pid === providerRoot.pid) return state.providerRootAlive;
    return false;
  };

  return {
    now: () => elapsedMs,
    signals,
    environment: {
      clock: {
        now: () => elapsedMs,
        sleep: async (ms) => {
          elapsedMs += ms;
        },
      },
      process: {
        isAlive,
        kill: (pid, signal) => {
          signals.push({ pid, signal, at: elapsedMs });
          elapsedMs += options.signalCostMs ?? 0;
          if (signal === 'SIGKILL') {
            if (pid === -containment.processGroupId) state.groupAlive = false;
            if (pid === providerRoot.pid) state.providerRootAlive = false;
          }
          return isAlive(pid);
        },
      },
      platform: 'linux',
      readProcessStartedAtSeconds: (pid) => {
        if (options.unreadablePids?.has(pid)) return null;
        if (pid === containment.pid && state.leaderAlive) return containment.processStartedAtSeconds;
        if (pid === providerRoot.pid && state.providerRootAlive) return providerRoot.processStartedAtSeconds;
        return null;
      },
    },
  };
}

describe('recorded process containment', () => {
  it('uses TERM then KILL and confirms absence within one absolute deadline', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: true },
      { signalCostMs: 125 },
    );

    await reapRecordedContainment(containment, [providerRoot], 6_500, fake.environment);

    expect(fake.signals).toEqual([
      { pid: -100, signal: 'SIGTERM', at: 0 },
      { pid: 101, signal: 'SIGTERM', at: 125 },
      { pid: -100, signal: 'SIGKILL', at: 5_250 },
      { pid: 101, signal: 'SIGKILL', at: 5_375 },
    ]);
    expect(fake.now()).toBe(6_500);
  });

  it('does not give a late KILL step a fresh deadline', async () => {
    const state = { groupAlive: true, leaderAlive: true, providerRootAlive: true };
    const fake = createFakeEnvironment(state, { signalCostMs: 125 });

    await expect(reapRecordedContainment(containment, [providerRoot], 5_300, fake.environment)).rejects.toMatchObject({
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

    await reapRecordedContainment(containment, [], 7_000, fake.environment);

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

    await expect(reapRecordedContainment(containment, [], 10_000, fake.environment)).rejects.toMatchObject({
      code: 'process_containment_reap_failed',
      context: { callDurationMs: 501, limit: 500 },
    });
    expect(fake.signals).toEqual([{ pid: -100, signal: 'SIGTERM', at: 0 }]);
  });

  it('fails closed before signalling when a live process start time cannot be read', async () => {
    const fake = createFakeEnvironment(
      { groupAlive: true, leaderAlive: true, providerRootAlive: false },
      { unreadablePids: new Set([containment.pid]) },
    );

    const failure = await reapRecordedContainment(containment, [], 10_000, fake.environment).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ProcessContainmentError);
    expect(failure).toMatchObject({ code: 'process_identity_unverified' });
    expect(fake.signals).toEqual([]);
  });

  it('rejects provider root 129 before probing or signalling', async () => {
    let probed = false;
    const fake = createFakeEnvironment({ groupAlive: false, leaderAlive: false, providerRootAlive: false });
    const environment: ProcessContainmentEnvironment = {
      ...fake.environment,
      readProcessStartedAtSeconds: () => {
        probed = true;
        return null;
      },
    };
    const roots = Array.from({ length: MAX_PROXY_OPERATION_LEDGERS + 1 }, (_, index) => ({
      pid: 1_000 + index,
      processStartedAtSeconds: 1,
    }));

    await expect(reapRecordedContainment(containment, roots, 10_000, environment)).rejects.toMatchObject({
      code: 'process_containment_reap_failed',
    });
    expect(probed).toBe(false);
    expect(fake.signals).toEqual([]);
  });
});
