import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler.js';
import { createSuccessionCoordinator } from '#src/coordinator/succession/index.js';
import { SUCCESSION_METHODS } from '#src/infra/succession-address.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';

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

describe('succession reconciler', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a commit-incapable incumbent intent claimable by a legacy waiter', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const reconciler = createSuccessionReconciler({
      runDir,
      incumbent: {
        instanceId: 'incumbent', pid: 1234, incarnation: null,
        version: '0.10.13', bundleHash: 'fedcba9876543210', flavor: 'prod',
      },
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
    });
    try {
      expect(await reconciler.request({
        requestId: 'legacy-request',
        target: { build, pluginRootLabel: '/missing/target' },
      })).toMatchObject({ kind: 'registered' });
      expect(await reconciler.reconcile()).toMatchObject({
        kind: 'deferred', reason: 'incumbent needs a legacy retirement waiter',
      });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable', intent: { attemptOwner: null, attemptId: null },
      });
    } finally {
      reconciler.dispose();
    }
  });

  it('declares commit incapability to a contender before it exits', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const coordinator = createSuccessionCoordinator({
      runDir,
      incumbent: {
        instanceId: 'incumbent', pid: 1234, incarnation: null,
        version: '0.10.13', bundleHash: 'fedcba9876543210', flavor: 'prod',
      },
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
    });
    try {
      expect(await coordinator.dispatch(SUCCESSION_METHODS.request, {
        requestId: 'request-1',
        target: { build, pluginRootLabel: '/installed/target' },
      })).toMatchObject({ kind: 'registered', incumbentCanCommit: false });
    } finally {
      coordinator.reconciler.dispose();
    }
  });

  it('reconciles a registered intent and does not rewrite an unchanged hold on retry', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-succession-reconcile-'));
    directories.push(runDir);
    const onIntentChanged = vi.fn();
    const unsubscribe = vi.fn();
    let notify: (() => void) | undefined;
    const reconciler = createSuccessionReconciler({
      runDir,
      incumbent: {
        instanceId: 'incumbent',
        pid: 1234,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'fedcba9876543210',
        flavor: 'prod',
      },
      owners: [],
      epochKey: () => null,
      admissionRevision: () => 0,
      commitAvailable: true,
      onIntentChanged,
      subscribeObligationChanges: (callback) => {
        notify = callback;
        return unsubscribe;
      },
    });
    try {
      expect(
        await reconciler.request({
          requestId: 'request-1',
          target: { build, pluginRootLabel: '/missing/target' },
        }),
      ).toMatchObject({ kind: 'registered' });
      expect(await reconciler.reconcile()).toMatchObject({
        kind: 'refused',
        reason: 'target build no longer validates',
      });
      const first = readUpgradeIntent(runDir);
      expect(first).toMatchObject({
        kind: 'readable',
        intent: { disposition: 'deferred', retryCondition: { kind: 'target-change' } },
      });
      if (first.kind !== 'readable') throw new Error('intent not readable');

      notify?.();
      expect(await reconciler.reconcile()).toMatchObject({ kind: 'refused' });
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable',
        intent: { revision: first.intent.revision },
      });
    } finally {
      reconciler.dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onIntentChanged).toHaveBeenCalledTimes(2);
  });
});
