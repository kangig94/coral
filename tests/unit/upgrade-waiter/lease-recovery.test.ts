import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as UpgradeIntentModule from '#src/infra/upgrade-intent.js';

const attemptPause = vi.hoisted(() => {
  let reachedResolve: () => void = () => {};
  let release: () => void = () => {};
  const state = {
    enabled: false,
    crashOnPending: false,
    paused: false,
    reached: Promise.resolve(),
    blocked: Promise.resolve(),
    reset(): void {
      state.enabled = false;
      state.crashOnPending = false;
      state.paused = false;
      state.reached = new Promise<void>((resolve) => {
        reachedResolve = resolve;
      });
      state.blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    reach(): void {
      reachedResolve();
    },
    release(): void {
      release();
    },
  };
  state.reset();
  return state;
});

vi.mock('#src/infra/upgrade-intent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UpgradeIntentModule>();
  return {
    ...actual,
    compareAndSwapUpgradeIntent: async (...args: Parameters<typeof actual.compareAndSwapUpgradeIntent>) => {
      const result = await actual.compareAndSwapUpgradeIntent(...args);
      const change = args[2];
      if (
        attemptPause.crashOnPending &&
        result.kind === 'written' &&
        typeof change === 'object' &&
        change !== null &&
        'attemptSpawnPending' in change &&
        change.attemptSpawnPending === true
      ) {
        throw new Error('simulated crash after pending write');
      }
      if (
        attemptPause.enabled &&
        !attemptPause.paused &&
        typeof change === 'object' &&
        change !== null &&
        'disposition' in change &&
        change.disposition === 'attempting'
      ) {
        attemptPause.paused = true;
        attemptPause.reach();
        await attemptPause.blocked;
      }
      return result;
    },
  };
});

import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { createRealUpgradeWaiterPorts, type UpgradeWaiterPorts } from '#src/runtime/upgrade-waiter.js';
import { runUpgradeWaiter } from '#src/upgrade-waiter/index.js';

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

function pendingIntent() {
  return {
    requestId: 'request-1',
    incumbent: {
      instanceId: 'legacy',
      pid: 1234,
      incarnation: null,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod' as const,
    },
    target: { build, pluginRootLabel: '/installed/target' },
    attemptId: null,
    attemptOwner: null,
    disposition: 'pending' as const,
    blockers: [],
    retryCondition: { kind: 'incumbent-retirement' as const, evidence: 'idle exit' },
    attemptDeadline: null,
    completionReceipt: null,
  };
}

function waiterPorts(now: () => number, ids: readonly string[]): UpgradeWaiterPorts {
  let index = 0;
  return {
    ...createRealUpgradeWaiterPorts(),
    uuid: () => ids[index++] ?? 'unexpected-id',
    time: { now, sleep: async () => undefined },
  };
}

