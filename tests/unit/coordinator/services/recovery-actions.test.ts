import { describe, expect, it, vi } from 'vitest';

import { applyRecoveryAction, COORDINATOR_NOT_APPLICABLE_FACTS } from '#src/coordinator/services/recovery/actions.js';
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { RecoveryRegistry } from '#src/jobs/reconcile/registry.js';
import type { ProviderJobLaunch } from '#src/jobs/records.js';
import type { DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const PID = 4_242;

function launchRecord(): ProviderJobLaunch {
  return {
    jobId: JOB_ID,
    owner: { kind: 'provider-session', id: 'session-1' },
    sessionId: 'session-1',
    provider: 'codex',
    projectRoot: '/project',
    backendNamespace: 'namespace',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    providerAction: 'exec',
    request: { prompt: 'recover', cwd: '/project', bypassPermissions: false, coralEnv: {} },
    createdAt: '2026-09-04T00:00:00.000Z',
  };
}

function runtimeRecord(): DurableCliRuntimeRecord {
  return {
    transport: 'durable-cli',
    pid: PID,
    stdoutPath: '/jobs/stdout',
    stderrPath: '/jobs/stderr',
    startTime: '2026-09-04T00:00:00.000Z',
  };
}

function recoveryFixture(liveness: 'alive' | 'absent' | 'unknown', platform: NodeJS.Platform = 'linux') {
  const runtime = new SimulationRuntime();
  vi.spyOn(runtime.env, 'platform').mockReturnValue(platform);
  let monotonicMs = 0n;
  vi.spyOn(runtime.time, 'monotonicNow').mockImplementation(() => {
    monotonicMs += 25n;
    return monotonicMs;
  });
  vi.spyOn(runtime.time, 'sleep').mockResolvedValue();
  const db = openTestStoreDb(runtime, ':memory:');
  const absentPids = new Set<number>();
  let observedIncarnation = testIncarnation('observed');
  const observeLiveness = (pid: number) => (absentPids.has(pid) ? 'absent' : liveness);
  const kill = vi.fn((pid: number) => {
    absentPids.add(pid);
    if (pid < 0) absentPids.add(-pid);
    return true;
  });
  const readProcessIncarnation = vi.fn((pid: number) =>
    observeLiveness(pid) === 'absent' ? null : observedIncarnation,
  );
  runtime.process.observeLiveness = vi.fn(observeLiveness);
  runtime.process.readProcessIncarnation = readProcessIncarnation;
  runtime.process.observeProcessIdentities = async (owners) =>
    owners.map((owner) => {
      const observed = observeLiveness(owner.pid);
      if (observed === 'absent') return { owner, evidence: { kind: 'pid-absent' as const } };
      if (observed === 'unknown') {
        return { owner, evidence: { kind: 'unobservable' as const, cause: 'probe-failed' as const } };
      }
      return { owner, evidence: { kind: 'incarnation' as const, incarnation: observedIncarnation } };
    });
  runtime.process.kill = kill;
  const recoveryRegistry = new RecoveryRegistry();
  const settleFault = vi.fn(() => COORDINATOR_NOT_APPLICABLE_FACTS);
  let cleanup: (() => void) | null = null;

  const run = () =>
    applyRecoveryAction(
      { type: 'registerRunning', jobId: JOB_ID, launchRecord: launchRecord(), runtimeRecord: runtimeRecord() },
      {
        progressStore: { getDb: () => db } as never,
        recoveryRegistry,
        queuedRecoverable: [],
        runningRecoverable: [],
        log: vi.fn(),
        runtime,
        createInvocationContext: () => ({}) as never,
        getRecoveryService: () =>
          ({
            captureProviderRecoveryAuthority: async () => ({
              ok: false,
              failure: { provider: 'codex', reason: 'profile-unavailable', selector: 'default' },
            }),
          }) as never,
        signal: new AbortController().signal,
        settleFault,
        settleClaim: vi.fn(),
        setProcessLocalCleanup: (nextCleanup: () => void) => {
          cleanup = nextCleanup;
        },
        clearProcessLocalCleanup: () => {
          cleanup = null;
        },
      },
    );

  return {
    db,
    kill,
    readProcessIncarnation,
    setObservedIncarnation: (incarnation: ReturnType<typeof testIncarnation>) => {
      observedIncarnation = incarnation;
    },
    recoveryRegistry,
    settleFault,
    run,
    cleanup: () => cleanup,
  };
}

describe('registerRunningRecovery provider-binding holds', () => {
  it('keeps an unknown durable process owned and returns an operator-retryable quarantine', async () => {
    const fixture = recoveryFixture('unknown');
    try {
      const disposition = await fixture.run();

      if (disposition.kind !== 'quarantine') throw new Error(`expected quarantine, received ${disposition.kind}`);
      expect(disposition.detail).toContain('containment is unavailable');
      expect(disposition.detail).toContain('Retry after repairing the provider binding');
      expect(fixture.settleFault).not.toHaveBeenCalled();
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(fixture.recoveryRegistry.has(JOB_ID)).toBe(true);
      expect(fixture.cleanup()).toBeNull();
    } finally {
      fixture.db.close();
    }
  });

  it.each([
    { name: 'missing', recordedPid: null, observedIncarnation: testIncarnation('observed') },
    { name: 'different pid', recordedPid: PID + 1, observedIncarnation: testIncarnation('observed') },
    { name: 'different incarnation', recordedPid: PID, observedIncarnation: testIncarnation('other') },
  ])(
    'does not signal an alive process when its recorded identity is $name',
    async ({ recordedPid, observedIncarnation }) => {
      const fixture = recoveryFixture('alive');
      try {
        if (recordedPid !== null) {
          writeDurableCliProcessRuntimeMeta(fixture.db, {
            jobId: JOB_ID,
            pid: recordedPid,
            incarnation: testIncarnation('recorded'),
            processGroupId: recordedPid,
            childRoot: { pid: recordedPid + 1, incarnation: testIncarnation('recorded-child') },
          });
        }
        fixture.setObservedIncarnation(observedIncarnation);

        const disposition = await fixture.run();

        expect(disposition.kind).toBe('quarantine');
        expect(fixture.settleFault).not.toHaveBeenCalled();
        expect(fixture.kill).not.toHaveBeenCalled();
        expect(fixture.recoveryRegistry.has(JOB_ID)).toBe(true);
      } finally {
        fixture.db.close();
      }
    },
  );

  it('settles only after the matching group and child root are reaped', async () => {
    const fixture = recoveryFixture('alive');
    try {
      const incarnation = testIncarnation('matching');
      writeDurableCliProcessRuntimeMeta(fixture.db, {
        jobId: JOB_ID,
        pid: PID,
        incarnation,
        processGroupId: PID,
        childRoot: { pid: PID + 1, incarnation },
      });
      fixture.setObservedIncarnation(incarnation);

      const disposition = await fixture.run();

      expect(disposition.kind).toBe('advanced');
      expect(fixture.kill).toHaveBeenCalledWith(-PID, 'SIGTERM');
      expect(fixture.kill).toHaveBeenCalledWith(PID + 1, 'SIGTERM');
      expect(fixture.settleFault).toHaveBeenCalledOnce();
      expect(fixture.recoveryRegistry.has(JOB_ID)).toBe(true);
    } finally {
      fixture.db.close();
    }
  });

  it('returns a no-signal quarantine when the recorded identities cannot be observed', async () => {
    const fixture = recoveryFixture('unknown');
    try {
      const incarnation = testIncarnation('matching');
      writeDurableCliProcessRuntimeMeta(fixture.db, {
        jobId: JOB_ID,
        pid: PID,
        incarnation,
        processGroupId: PID,
        childRoot: { pid: PID + 1, incarnation },
      });
      fixture.setObservedIncarnation(incarnation);

      const disposition = await fixture.run();

      if (disposition.kind !== 'quarantine') throw new Error(`expected quarantine, received ${disposition.kind}`);
      expect(disposition.detail).toContain('liveness could not be observed');
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(fixture.settleFault).not.toHaveBeenCalled();
      expect(fixture.recoveryRegistry.has(JOB_ID)).toBe(true);
    } finally {
      fixture.db.close();
    }
  });

  it('settles only after exact containment absence and releases the registry through boundary cleanup', async () => {
    const fixture = recoveryFixture('absent');
    try {
      writeDurableCliProcessRuntimeMeta(fixture.db, {
        jobId: JOB_ID,
        pid: PID,
        incarnation: testIncarnation('leader'),
        processGroupId: PID,
        childRoot: { pid: PID + 1, incarnation: testIncarnation('child') },
      });
      const disposition = await fixture.run();

      expect(disposition.kind).toBe('advanced');
      expect(fixture.settleFault).toHaveBeenCalledOnce();
      expect(fixture.recoveryRegistry.has(JOB_ID)).toBe(true);
      fixture.cleanup()?.();
      expect(fixture.recoveryRegistry.has(JOB_ID)).toBe(false);
      expect(fixture.kill).not.toHaveBeenCalled();
    } finally {
      fixture.db.close();
    }
  });
});
