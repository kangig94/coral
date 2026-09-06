import { describe, expect, it, vi } from 'vitest';

import { applyRecoveryAction, COORDINATOR_NOT_APPLICABLE_FACTS } from '#src/coordinator/services/recovery/actions.js';
import { writeDurableCliContainmentStatus, writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { RecoveryRegistry } from '#src/jobs/reconcile/registry.js';
import type { ProviderRecoveryAuthorityCapture } from '#src/jobs/reconcile/contracts.js';
import type { AppServerRuntime, ProviderJobLaunch } from '#src/jobs/records.js';
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

function recoveryFixture(
  liveness: 'alive' | 'absent' | 'unknown',
  platform: NodeJS.Platform = 'linux',
  options: { captureSucceeds?: boolean } = {},
) {
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
  const abandonHeldJob = vi.fn(() => ({ kind: 'accepted' as const }));
  const runningRecoverable: Array<{ jobId: string }> = [];
  let cleanup: (() => void) | null = null;

  const run = () =>
    applyRecoveryAction(
      { type: 'registerRunning', jobId: JOB_ID, launchRecord: launchRecord(), runtimeRecord: runtimeRecord() },
      {
        progressStore: { getDb: () => db } as never,
        recoveryRegistry,
        queuedRecoverable: [],
        runningRecoverable: runningRecoverable as never,
        log: vi.fn(),
        runtime,
        createInvocationContext: () => ({}) as never,
        getRecoveryService: () =>
          ({
            captureProviderRecoveryAuthority: async () =>
              options.captureSucceeds
                ? { ok: true, authority: { launchRecord: launchRecord() } }
                : {
                    ok: false,
                    failure: { provider: 'codex', reason: 'profile-unavailable', selector: 'default' },
                  },
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
        abandonHeldJob,
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
    abandonHeldJob,
    runningRecoverable,
    settleFault,
    run,
    cleanup: () => cleanup,
  };
}

describe('registerRunningRecovery provider-binding holds', () => {
  it('reports an app-server abort as held until recovery authority and provider acknowledgment arrive', async () => {
    const runtime = new SimulationRuntime();
    const db = openTestStoreDb(runtime, ':memory:');
    const cancelledJobIds = new Set<string>();
    const recoveryRegistry = new RecoveryRegistry(cancelledJobIds);
    const appServerRuntime: AppServerRuntime = {
      transport: 'app-server',
      startTime: '2026-09-04T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        hostRef: {
          provider: 'codex',
          fingerprint: '0'.repeat(64),
          instanceId: 'instance-1',
          leaseMode: 'shared',
        },
      },
    };
    let resolveAuthority!: (value: ProviderRecoveryAuthorityCapture) => void;
    const authorityCapture = new Promise<ProviderRecoveryAuthorityCapture>((resolve) => {
      resolveAuthority = resolve;
    });
    const interruptAppServerJob = vi.fn(async () => ({ kind: 'acknowledged' as const }));

    try {
      const registration = applyRecoveryAction(
        { type: 'registerRunning', jobId: JOB_ID, launchRecord: launchRecord(), runtimeRecord: appServerRuntime },
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
              captureProviderRecoveryAuthority: () => authorityCapture,
              interruptAppServerJob,
            }) as never,
          signal: new AbortController().signal,
          settleFault: vi.fn(),
          settleClaim: vi.fn(),
          setProcessLocalCleanup: vi.fn(),
          clearProcessLocalCleanup: vi.fn(),
        },
      );

      expect(recoveryRegistry.abort([JOB_ID])).toEqual({
        aborted: [],
        notFound: [],
        held: [
          {
            jobId: JOB_ID,
            reason: 'waiting for recovery authority and provider acknowledgment of app-server interruption',
            nextStep:
              `Run coral-cli jobs detail ${JOB_ID}; if interruption is refused, repair the reported condition, ` +
              'then use coral-cli backend recovery-quarantine list and run its exact retry command.',
          },
        ],
      });
      expect(recoveryRegistry.has(JOB_ID)).toBe(true);

      resolveAuthority({
        ok: true,
        authority: { launchRecord: launchRecord(), session: {}, boundProvider: {} },
      } as unknown as ProviderRecoveryAuthorityCapture);
      await registration;

      expect(interruptAppServerJob).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(recoveryRegistry.getAbortDisposition(JOB_ID)).toMatchObject({
          kind: 'finalization-pending',
          reason: 'the provider acknowledged interruption; user-abort terminal finalization remains pending',
        }),
      );
      expect(recoveryRegistry.has(JOB_ID)).toBe(true);
      expect(cancelledJobIds.has(JOB_ID)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('preserves operator abandonment when registering a persisted durable hold', async () => {
    const fixture = recoveryFixture('alive', 'linux', { captureSucceeds: true });
    try {
      const incarnation = testIncarnation('held');
      const record = {
        jobId: JOB_ID,
        pid: PID,
        incarnation,
        processGroupId: PID,
        childRoot: { pid: PID + 1, incarnation },
      };
      writeDurableCliProcessRuntimeMeta(fixture.db, record);
      writeDurableCliContainmentStatus(fixture.db, {
        jobId: JOB_ID,
        evidence: { kind: 'current', record },
        disposition: {
          kind: 'held',
          reason: 'the process ignored termination',
          retryIntervalMs: 500,
          abandonment: 'abort-job',
        },
      });
      fixture.setObservedIncarnation(incarnation);
      const preinstalledAbandon = vi.fn(() => ({ kind: 'accepted' as const }));
      fixture.recoveryRegistry.register(JOB_ID, launchRecord(), runtimeRecord(), preinstalledAbandon);

      await expect(fixture.run()).resolves.toMatchObject({ kind: 'advanced', outcome: 'settled' });

      expect(fixture.runningRecoverable).toEqual([expect.objectContaining({ jobId: JOB_ID })]);
      expect(fixture.recoveryRegistry.abort([JOB_ID])).toEqual({ aborted: [JOB_ID], notFound: [] });
      expect(preinstalledAbandon).toHaveBeenCalledOnce();
      expect(fixture.abandonHeldJob).not.toHaveBeenCalled();
      expect(fixture.kill).not.toHaveBeenCalled();
    } finally {
      fixture.db.close();
    }
  });

  it('keeps an unknown durable process owned and returns an operator-retryable quarantine', async () => {
    const fixture = recoveryFixture('unknown');
    try {
      const disposition = await fixture.run();

      if (disposition.kind !== 'quarantine') throw new Error(`expected quarantine, received ${disposition.kind}`);
      expect(disposition.detail).toContain('containment evidence is missing');
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
