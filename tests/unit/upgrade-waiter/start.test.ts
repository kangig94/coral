import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestLegacyUpgrade, startUpgradeWaiter } from '#src/upgrade-waiter/start.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { createRealUpgradeWaiterPorts } from '#src/runtime/upgrade-waiter.js';
import type * as UpgradeIntentModule from '#src/infra/upgrade-intent.js';
import type * as HandoffTargetModule from '#src/infra/handoff-target.js';

const installedTargets = vi.hoisted(() => new Set<string>());
const waiterTargets = vi.hoisted(() => new Set<string>());
vi.mock('#src/infra/handoff-target.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HandoffTargetModule>();
  return {
    ...actual,
    waiterExecutableReady: (root: string) => waiterTargets.has(root) || actual.waiterExecutableReady(root),
  };
});
vi.mock('#src/infra/upgrade-intent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UpgradeIntentModule>();
  return {
    ...actual,
    revalidateUpgradeIntentTarget: (intent: UpgradeIntent) =>
      installedTargets.has(intent.target.pluginRootLabel)
        ? { kind: 'validated', target: {} }
        : actual.revalidateUpgradeIntentTarget(intent),
  };
});

const incumbent = {
  instanceId: 'legacy',
  pid: 1234,
  incarnation: null,
  version: '0.10.13',
  bundleHash: 'fedcba9876543210',
  flavor: 'prod' as const,
};
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