describe('upgrade waiter lease recovery', () => {
  const directories: string[] = [];

  afterEach(() => {
    attemptPause.reset();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('does not start a target after its expired attempt was replaced during a scheduler pause', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-red-upgrade-waiter-'));
    directories.push(runDir);
    expect(await compareAndSwapUpgradeIntent(runDir, null, pendingIntent())).toMatchObject({ kind: 'written' });

    let currentTime = Date.parse('2026-09-25T00:00:00.000Z');
    const firstLaunch = vi.fn(async () => undefined);
    attemptPause.enabled = true;
    const first = runUpgradeWaiter({
      runDir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'retired',
      launchTarget: firstLaunch,
      ports: waiterPorts(() => currentTime, ['first-waiter', 'first-attempt']),
    });
    await attemptPause.reached;
    attemptPause.enabled = false;
    currentTime += 30_001;

    const secondLaunch = vi.fn(async (intent: UpgradeIntent) => {
      const closed = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
        ...intent,
        disposition: 'closed',
      });
      expect(closed.kind).toBe('written');
    });
    await expect(
      runUpgradeWaiter({
        runDir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget: secondLaunch,
        ports: waiterPorts(() => currentTime, ['second-waiter', 'second-attempt']),
      }),
    ).resolves.toEqual({ kind: 'closed' });

    attemptPause.release();
    await expect(first).resolves.toEqual({ kind: 'closed' });
    expect(firstLaunch).not.toHaveBeenCalled();
    expect(secondLaunch).toHaveBeenCalledOnce();
  });

  it('does not reclaim an expired lease while its target spawn is unresolved', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-upgrade-spawn-pending-'));
    directories.push(runDir);
    expect(await compareAndSwapUpgradeIntent(runDir, null, pendingIntent())).toMatchObject({ kind: 'written' });

    let currentTime = Date.parse('2026-09-25T00:00:00.000Z');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launched!: () => void;
    const reached = new Promise<void>((resolve) => {
      launched = resolve;
    });
    const first = runUpgradeWaiter({
      runDir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: async () => 'retired',
      launchTarget: async () => {
        launched();
        await blocked;
        const current = readUpgradeIntent(runDir);
        if (current.kind !== 'readable') throw new Error('spawn claim was lost');
        await compareAndSwapUpgradeIntent(runDir, current.intent.revision, {
          ...current.intent,
          disposition: 'closed',
        });
      },
      ports: waiterPorts(() => currentTime, ['first-waiter', 'first-attempt']),
    });
    await reached;
    currentTime += 30_001;
    const secondLaunch = vi.fn(async () => undefined);
    await expect(
      runUpgradeWaiter({
        runDir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget: secondLaunch,
        ports: waiterPorts(() => currentTime, ['second-waiter', 'second-attempt']),
      }),
    ).resolves.toEqual({ kind: 'lease-held' });
    expect(secondLaunch).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toEqual({ kind: 'closed' });
  });

  it('completes an upgrade after the first waiter dies immediately after its pending write', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-upgrade-crash-after-pending-'));
    directories.push(runDir);
    await compareAndSwapUpgradeIntent(runDir, null, pendingIntent());
    let currentTime = Date.parse('2026-09-25T00:00:00.000Z');
    attemptPause.crashOnPending = true;
    const firstLaunch = vi.fn(async () => undefined);
    await expect(
      runUpgradeWaiter({
        runDir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget: firstLaunch,
        ports: {
          ...waiterPorts(() => currentTime, ['first-waiter', 'first-attempt', 'first-nonce']),
          pid: 999_999_991,
        },
      }),
    ).rejects.toThrow('simulated crash after pending write');
    expect(firstLaunch).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: { attemptId: 'first-attempt', attemptSpawnPending: true, attemptSpawnNonce: 'first-nonce' },
    });

    attemptPause.crashOnPending = false;
    currentTime += 30_001;
    const secondLaunch = vi.fn(async (intent: UpgradeIntent, attemptId: string, nonce: string) => {
      expect(nonce).toBe('second-nonce');
      const completed = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
        ...intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId,
          successor: { instanceId: 'successor', pid: process.pid, incarnation: null, build },
          epochKey: 'epoch-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(currentTime).toISOString(),
        },
      });
      expect(completed.kind).toBe('written');
    });
    await expect(
      runUpgradeWaiter({
        runDir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget: secondLaunch,
        ports: waiterPorts(() => currentTime, ['second-waiter', 'second-attempt', 'second-nonce']),
      }),
    ).resolves.toEqual({ kind: 'completed' });
    expect(secondLaunch).toHaveBeenCalledOnce();
  });

  it('attaches a live target to an expired pending spawn during inline recovery', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-inline-spawn-reconciliation-'));
    directories.push(runDir);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    const now = Date.parse('2026-09-25T00:00:30.001Z');
    await compareAndSwapUpgradeIntent(runDir, null, {
      ...pendingIntent(),
      attemptId: 'existing-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'dead-waiter', pid: 999_999_991, incarnation: null },
      attemptChild: null,
      attemptSpawnPending: true,
      attemptSpawnNonce: 'existing-nonce',
      disposition: 'attempting',
      attemptDeadline: new Date(now - 1).toISOString(),
    });
    const recordDir = join(runDir, 'coordinator-sentinel.v1');
    mkdirSync(recordDir);
    writeFileSync(
      join(recordDir, 'sentinel.json'),
      JSON.stringify({
        state: 'armed',
        attemptId: 'existing-attempt',
        spawnNonce: 'existing-nonce',
        sentinelPid: process.pid,
        sentinelIncarnation: incarnation,
        coordinatorPid: process.pid,
        coordinatorIncarnation: incarnation,
      }),
    );
    const launchTarget = vi.fn(async () => undefined);
    await expect(
      runUpgradeWaiter({
        runDir,
        socketPath: '/unused.sock',
        targetRoot: '/installed/target',
        validateTarget: () => true,
        observeRetirement: async () => 'retired',
        launchTarget,
        ports: waiterPorts(() => now, ['replacement-waiter', 'replacement-attempt']),
      }),
    ).resolves.toEqual({ kind: 'lease-held' });
    expect(launchTarget).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: {
        attemptSpawnPending: false,
        attemptChild: { attemptId: 'existing-attempt', pid: process.pid, incarnation },
      },
    });
  });
});
