import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runUpgradeWaiter } from '#src/upgrade-waiter/index.js';
import { createRealUpgradeWaiterPorts, type UpgradeWaiterPorts } from '#src/runtime/upgrade-waiter.js';
import {
  compareAndSwapUpgradeIntent,
  readUpgradeIntent,
  type UpgradeIntent,
  type UpgradeIntentChange,
} from '#src/infra/upgrade-intent.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const build = {
  version: '0.11.0',
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod' as const,
  storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

function pendingIntent(): UpgradeIntentChange {
  return {
    requestId: 'request-1',
    incumbent: {
      instanceId: 'legacy',
      pid: 1234,
      incarnation: null,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod',
    },
    target: { build, pluginRootLabel: '/installed/target' },
    attemptId: null,
    attemptOwner: null,
    disposition: 'pending',
    blockers: [],
    retryCondition: { kind: 'incumbent-retirement', evidence: 'idle exit' },
    attemptDeadline: null,
    completionReceipt: null,
  };
}

function expiredAttempt(): UpgradeIntentChange {
  return {
    requestId: 'request-1',
    incumbent: {
      instanceId: 'legacy',
      pid: 1234,
      incarnation: null,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod',
    },
    target: { build, pluginRootLabel: '/installed/target' },
    attemptId: 'expired-attempt',
    attemptOwner: { kind: 'waiter', instanceId: 'expired-waiter', pid: 2222, incarnation: null },
    attemptChild: { attemptId: 'expired-attempt', pid: 3333, incarnation: testIncarnation('expired-target') },
    disposition: 'deferred',
    blockers: [{ owner: 'waiter', reason: 'target did not report serving before attempt deadline' }],
    retryCondition: {
      kind: 'incumbent-retirement',
      evidence: 'legacy incumbent retired; successor attempt expired',
    },
    attemptDeadline: '2026-09-25T00:00:00.000Z',
    completionReceipt: null,
  };
}

function waiterPorts(
  now: () => number,
  sleep: (ms: number) => Promise<void> = async () => undefined,
): UpgradeWaiterPorts {
  return { ...createRealUpgradeWaiterPorts(), time: { now, sleep } };
}

