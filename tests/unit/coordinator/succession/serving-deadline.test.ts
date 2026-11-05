import { describe, expect, it, vi } from 'vitest';
import { createCommitServing } from '#src/coordinator/succession/commit/serving.js';
import { TransientCommitFailure } from '#src/coordinator/succession/commit/failure.js';
import type { CommitState, CommitWindow, SuccessionCommitPorts } from '#src/coordinator/succession/commit/index.js';
import type { SuccessionWriterEntitlement } from '#src/store/succession-writer-generation.js';
import { createCommitFailurePolicy } from '#src/coordinator/succession/commit/failure-policy.js';
import { failedAttemptRetry } from '#src/coordinator/succession/attempt-retry.js';
import type { UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
vi.mock('#src/store/succession-writer-generation.js', () => ({ observeSuccessionServing: () => null }));

describe('serving deadline classification', () => {
  it('resets a prior deadline miss when a child hold arrives during the final polling sleep', async () => {
    const time = new VirtualTime(0);
    const state = { attemptAbort: new AbortController() } as CommitState;
    const serving = createCommitServing({ runtime: { time } } as unknown as SuccessionCommitPorts, state, {
      retirementServes: () => false,
      ...createCommitFailurePolicy(state),
    });
    const window = {
      attempt: { attemptId: 'attempt', child: { exitCode: null, signalCode: null } },
      hold: null,
      deadlineMonotonicMs: 2500,
      recovering: false,
    } as unknown as CommitWindow;
    const intent: UpgradeIntent = {
      version: 'v1',
      revision: 0,
      requestId: 'upgrade',
      incumbent: {
        instanceId: 'incumbent',
        pid: 123,
        incarnation: null,
        version: '0.10.25',
        bundleHash: 'old',
        flavor: 'prod',
      },
      target: {
        pluginRootLabel: '/test/target',
        build: {
          version: '0.10.27',
          buildSetId: 'target',
          flavor: 'prod',
          storeFormatFingerprint: 'format',
          bundleHash: 'backend',
          cliBundleHash: 'cli',
          claudeAppserverBundleHash: 'appserver',
          durableWrapperBundleHash: 'wrapper',
        },
      },
      attemptId: null,
      attemptOwner: null,
      disposition: 'deferred',
      blockers: [],
      retryCondition: null,
      attemptDeadline: null,
      completionReceipt: null,
    };
    const priorMiss = {
      ...intent,
      ...failedAttemptRetry(
        intent,
        { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
        'changed',
        time.now(),
      ),
    };
    expect(priorMiss.servingDeadline?.misses).toBe(1);

    time.tick(2490);
    const failure = serving.awaitServing(window, {} as SuccessionWriterEntitlement).catch((error: unknown) => error);
    time.tick(5);
    window.hold = 'Successor startup rejected the prepared handoff.';
    time.tick(20);

    const error = await failure;
    expect(time.monotonicNow()).toBe(2515n);
    expect(error).toEqual(new Error(window.hold));
    const retry = serving.retryAfterWindowFailure(window, error);
    expect(retry).toEqual({ kind: 'target-change' });
    const settled = failedAttemptRetry(priorMiss, retry, 'startup rejected the handoff', time.now());
    expect(settled.servingDeadline?.misses).toBe(0);
    expect(settled.servingDeadline?.cutoverAt).toBeNull();
    expect(settled.legacyRetirement).toBeUndefined();
  });

  it.each(['deadline', 'exit', 'obligation', 'shutdown'] as const)(
    'distinguishes %s even at an expired clock',
    async (cause) => {
      const abort = new AbortController();
      if (cause === 'shutdown') abort.abort();
      const state = { attemptAbort: abort } as CommitState;
      const serving = createCommitServing(
        { runtime: { time: { monotonicNow: () => 2500n } } } as unknown as SuccessionCommitPorts,
        state,
        { retirementServes: () => false, ...createCommitFailurePolicy(state) },
      );
      const window = {
        attempt: { attemptId: 'attempt', child: { exitCode: cause === 'exit' ? 1 : null, signalCode: null } },
        hold: null,
        deadlineMonotonicMs: 2500,
        recovering: false,
      } as unknown as CommitWindow;
      let failure: unknown;
      try {
        if (cause === 'obligation') throw new TransientCommitFailure('obligation changed', 1000, true);
        await serving.awaitServing(window, {} as SuccessionWriterEntitlement);
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(serving.retryAfterWindowFailure(window, failure)).toEqual({
        kind: 'transient',
        retryAfterMs: 1000,
        ...(cause === 'deadline' ? { servingDeadline: true } : {}),
        ...(cause === 'obligation' ? { obligationChange: true } : {}),
      });
    },
  );
});
