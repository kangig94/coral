import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunningRecoveryAdoption } from '#src/coordinator/services/recovery/running-adoption.js';
import type { RunningRecoverableJob } from '#src/coordinator/services/recovery/actions.js';
import type { RecoveryCapableService } from '#src/jobs/reconcile/contracts.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('running recovery adoption finalization ownership', () => {
  it('logs and consumes a rejected tracked finalization', async () => {
    const runtime = createRealRuntime('prod');
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const jobId = randomUUID();
    const log: string[] = [];
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(runtime.time, 'setInterval').mockImplementation((callback) => {
      intervalCallbacks.push(callback);
      return { unref: () => undefined };
    });

    let containmentAlive = true;
    const state = {
      recoveryRegistry: null,
      cancelledRecoveryJobIds: new Set<string>(),
      adoptedRunningPids: new Map<string, { pid: number; pool: string }>(),
      unansweredAdoptionProbes: new Map<string, number>(),
      recoveryPollIntervals: new Map(),
      adoptedRunningJobCleanups: new Map<string, () => void>(),
      teardownRequested: false,
    };
    const progressStore = {
      getDb: () => db,
      appendProgress: () => undefined,
      appendRuntimeStarted: () => undefined,
    };
    const service = {
      adoptRunningJob: async () => ({ adopted: true as const, cleanup: () => undefined }),
    } as unknown as RecoveryCapableService;
    const recovery = {
      jobId,
      authority: {
        launchRecord: {
          jobId,
          projectRoot: '/tmp/coral-running-adoption',
          sessionId: randomUUID(),
          pool: 'default',
        },
        boundProvider: { recovery: undefined },
      },
      runtimeRecord: {
        transport: 'durable-cli',
        pid: 71_001,
        stdoutPath: '/tmp/coral-running-adoption.stdout',
        stderrPath: '/tmp/coral-running-adoption.stderr',
        startTime: '2026-09-11T00:00:00.000Z',
      },
    } as unknown as RunningRecoverableJob;
    const run = createRunningRecoveryAdoption({
      state,
      progressStore: progressStore as never,
      runtime,
      getRecoveryService: () => service,
      createInvocationContext: () => ({}) as never,
      log: (message) => log.push(message),
      clearRecoveryPoller: () => undefined,
      startTrackedFinalization: async () => {
        throw new Error('tracked finalization rejected');
      },
      observeDurableRecoveryContainment: () =>
        ({
          evidence: { kind: 'missing' },
          observation: containmentAlive ? { kind: 'alive' } : { kind: 'absent' },
        }) as never,
      runHeldRecoveryReap: async () => {
        throw new Error('held recovery reap was not expected');
      },
      deleteCoordinatorRecoveryQuarantine: () => true,
      runCoordinatorWalk: async () => undefined,
      settleUnexpectedRecoveryFailure: (() => {
        throw new Error('settlement failure handling was not expected');
      }) as never,
      settleFault: (() => []) as never,
      takeAdoptedJobCleanup: () => state.adoptedRunningJobCleanups.get(jobId) ?? null,
      maybeReleaseRecoveryRegistry: () => undefined,
    });
    const reports: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(
        run(
          recovery,
          {
            signal: new AbortController().signal,
            coordinatorCommit: (() => undefined) as never,
            interruptedAppServerReason: 'restart',
            abandonHeldJob: () => ({ kind: 'refused', reason: 'not held' }),
          },
          {
            item: { jobId, claimedSession: null } as never,
            controls: {
              report: (message) => reports.push(message),
              setProcessLocalCleanup: () => undefined,
              clearProcessLocalCleanup: () => undefined,
            },
          },
        ),
      ).resolves.toMatchObject({ kind: 'advanced', detail: 'running job adopted' });
      containmentAlive = false;
      const poll = intervalCallbacks[0];
      if (poll === undefined) throw new Error('expected adopted-runtime poller');
      poll();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(log.join('')).toContain('Durable finalization cleanup failed');
      expect(log.join('')).toContain('tracked finalization rejected');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      db.close();
    }
  });
});