/** A pid whose process has exited, so its absence is decisive. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (child.pid === undefined) throw new Error('exited child has no pid');
  return child.pid;
}

describe('legacy upgrade request', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    installedTargets.clear();
    waiterTargets.clear();
  });

  it.each(['completed', 'closed'] as const)('does not archive an already %s attempt', async (disposition) => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    installedTargets.add('/installed/target');
    const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'old-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'served-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'old-waiter', pid: 1234, incarnation: null },
      disposition,
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt:
        disposition === 'completed'
          ? {
              kind: 'serving',
              attemptId: 'served-attempt',
              successor: { instanceId: 'successor', pid: 1234, incarnation: null, build },
              epochKey: 'epoch-key',
              controlGeneration: 1,
              acceptedObligations: [],
              recordedAt: new Date().toISOString(),
            }
          : null,
    });
    if (seeded.kind !== 'written') throw new Error(`intent seed was ${seeded.kind}`);

    await requestLegacyUpgrade({
      runDir,
      socketPath: '/legacy.sock',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      startWaiter: async () => ({ kind: 'started', pid: 5678 }),
    });

    const observed = readUpgradeIntent(runDir);
    expect(observed.kind).toBe('readable');
    if (observed.kind !== 'readable') return;
    expect(observed.intent.requestId).not.toBe('old-request');
    expect(observed.intent.supersededAttempts ?? []).toEqual([]);
  });

  it.each(['0.11.0', '0.10.50'])(
    'replaces a vanished target with an installed %s legacy-waiter target',
    async (version) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
      directories.push(runDir);
      await compareAndSwapUpgradeIntent(runDir, null, {
        requestId: 'vanished-request',
        incumbent,
        target: { build, pluginRootLabel: '/missing/target' },
        attemptId: null,
        attemptOwner: null,
        disposition: 'pending',
        blockers: [],
        retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting' },
        attemptDeadline: null,
        completionReceipt: null,
      });
      installedTargets.add('/installed/replacement');
      const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

      expect(
        await requestLegacyUpgrade({
          runDir,
          socketPath: '/legacy.sock',
          incumbent,
          target: { build: { ...build, version }, pluginRootLabel: '/installed/replacement' },
          startWaiter,
        }),
      ).toMatchObject({ kind: 'waiting' });
      expect(startWaiter).toHaveBeenCalledWith(expect.objectContaining({ targetRoot: '/installed/replacement' }));
      expect(readUpgradeIntent(runDir)).toMatchObject({
        intent: { target: { pluginRootLabel: '/installed/replacement' } },
      });
    },
  );

  it('reclaims a proven-dead waiter lease before its deadline when no attempt child is live', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    waiterTargets.add('/installed/target');
    const deadPid = await exitedPid();
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'waiting-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'dead-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'dead-waiter', pid: deadPid, incarnation: null },
      disposition: 'pending',
      blockers: [],
      retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting' },
      attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
      completionReceipt: null,
    });
    const realPorts = createRealUpgradeWaiterPorts();
    const launchDetached = vi.fn(async () => {
      const observed = readUpgradeIntent(runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      expect(observed.intent.attemptOwner).toBeNull();
      const claimed = await compareAndSwapUpgradeIntent(runDir, observed.intent.revision, {
        ...observed.intent,
        attemptId: 'new-attempt',
        attemptOwner: {
          kind: 'waiter',
          instanceId: 'new-waiter',
          pid: process.pid,
          incarnation: probeProcessIncarnation(process.pid),
        },
        attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(claimed.kind).toBe('written');
      return process.pid;
    });

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        ports: { ...realPorts, launchDetached },
      }),
    ).toMatchObject({ kind: 'waiting', requestId: 'waiting-request', waiter: { kind: 'started', pid: process.pid } });
    expect(launchDetached).toHaveBeenCalledOnce();
  });

  it('reclaims an expired live waiter lease when no attempt child may serve', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    waiterTargets.add('/installed/target');
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'waiting-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'stalled-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'stalled-waiter', pid: process.pid, incarnation: null },
      disposition: 'pending',
      blockers: [],
      retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting' },
      attemptDeadline: new Date(Date.now() - 1).toISOString(),
      completionReceipt: null,
    });
    const launchDetached = vi.fn(async () => {
      const observed = readUpgradeIntent(runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      expect(observed.intent.attemptOwner).toBeNull();
      const claimed = await compareAndSwapUpgradeIntent(runDir, observed.intent.revision, {
        ...observed.intent,
        attemptId: 'replacement-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'replacement', pid: process.pid, incarnation: null },
        attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
      });
      expect(claimed.kind).toBe('written');
      return process.pid;
    });

    await expect(
      startUpgradeWaiter({
        runDir,
        socketPath: '/legacy.sock',
        targetRoot: '/installed/target',
        ports: { ...createRealUpgradeWaiterPorts(), launchDetached },
      }),
    ).resolves.toEqual({ kind: 'started', pid: process.pid });
    expect(launchDetached).toHaveBeenCalledOnce();
  });

  it.each([0, -1])('replaces an unrecorded target attempt at deadline offset %i ms', async (offset) => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    waiterTargets.add('/installed/target');
    const now = Date.now();
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'waiting-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'unrecorded-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'dead-waiter', pid: await exitedPid(), incarnation: null },
      attemptChild: null,
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(now + offset).toISOString(),
      completionReceipt: null,
    });
    const launchDetached = vi.fn(async () => {
      const observed = readUpgradeIntent(runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      expect(observed.intent).toMatchObject({ attemptId: null, attemptOwner: null, attemptChild: null });
      const claimed = await compareAndSwapUpgradeIntent(runDir, observed.intent.revision, {
        ...observed.intent,
        attemptId: 'replacement-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'replacement', pid: process.pid, incarnation: null },
        attemptDeadline: new Date(now + 30_000).toISOString(),
      });
      expect(claimed.kind).toBe('written');
      return process.pid;
    });

    await expect(
      startUpgradeWaiter({
        runDir,
        socketPath: '/legacy.sock',
        targetRoot: '/installed/target',
        ports: {
          ...createRealUpgradeWaiterPorts(),
          time: { now: () => now, sleep: async () => undefined },
          launchDetached,
        },
      }),
    ).resolves.toEqual({ kind: 'started', pid: process.pid });
  });

  it('keeps an expired live waiter lease while its recorded attempt child may serve', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'waiting-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'live-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'stalled-waiter', pid: process.pid, incarnation },
      attemptChild: { attemptId: 'live-attempt', pid: process.pid, incarnation },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(Date.now() - 1).toISOString(),
      completionReceipt: null,
    });
    const launchDetached = vi.fn(async () => process.pid);

    await expect(
      startUpgradeWaiter({
        runDir,
        socketPath: '/legacy.sock',
        targetRoot: '/installed/target',
        ports: { ...createRealUpgradeWaiterPorts(), launchDetached },
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'recorded attempt child may still serve' });
    expect(launchDetached).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { attemptId: 'live-attempt' } });
  });

  it("keeps a dead waiter's lease while its recorded attempt child is alive", async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const deadPid = await exitedPid();
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'waiting-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'live-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'dead-waiter', pid: deadPid, incarnation: null },
      attemptChild: { attemptId: 'live-attempt', pid: process.pid, incarnation },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
      completionReceipt: null,
    });
    const launchDetached = vi.fn(async () => process.pid);

    expect(
      await startUpgradeWaiter({
        runDir,
        socketPath: '/legacy.sock',
        targetRoot: '/installed/target',
        ports: { ...createRealUpgradeWaiterPorts(), launchDetached },
      }),
    ).toMatchObject({ kind: 'unavailable', reason: 'recorded attempt child may still serve' });
    expect(launchDetached).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { attemptId: 'live-attempt' } });
  });

  it('keeps a valid recorded legacy target over a lower contender', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'current-request',
      incumbent,
      target: { build, pluginRootLabel: '/installed/current' },
      attemptId: null,
      attemptOwner: null,
      disposition: 'pending',
      blockers: [],
      retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting' },
      attemptDeadline: null,
      completionReceipt: null,
    });
    installedTargets.add('/installed/current');
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build: { ...build, version: '0.10.50' }, pluginRootLabel: '/installed/lower' },
        startWaiter,
      }),
    ).toMatchObject({ kind: 'waiting', requestId: 'current-request' });
    expect(startWaiter).toHaveBeenCalledWith(expect.objectContaining({ targetRoot: '/installed/current' }));
  });

  it('records a pending retirement intent before awaiting the waiter claim', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const startWaiter = vi.fn(async () => {
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable',
        intent: { disposition: 'pending', retryCondition: { kind: 'incumbent-retirement' } },
      });
      return { kind: 'started' as const, pid: 5678 };
    });

    const result = await requestLegacyUpgrade({
      runDir,
      socketPath: '/legacy.sock',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      startWaiter,
    });

    expect(result).toMatchObject({ kind: 'waiting', waiter: { kind: 'started', pid: 5678 } });
    expect(startWaiter).toHaveBeenCalledOnce();
  });

  it.each(['null', 'throws'])('keeps the contender retrying until a waiter claims after spawn %s', async (failure) => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    installedTargets.add('/installed/target');
    waiterTargets.add('/installed/target');
    const realPorts = createRealUpgradeWaiterPorts();
    let now = Date.now();
    let launches = 0;
    const launchDetached = vi.fn(async () => {
      if (++launches === 1) {
        if (failure === 'throws') throw new Error('temporary spawn failure');
        return null;
      }
      const observed = readUpgradeIntent(runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      const claimed = await compareAndSwapUpgradeIntent(runDir, observed.intent.revision, {
        ...observed.intent,
        blockers: observed.intent.blockers.filter((entry) => entry.owner !== 'upgrade-contender'),
        attemptId: 'claimed-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: process.pid, incarnation: null },
        attemptDeadline: new Date(now + 30_000).toISOString(),
      });
      expect(claimed.kind).toBe('written');
      return process.pid;
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        ports: { ...realPorts, launchDetached, time: { now: () => now, sleep } },
      }),
    ).toMatchObject({ kind: 'waiting', waiter: { kind: 'started', pid: process.pid } });
    expect(launchDetached).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: { attemptOwner: { kind: 'waiter' }, blockers: [] },
    });
  });

  it('stops retrying waiter startup when the installed target disappears', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    installedTargets.add('/installed/target');
    waiterTargets.add('/installed/target');
    const launchDetached = vi.fn(async () => {
      installedTargets.delete('/installed/target');
      return null;
    });
    const realPorts = createRealUpgradeWaiterPorts();
    const result = await requestLegacyUpgrade({
      runDir,
      socketPath: '/legacy.sock',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      ports: {
        ...realPorts,
        launchDetached,
        time: { now: () => Date.now(), sleep: async () => undefined },
      },
    });
    expect(result).toEqual({ kind: 'refused', reason: 'target root no longer validates', disposition: 'deferred' });
    expect(launchDetached).toHaveBeenCalledOnce();
  });

  it('turns an incumbent-registered intent into a visible retirement wait', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    expect(
      await compareAndSwapUpgradeIntent(runDir, null, {
        requestId: 'incumbent-request',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        attemptId: null,
        attemptOwner: null,
        disposition: 'pending',
        blockers: [],
        retryCondition: null,
        attemptDeadline: null,
        completionReceipt: null,
      }),
    ).toMatchObject({ kind: 'written' });
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        startWaiter,
      }),
    ).toMatchObject({ kind: 'waiting', requestId: 'incumbent-request' });
    expect(readUpgradeIntent(runDir)).toMatchObject({
      kind: 'readable',
      intent: { retryCondition: { kind: 'incumbent-retirement' } },
    });
  });

  it('does not schedule an equal-version or older target', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));
    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build: { ...build, version: incumbent.version }, pluginRootLabel: '/installed/target' },
        startWaiter,
      }),
    ).toMatchObject({ kind: 'refused' });
    expect(readUpgradeIntent(runDir)).toEqual({ kind: 'absent' });
    expect(startWaiter).not.toHaveBeenCalled();
  });

  it.each([
    ['no attempt', {}],
    [
      'an expired waiter lease',
      {
        attemptId: 'expired-attempt',
        attemptOwner: { kind: 'waiter' as const, instanceId: 'waiter', pid: 2222, incarnation: null },
        disposition: 'attempting' as const,
        attemptDeadline: '2026-09-24T00:00:00.000Z',
      },
    ],
  ])(
    'should replace an intent naming an incumbent proven gone, with %s, by the incumbent that now serves',
    async (_case, attempt) => {
      const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
      directories.push(runDir);
      const retired = { ...incumbent, instanceId: 'retired', pid: await exitedPid() };
      expect(
        await compareAndSwapUpgradeIntent(runDir, null, {
          requestId: 'retired-request',
          incumbent: retired,
          target: { build, pluginRootLabel: '/installed/target' },
          attemptId: null,
          attemptOwner: null,
          disposition: 'pending',
          blockers: [],
          retryCondition: { kind: 'incumbent-retirement', evidence: 'idle exit' },
          attemptDeadline: null,
          completionReceipt: null,
          ...attempt,
        }),
      ).toMatchObject({ kind: 'written' });
      const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

      const result = await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        startWaiter,
      });

      expect(result).toMatchObject({ kind: 'waiting' });
      expect(result).not.toMatchObject({ requestId: 'retired-request' });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable',
        intent: { incumbent: { instanceId: 'legacy' }, disposition: 'pending', attemptId: null },
      });
    },
  );

  it('replaces an exited incumbent intent whose unexpired waiter lease belongs to a dead process', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const retired = { ...incumbent, instanceId: 'retired', pid: await exitedPid() };
    const deadWaiterPid = await exitedPid();
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'retired-request',
      incumbent: retired,
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'dead-attempt',
      attemptOwner: { kind: 'waiter', instanceId: 'dead-waiter', pid: deadWaiterPid, incarnation: null },
      disposition: 'pending',
      blockers: [],
      retryCondition: { kind: 'incumbent-retirement', evidence: 'waiting' },
      attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
      completionReceipt: null,
    });
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        startWaiter,
      }),
    ).toMatchObject({ kind: 'waiting' });
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { incumbent: { instanceId: 'legacy' } } });
  });

  it('starts a waiter for a replacement legacy incumbent after the old incumbent and child die', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const deadPid = await exitedPid();
    await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'dead-attempt-request',
      incumbent: { ...incumbent, instanceId: 'retired', pid: deadPid },
      target: { build, pluginRootLabel: '/installed/target' },
      attemptId: 'dead-attempt',
      attemptOwner: { kind: 'incumbent', instanceId: 'retired', pid: deadPid, incarnation: null },
      attemptChild: { attemptId: 'dead-attempt', pid: deadPid, incarnation: probeProcessIncarnation(process.pid)! },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
      successionPreparation: { attemptId: 'dead-attempt', stage: 'prepared', receipts: [] },
    });
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        startWaiter,
      }),
    ).toMatchObject({ kind: 'waiting' });
    expect(startWaiter).toHaveBeenCalledOnce();
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: {
        incumbent: { instanceId: 'legacy' },
        attemptChild: null,
        successionPreparation: null,
        supersededAttempts: [{ successionPreparation: { attemptId: 'dead-attempt' } }],
      },
    });
  });

  it('returns a visible deferral after repeated waiter claim failures', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    installedTargets.add('/installed/target');
    const startWaiter = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'unavailable',
        reason: 'waiter did not claim the intent before the startup deadline',
      })
      .mockResolvedValueOnce({
        kind: 'unavailable',
        reason: 'waiter did not claim the intent before the startup deadline',
      })
      .mockRejectedValueOnce(new Error('unbounded third launch'));
    const realPorts = createRealUpgradeWaiterPorts();

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        startWaiter,
        ports: { ...realPorts, time: { now: () => Date.now(), sleep: async () => undefined } },
      }),
    ).toEqual({
      kind: 'refused',
      reason: 'waiter did not claim the intent before the startup deadline',
      disposition: 'deferred',
    });
    expect(startWaiter).toHaveBeenCalledTimes(2);
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: { disposition: 'deferred', blockers: [{ owner: 'upgrade-contender' }] },
    });
  });

  it('defers a valid backend target whose waiter bundle is missing', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    installedTargets.add('/installed/target');
    const realPorts = createRealUpgradeWaiterPorts();
    const launchDetached = vi.fn(async () => process.pid);

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        ports: {
          ...realPorts,
          launchDetached,
          time: { now: () => Date.now(), sleep: async () => undefined },
        },
      }),
    ).toEqual({ kind: 'refused', reason: 'waiter bundle is unavailable', disposition: 'deferred' });
    expect(launchDetached).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: {
        disposition: 'deferred',
        retryCondition: { kind: 'incumbent-retirement' },
        blockers: [{ owner: 'upgrade-contender', reason: 'waiter bundle is unavailable' }],
      },
    });
    waiterTargets.add('/installed/target');
    launchDetached.mockImplementation(async () => {
      const observed = readUpgradeIntent(runDir);
      if (observed.kind !== 'readable') throw new Error('intent disappeared');
      const claimed = await compareAndSwapUpgradeIntent(runDir, observed.intent.revision, {
        ...observed.intent,
        blockers: [],
        attemptId: 'retried-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'retried-waiter', pid: process.pid, incarnation: null },
        attemptDeadline: new Date(Date.now() + 30_000).toISOString(),
      });
      if (claimed.kind !== 'written') throw new Error('waiter did not claim');
      return process.pid;
    });
    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        ports: {
          ...realPorts,
          launchDetached,
          time: { now: () => Date.now(), sleep: async () => undefined },
        },
      }),
    ).toMatchObject({ kind: 'waiting', waiter: { kind: 'started', pid: process.pid } });
  });

  it('should refuse to replace an intent whose recorded incumbent may still be alive', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    expect(
      await compareAndSwapUpgradeIntent(runDir, null, {
        requestId: 'live-request',
        incumbent: { ...incumbent, instanceId: 'other', pid: process.pid },
        target: { build, pluginRootLabel: '/installed/target' },
        attemptId: null,
        attemptOwner: null,
        disposition: 'pending',
        blockers: [],
        retryCondition: { kind: 'incumbent-retirement', evidence: 'idle exit' },
        attemptDeadline: null,
        completionReceipt: null,
      }),
    ).toMatchObject({ kind: 'written' });
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        startWaiter,
      }),
    ).toEqual({ kind: 'refused', reason: 'pending intent names another incumbent', disposition: 'deferred' });
    expect(startWaiter).not.toHaveBeenCalled();
  });

  it('keeps an expired attempt while its recorded target may still serve', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const retired = { ...incumbent, instanceId: 'retired', pid: await exitedPid() };
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    expect(
      await compareAndSwapUpgradeIntent(runDir, null, {
        requestId: 'retired-request',
        incumbent: retired,
        target: { build, pluginRootLabel: '/installed/target' },
        attemptId: 'expired-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: 2222, incarnation: null },
        attemptChild: { attemptId: 'expired-attempt', pid: process.pid, incarnation },
        disposition: 'deferred',
        blockers: [{ owner: 'waiter', reason: 'target did not report serving before attempt deadline' }],
        retryCondition: { kind: 'incumbent-retirement', evidence: 'successor attempt expired' },
        attemptDeadline: '2026-09-24T00:00:00.000Z',
        completionReceipt: null,
      }),
    ).toMatchObject({ kind: 'written' });
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        startWaiter,
      }),
    ).toEqual({ kind: 'refused', reason: 'pending intent names another incumbent', disposition: 'deferred' });
    expect(startWaiter).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { attemptId: 'expired-attempt' } });
  });

  it('keeps a recorded target when the same incumbent requests a newer build', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('test process has no incarnation');
    expect(
      await compareAndSwapUpgradeIntent(runDir, null, {
        requestId: 'active-request',
        incumbent,
        target: { build, pluginRootLabel: '/installed/target' },
        attemptId: 'active-attempt',
        attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: 2222, incarnation: null },
        attemptChild: { attemptId: 'active-attempt', pid: process.pid, incarnation },
        disposition: 'attempting',
        blockers: [],
        retryCondition: null,
        attemptDeadline: '2026-09-24T00:00:00.000Z',
        completionReceipt: null,
      }),
    ).toMatchObject({ kind: 'written' });
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(
      await requestLegacyUpgrade({
        runDir,
        socketPath: '/legacy.sock',
        incumbent,
        target: { build: { ...build, version: '0.12.0' }, pluginRootLabel: '/installed/newer' },
        startWaiter,
      }),
    ).toMatchObject({ kind: 'refused', disposition: 'deferred' });
    expect(startWaiter).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toMatchObject({
      intent: { requestId: 'active-request', attemptId: 'active-attempt' },
    });
  });
});
