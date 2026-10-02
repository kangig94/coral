import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { subscribeSuccessionObligationChanges } from '#src/coordinator/composition/index.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';

const runtime = createRealRuntime('prod', { baseDir: tmpdir() });

describe('succession obligation change wiring', () => {
  it('reconciles a pending intent when an obligation becomes terminal', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-obligation-change-'));
    const eventBus = new TypedEventBus();
    const incumbent = {
      instanceId: 'incumbent',
      pid: 1234,
      incarnation: null,
      version: '0.10.13',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod' as const,
    };
    let changed!: () => void;
    const completion = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => incumbent,
      owners: [],
      onIntentChanged: changed,
      epochKey: () => null,
      admissionRevision: () => 0,
      commitAvailable: true,
      subscribeObligationChanges: (notify) =>
        subscribeSuccessionObligationChanges(
          eventBus,
          { subscribeSuccessionObligationChanges: () => () => {} },
          notify,
        ),
    });
    try {
      expect(
        await compareAndSwapUpgradeIntent(runDir, null, {
          requestId: 'pending-request',
          incumbent,
          target: {
            pluginRootLabel: '/missing/target',
            build: {
              version: '0.11.0',
              buildSetId: '00000000-0000-4000-8000-000000000001',
              flavor: 'prod',
              storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
              bundleHash: '0123456789abcdef',
              cliBundleHash: '0123456789abcdef',
              claudeAppserverBundleHash: '0123456789abcdef',
              durableWrapperBundleHash: '0123456789abcdef',
            },
          },
          attemptId: null,
          attemptOwner: null,
          disposition: 'pending',
          blockers: [],
          retryCondition: null,
          attemptDeadline: null,
          completionReceipt: null,
        }),
      ).toMatchObject({ kind: 'written' });
      eventBus.emit('job:phase_changed', {
        jobId: 'settled-job',
        phase: 'completed',
        previousPhase: 'running',
      });
      await completion;
      expect(readUpgradeIntent(runDir)).toMatchObject({
        kind: 'readable',
        intent: {
          disposition: 'deferred',
          retryCondition: { kind: 'target-change', evidence: 'target build no longer validates' },
        },
      });
    } finally {
      reconciler.dispose();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
