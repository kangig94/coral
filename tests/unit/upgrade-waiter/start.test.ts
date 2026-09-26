import { spawn } from 'node:child_process';
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
});