describe('upgrade waiter', () => {
  const directories: string[] = [];
  function runDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'coral-upgrade-waiter-'));
    directories.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('launches after verified retirement without another contender and waits for serving', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    const observe = vi.fn().mockResolvedValueOnce('serving').mockResolvedValue('retired');
    const launch = vi.fn(async (intent: UpgradeIntent, attemptId: string) => {
      const written = await compareAndSwapUpgradeIntent(dir, intent.revision, {
        ...intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'successor', pid: 5678, incarnation: null, build },
          epochKey: 'epoch-1:lineage-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(time).toISOString(),
        },
      });
      expect(written.kind).toBe('written');
    });

    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: observe,
      launchTarget: launch,
      ports: waiterPorts(
        () => time,
        async (ms) => {
          time += ms;
        },
      ),
    });

    expect(result).toEqual({ kind: 'completed' });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(readUpgradeIntent(dir)).toMatchObject({ kind: 'readable', intent: { disposition: 'completed' } });
  });

  it('retries an expired launch without another contender', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    const observe = vi.fn().mockResolvedValue('retired');
    const launch = vi.fn(async (intent: UpgradeIntent, attemptId: string) => {
      if (launch.mock.calls.length === 1) return;
      const completed = await compareAndSwapUpgradeIntent(dir, intent.revision, {
        ...intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'successor', pid: 5678, incarnation: null, build },
          epochKey: 'epoch-1:lineage-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(time).toISOString(),
        },
      });
      expect(completed.kind).toBe('written');
    });
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: observe,
      launchTarget: launch,
      ports: waiterPorts(
        () => time,
        async (ms) => {
          time += ms;
        },
      ),
    });
    expect(result).toEqual({ kind: 'completed' });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'completed' },
    });
  });

  it('retries a transient target spawn failure after legacy retirement without another contender', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    let launches = 0;
    const ids = ['waiter', 'first-attempt', 'second-attempt'];
    const launch = vi.fn(async (intent: UpgradeIntent, attemptId: string) => {
      launches++;
      if (launches === 1) throw new Error('temporary process-table exhaustion');
      const completed = await compareAndSwapUpgradeIntent(dir, intent.revision, {
        ...intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'successor', pid: 5678, incarnation: null, build },
          epochKey: 'epoch-1:lineage-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(time).toISOString(),
        },
      });
      expect(completed.kind).toBe('written');
    });
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'retired',
      launchTarget: launch,
      ports: {
        ...waiterPorts(
          () => time,
          async (ms) => {
            time += ms;
          },
        ),
        uuid: () => ids.shift() ?? 'unexpected-id',
      },
    });
    expect(result).toEqual({ kind: 'completed' });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[0]?.[1]).not.toBe(launch.mock.calls[1]?.[1]);
  });

  it('releases an unrecorded attempt when the target disappears after launch', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    let targetAvailable = true;
    const launch = vi.fn(async () => undefined);
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => targetAvailable,
      observeRetirement: async () => 'retired',
      launchTarget: launch,
      ports: waiterPorts(
        () => time,
        async (ms) => {
          time += ms;
          if (launch.mock.calls.length > 0) targetAvailable = false;
        },
      ),
    });
    expect(result).toEqual({ kind: 'target-unavailable' });
    expect(launch).toHaveBeenCalledOnce();
    expect(readUpgradeIntent(dir)).toMatchObject({
      intent: { disposition: 'deferred', attemptId: null, attemptOwner: null },
    });
  });

  it('closes a pending upgrade when its only recorded target disappears before retirement', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent(),
      target: { build, pluginRootLabel: '/removed/target' },
    });

    await expect(
      runUpgradeWaiter({
        runDir: dir,
        socketPath: '/unused.sock',
        targetRoot: '/removed/target',
        validateTarget: () => false,
        ports: createRealUpgradeWaiterPorts(),
      }),
    ).resolves.toEqual({ kind: 'closed' });

    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'closed', retryCondition: null, attemptId: null, attemptOwner: null },
    });
  });

  it('closes an unlaunched claim when its target disappears', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let polls = 0;
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => (polls > 0 ? false : true),
      observeRetirement: async () => 'serving',
      ports: waiterPorts(
        () => Date.parse('2026-09-25T00:00:00.000Z'),
        async () => {
          polls++;
        },
      ),
    });

    expect(result).toEqual({ kind: 'closed' });
    expect(readUpgradeIntent(dir)).toMatchObject({
      intent: { disposition: 'closed', retryCondition: null, attemptId: null, attemptOwner: null },
    });
  });

  it('waits for a recorded child after expiry without launching another successor', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    let launchedAttemptId: string | null = null;
    const incarnation = waiterPorts(() => time).processIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    let deferredPolls = 0;
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'retired',
      launchTarget: async (intent, attemptId) => {
        launchedAttemptId = attemptId;
        const recorded = await compareAndSwapUpgradeIntent(dir, intent.revision, {
          ...intent,
          attemptChild: { attemptId, pid: process.pid, incarnation },
        });
        expect(recorded.kind).toBe('written');
      },
      ports: waiterPorts(
        () => time,
        async (ms) => {
          time += ms;
          const observed = readUpgradeIntent(dir);
          if (observed.kind !== 'readable' || observed.intent.disposition !== 'deferred') return;
          if (++deferredPolls !== 2) return;
          const closed = await compareAndSwapUpgradeIntent(dir, observed.intent.revision, {
            ...observed.intent,
            disposition: 'closed',
          });
          expect(closed.kind).toBe('written');
        },
      ),
    });
    expect(result).toEqual({ kind: 'closed' });
    expect(deferredPolls).toBe(2);
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: {
        disposition: 'closed',
        attemptId: null,
        attemptChild: { attemptId: launchedAttemptId },
      },
    });
  });

  it('retries an expired recorded child only after proving it absent', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    let childAlive = true;
    let deferredPolls = 0;
    const ids = ['waiter', 'first-attempt', 'second-attempt'];
    const attempts: string[] = [];
    const launch = vi.fn(async (intent: UpgradeIntent, attemptId: string) => {
      attempts.push(attemptId);
      if (attempts.length === 1) {
        const recorded = await compareAndSwapUpgradeIntent(dir, intent.revision, {
          ...intent,
          attemptChild: { attemptId, pid: 3333, incarnation: testIncarnation('expired-target') },
        });
        expect(recorded.kind).toBe('written');
        return;
      }
      expect(childAlive).toBe(false);
      const completed = await compareAndSwapUpgradeIntent(dir, intent.revision, {
        ...intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'successor', pid: 5678, incarnation: null, build },
          epochKey: 'epoch-1:lineage-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(time).toISOString(),
        },
      });
      expect(completed.kind).toBe('written');
    });
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'retired',
      launchTarget: launch,
      ports: {
        ...waiterPorts(
          () => time,
          async (ms) => {
            time += ms;
            const observed = readUpgradeIntent(dir);
            if (observed.kind === 'readable' && observed.intent.disposition === 'deferred' && ++deferredPolls === 2) {
              childAlive = false;
            }
          },
        ),
        uuid: () => ids.shift() ?? 'unexpected-id',
        processIncarnation: () => null,
        processLiveness: (pid) => (pid === 3333 && childAlive ? 'alive' : 'absent'),
      },
    });
    expect(result).toEqual({ kind: 'completed' });
    expect(deferredPolls).toBeGreaterThanOrEqual(2);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(attempts[0]).not.toBe(attempts[1]);
  });

  it('keeps an unanswered incumbent observation from authorizing launch', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    let polls = 0;
    const launch = vi.fn(async () => undefined);
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'unknown',
      launchTarget: launch,
      ports: waiterPorts(
        () => time,
        async (ms) => {
          time += ms;
          if (++polls === 5) {
            const observed = readUpgradeIntent(dir);
            if (observed.kind !== 'readable') throw new Error('intent disappeared');
            await compareAndSwapUpgradeIntent(dir, observed.intent.revision, {
              ...observed.intent,
              disposition: 'closed',
              attemptId: null,
              attemptOwner: null,
              attemptDeadline: null,
            });
          }
        },
      ),
    });
    expect(result).toEqual({ kind: 'closed' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('leaves a live waiter lease with its recorded owner', async () => {
    const dir = runDir();
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent(),
      attemptId: 'other-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'other', pid: 2222, incarnation: null },
      attemptDeadline: new Date(now + 30_000).toISOString(),
    });
    const launch = vi.fn(async () => undefined);
    expect(
      await runUpgradeWaiter({
        runDir: dir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        launchTarget: launch,
        ports: waiterPorts(() => now),
      }),
    ).toEqual({ kind: 'lease-held' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('takes over an expired live waiter lease when no attempt child may serve', async () => {
    const dir = runDir();
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent(),
      attemptId: 'stalled-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'stalled-waiter', pid: process.pid, incarnation: null },
      attemptDeadline: new Date(now - 1).toISOString(),
    });
    const launch = vi.fn(async (intent: UpgradeIntent, attemptId: string) => {
      const completed = await compareAndSwapUpgradeIntent(dir, intent.revision, {
        ...intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'successor', pid: 5678, incarnation: null, build },
          epochKey: 'epoch-1:lineage-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(now).toISOString(),
        },
      });
      expect(completed.kind).toBe('written');
    });

    await expect(
      runUpgradeWaiter({
        runDir: dir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget: launch,
        ports: waiterPorts(() => now),
      }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(launch).toHaveBeenCalledOnce();
  });

  it('keeps an expired lease while its recorded attempt child may serve', async () => {
    const dir = runDir();
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    const incarnation = waiterPorts(() => now).processIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    await compareAndSwapUpgradeIntent(dir, null, {
      ...pendingIntent(),
      attemptId: 'serving-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'stalled-waiter', pid: process.pid, incarnation: null },
      attemptChild: { attemptId: 'serving-attempt', pid: process.pid, incarnation },
      attemptDeadline: new Date(now - 1).toISOString(),
    });
    const launch = vi.fn(async () => undefined);

    await expect(
      runUpgradeWaiter({
        runDir: dir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        launchTarget: launch,
        ports: waiterPorts(() => now),
      }),
    ).resolves.toEqual({ kind: 'lease-held' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('exits when another waiter takes over its expired claim', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    let polls = 0;
    const launch = vi.fn(async () => undefined);
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'retired',
      launchTarget: launch,
      ports: waiterPorts(
        () => now,
        async () => {
          if (++polls !== 1) return;
          const observed = readUpgradeIntent(dir);
          if (observed.kind !== 'readable') throw new Error('intent disappeared');
          const taken = await compareAndSwapUpgradeIntent(dir, observed.intent.revision, {
            ...observed.intent,
            attemptId: 'replacement-attempt',
            attemptOwner: { kind: 'waiter', instanceId: 'replacement', pid: process.pid, incarnation: null },
          });
          expect(taken.kind).toBe('written');
        },
      ),
    });
    expect(result).toEqual({ kind: 'superseded' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('releases its lease when a newer target supersedes it', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    let changed = false;
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'serving',
      ports: waiterPorts(
        () => time,
        async (ms) => {
          time += ms;
          if (changed) return;
          changed = true;
          const observed = readUpgradeIntent(dir);
          if (observed.kind !== 'readable') throw new Error('intent not readable');
          await compareAndSwapUpgradeIntent(dir, observed.intent.revision, {
            ...observed.intent,
            target: {
              build: { ...build, version: '0.12.0' },
              pluginRootLabel: '/installed/newer',
            },
          });
        },
      ),
    });

    expect(result).toEqual({ kind: 'superseded' });
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { attemptOwner: null, target: { pluginRootLabel: '/installed/newer' } },
    });
  });

  it('reclaims an expired attempt when its recorded target is decisively absent', async () => {
    const dir = runDir();
    const seeded = await compareAndSwapUpgradeIntent(dir, null, expiredAttempt());
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);

    const realPorts = createRealUpgradeWaiterPorts();
    const ids = ['replacement-waiter', 'replacement-attempt'];
    const launch = vi.fn(async (intent, attemptId) => {
      const completed = await compareAndSwapUpgradeIntent(dir, intent.revision, {
        ...intent,
        attemptChild: null,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'replacement-target', pid: 4444, incarnation: null, build },
          epochKey: 'epoch-1:lineage-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: '2026-09-25T00:00:01.000Z',
        },
      });
      expect(completed.kind).toBe('written');
    });

    await expect(
      runUpgradeWaiter({
        runDir: dir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget: launch,
        ports: {
          ...realPorts,
          pid: 4444,
          uuid: () => ids.shift() ?? 'unexpected-id',
          processIncarnation: () => null,
          processLiveness: () => 'absent',
          pathAbsent: () => true,
          time: { now: () => Date.parse('2026-09-25T00:00:01.000Z'), sleep: async () => {} },
        },
      }),
    ).resolves.toEqual({ kind: 'completed' });

    expect(launch).toHaveBeenCalledOnce();
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'completed', attemptId: 'replacement-attempt' },
    });
  });

  it('keeps an expired recorded target when its death cannot be proven', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, expiredAttempt());
    const ports = createRealUpgradeWaiterPorts();
    const launch = vi.fn(async () => undefined);

    let polls = 0;
    expect(
      await runUpgradeWaiter({
        runDir: dir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget: launch,
        ports: {
          ...ports,
          processIncarnation: () => null,
          processLiveness: () => 'unknown',
          time: {
            now: () => Date.parse('2026-09-25T00:00:01.000Z'),
            sleep: async () => {
              if (++polls !== 2) return;
              const observed = readUpgradeIntent(dir);
              if (observed.kind !== 'readable') throw new Error('intent disappeared');
              const closed = await compareAndSwapUpgradeIntent(dir, observed.intent.revision, {
                ...observed.intent,
                disposition: 'closed',
              });
              expect(closed.kind).toBe('written');
            },
          },
        },
      }),
    ).toEqual({ kind: 'closed' });
    expect(launch).not.toHaveBeenCalled();
    expect(polls).toBe(2);
    expect(readUpgradeIntent(dir)).toMatchObject({ intent: { attemptId: 'expired-attempt' } });
  });
});
