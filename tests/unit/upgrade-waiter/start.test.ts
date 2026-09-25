import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestLegacyUpgrade } from '#src/upgrade-waiter/start.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';

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

describe('legacy upgrade request', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
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

  it('turns an incumbent-registered intent into a visible retirement wait', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-legacy-upgrade-'));
    directories.push(runDir);
    expect(await compareAndSwapUpgradeIntent(runDir, null, {
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
    })).toMatchObject({ kind: 'written' });
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));

    expect(await requestLegacyUpgrade({
      runDir,
      socketPath: '/legacy.sock',
      incumbent,
      target: { build, pluginRootLabel: '/installed/target' },
      startWaiter,
    })).toMatchObject({ kind: 'waiting', requestId: 'incumbent-request' });
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
});
