import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requestUpgradeFromContender,
  settleContenderUpgrade,
  UpgradeWaiterUnavailableError,
} from '#src/coordinator/handoff.js';
import { createRealTimePort } from '#src/infra/time.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { recordContenderDeferral, requestLegacyUpgrade } from '#src/upgrade-waiter/start.js';

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

describe('contender upgrade request', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture(version = '0.10.13') {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-contender-upgrade-'));
    directories.push(runDir);
    const startWaiter = vi.fn(async () => ({ kind: 'started' as const, pid: 5678 }));
    const startLegacy = vi.fn((options: Parameters<typeof requestLegacyUpgrade>[0]) =>
      requestLegacyUpgrade({ ...options, startWaiter }),
    );
    const options = {
      runDir,
      socketPath: '/incumbent.sock',
      incumbent: { pid: 1234, source: 'discovery' as const, instanceId: 'incumbent', bootToken: 'boot' },
      health: {
        version,
        instanceId: 'incumbent',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod' as const,
        namespace: 'incumbent',
        status: 'ok' as const,
      },
      target: { build, pluginRootLabel: '/installed/target' },
      requestId: 'request-1',
      time: createRealTimePort(),
      startLegacy,
    };
    return { options, startLegacy, startWaiter, runDir };
  }

  it('records legacy intent and starts a waiter when the incumbent lacks succession RPC', async () => {
    const { options, startWaiter, runDir } = fixture();
    const result = await requestUpgradeFromContender({
      ...options,
      request: vi.fn(async () => {
        throw new Error('method absent');
      }),
    });

    expect(result).toMatchObject({ kind: 'waiting', waiter: { kind: 'started', pid: 5678 } });
    expect(startWaiter).toHaveBeenCalledOnce();
    expect(readUpgradeIntent(runDir)).toMatchObject({
      kind: 'readable',
      intent: { incumbent: { instanceId: 'incumbent' }, retryCondition: { kind: 'incumbent-retirement' } },
    });
  });

  it('starts a waiter when a responding incumbent cannot commit the target', async () => {
    const { options, startWaiter } = fixture();
    const result = await requestUpgradeFromContender({
      ...options,
      request: vi.fn(async () => ({ kind: 'registered', incumbentCanCommit: false })),
    });

    expect(result.kind).toBe('waiting');
    expect(startWaiter).toHaveBeenCalledOnce();
  });

  it('leaves a commit-capable incumbent to reconcile and never starts a waiter', async () => {
    const { options, startLegacy } = fixture();
    const result = await requestUpgradeFromContender({
      ...options,
      request: vi.fn(async () => ({ kind: 'registered', incumbentCanCommit: true })),
    });

    expect(result).toEqual({ kind: 'incumbent-commit-capable' });
    expect(startLegacy).not.toHaveBeenCalled();
  });

  it.each(['0.11.0', '0.11.1'])('does not register or wait against version %s', async (version) => {
    const { options, startLegacy, runDir } = fixture(version);
    const request = vi.fn(async () => ({ kind: 'registered', incumbentCanCommit: false }));
    const result = await requestUpgradeFromContender({ ...options, request });

    expect(result.kind).toBe('refused');
    expect(request).not.toHaveBeenCalled();
    expect(startLegacy).not.toHaveBeenCalled();
    expect(readUpgradeIntent(runDir)).toEqual({ kind: 'absent' });
  });

  it('records a deferred refusal when another owner still holds the intent', async () => {
    const { runDir } = fixture();
    await settleContenderUpgrade(
      runDir,
      { kind: 'refused', reason: 'pending intent names another incumbent', disposition: 'deferred' },
      recordContenderDeferral,
    );
  });

  it('should exit a redundant contender without recording anything, and fail one that cannot read its intent', async () => {
    const { runDir } = fixture();
    const recordDeferral = vi.fn(async () => undefined);

    await settleContenderUpgrade(
      runDir,
      { kind: 'refused', reason: 'target does not strictly outrank the incumbent', disposition: 'redundant' },
      recordDeferral,
    );
    await expect(
      settleContenderUpgrade(
        runDir,
        { kind: 'refused', reason: 'upgrade intent is corrupt', disposition: 'error' },
        recordDeferral,
      ),
    ).rejects.toBeInstanceOf(UpgradeWaiterUnavailableError);
    expect(recordDeferral).not.toHaveBeenCalled();
  });
});
