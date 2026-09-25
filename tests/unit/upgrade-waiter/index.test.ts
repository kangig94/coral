import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runUpgradeWaiter } from '#src/upgrade-waiter/index.js';
import {
  compareAndSwapUpgradeIntent,
  readUpgradeIntent,
  type UpgradeIntent,
  type UpgradeIntentChange,
} from '#src/infra/upgrade-intent.js';

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
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });

    expect(result).toEqual({ kind: 'completed' });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(readUpgradeIntent(dir)).toMatchObject({ kind: 'readable', intent: { disposition: 'completed' } });
  });

  it('releases an expired launch without claiming completion', async () => {
    const dir = runDir();
    await compareAndSwapUpgradeIntent(dir, null, pendingIntent());
    let time = Date.parse('2026-09-25T00:00:00.000Z');
    const observe = vi.fn().mockResolvedValue('retired');
    const launch = vi.fn(async () => undefined);
    const result = await runUpgradeWaiter({
      runDir: dir,
      socketPath: '/unused.sock',
      targetRoot: '/installed/target',
      validateTarget: () => true,
      observeRetirement: observe,
      launchTarget: launch,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    });
    expect(result).toEqual({ kind: 'expired' });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'deferred', attemptOwner: null, retryCondition: { kind: 'incumbent-retirement' } },
    });
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
      now: () => time,
      sleep: async (ms) => {
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
        now: () => now,
      }),
    ).toEqual({ kind: 'lease-held' });
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
      now: () => time,
      sleep: async (ms) => {
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
    });

    expect(result).toEqual({ kind: 'superseded' });
    expect(readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { attemptOwner: null, target: { pluginRootLabel: '/installed/newer' } },
    });
  });
});
