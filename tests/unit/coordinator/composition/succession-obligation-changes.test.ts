import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { subscribeSuccessionObligationChanges } from '#src/coordinator/composition/index.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler.js';
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
    const reconciler = createSuccessionReconciler({
      runtime,
      runDir,
      incumbent: () => incumbent,
      owners: [],
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
      await vi.waitFor(() =>
        expect(readUpgradeIntent(runDir)).toMatchObject({
          kind: 'readable',
          intent: { disposition: 'closed', retryCondition: null },
        }),
      );
    } finally {
      reconciler.dispose();
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('notifies on job terminal, launch settle, and recovery terminal events', () => {
    const eventBus = new TypedEventBus();
    let onLaunchSettled: (() => void) | undefined;
    const unsubscribeLaunch = vi.fn();
    const launchCoordinator = {
      subscribeSuccessionObligationChanges: (notify: () => void) => {
        onLaunchSettled = notify;
        return unsubscribeLaunch;
      },
    };
    const notify = vi.fn();
    const unsubscribe = subscribeSuccessionObligationChanges(eventBus, launchCoordinator, notify);

    eventBus.emit('job:phase_changed', { jobId: 'job-1', phase: 'running', previousPhase: 'launching' });
    expect(notify).not.toHaveBeenCalled();

    eventBus.emit('job:completed', {
      jobId: 'job-1',
      result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
    });
    onLaunchSettled?.();
    eventBus.emit('job:phase_changed', { jobId: 'recovered-job', phase: 'completed', previousPhase: 'running' });
    expect(notify).toHaveBeenCalledTimes(3);

    unsubscribe();
    eventBus.emit('job:phase_changed', { jobId: 'job-2', phase: 'error', previousPhase: 'running' });
    expect(notify).toHaveBeenCalledTimes(3);
    expect(unsubscribeLaunch).toHaveBeenCalledOnce();
  });
});
