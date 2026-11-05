import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadReleasedBuild } from '#tests/helpers/released-build.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, visibleUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { pendingIntent } from '#src/coordinator-launch/pending-upgrade.js';
import { failedAttemptRetry } from '#src/coordinator/succession/attempt-retry.js';

it('lets the actual v0.10.25 reader parse fallback state and preserves suppression through its requester', async () => {
  const released = await loadReleasedBuild('v0.10.25', []);
  if (!released.readUpgradeIntent || !released.compareAndSwapUpgradeIntent || !released.requestedIntent) {
    throw new Error('missing released upgrade helpers');
  }
  const dir = mkdtempSync(join(tmpdir(), 'coral-deadline-compat-'));
  try {
    const incumbent = {
      instanceId: 'old',
      pid: 123,
      incarnation: null,
      version: '0.10.25',
      bundleHash: 'old-hash',
      flavor: 'prod' as const,
    };
    const target = {
      pluginRootLabel: '/test/target',
      build: {
        version: '0.10.27',
        buildSetId: 'target',
        flavor: 'prod' as const,
        storeFormatFingerprint: 'format',
        bundleHash: 'backend',
        cliBundleHash: 'cli',
        claudeAppserverBundleHash: 'appserver',
        durableWrapperBundleHash: 'wrapper',
      },
    };
    const old = await released.compareAndSwapUpgradeIntent(
      dir,
      null,
      released.requestedIntent({ requestId: 'old-shape', target }, incumbent, null),
    );
    expect(old.kind).toBe('written');
    let read = readUpgradeIntent(dir);
    if (read.kind !== 'readable') throw new Error(read.kind);
    expect(read.intent.servingDeadline).toBeUndefined();
    for (let i = 0; i < 2; i++) {
      const next = await compareAndSwapUpgradeIntent(dir, read.intent.revision, {
        ...read.intent,
        disposition: 'deferred',
        ...failedAttemptRetry(
          read.intent,
          { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
          'changed',
          0,
        ),
      });
      if (next.kind !== 'written') throw new Error(next.kind);
      read = { kind: 'readable', intent: next.intent };
    }
    const olderRead = released.readUpgradeIntent(dir);
    expect(olderRead.kind).toBe('readable');
    if (olderRead.kind !== 'readable') throw new Error(olderRead.kind);
    expect(
      await released.compareAndSwapUpgradeIntent(dir, olderRead.intent.revision, {
        ...olderRead.intent,
        attemptId: 'hot-attempt',
      }),
    ).toMatchObject({ kind: 'unsupported' });
    const policyBeforeRetirement = read.intent.servingDeadline;
    if (policyBeforeRetirement === undefined) throw new Error('missing deadline policy');
    const retirement = await compareAndSwapUpgradeIntent(dir, read.intent.revision, {
      ...read.intent,
      servingDeadline: {
        ...policyBeforeRetirement,
        outcome: 'retiring',
        retirementIncumbent: incumbent.instanceId,
      },
    });
    if (retirement.kind !== 'written') throw new Error(retirement.kind);
    const renewal = released.requestedIntent({ requestId: 'renewed-old-request', target }, incumbent, null);
    expect(await released.compareAndSwapUpgradeIntent(dir, retirement.intent.revision, renewal)).toMatchObject({
      kind: 'written',
    });
    expect(pendingIntent(dir)).toMatchObject({ requestId: 'renewed-old-request', legacyRetirement: true });
    expect(renewal).not.toHaveProperty('legacyRetirement');
    const renewed = readUpgradeIntent(dir);
    expect(renewed).toMatchObject({
      kind: 'readable',
      intent: { servingDeadline: { misses: 2, outcome: 'retiring' } },
    });
    if (renewed.kind !== 'readable') throw new Error(renewed.kind);
    expect(visibleUpgradeIntent(renewed.intent)?.blockers).toContainEqual(
      expect.objectContaining({ owner: 'quiescent-cutover' }),
    );
    const policy = renewed.intent.servingDeadline;
    if (policy === undefined) throw new Error('missing deadline policy');
    expect(
      (
        await compareAndSwapUpgradeIntent(dir, renewed.intent.revision, {
          ...renewed.intent,
          servingDeadline: { ...policy, outcome: 'unobservable', targetRevalidation: { attempts: 3, retryAt: null } },
        })
      ).kind,
    ).toBe('written');
    expect(released.readUpgradeIntent(dir)).toMatchObject({
      kind: 'readable',
      intent: { servingDeadline: { outcome: 'unobservable' } },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
