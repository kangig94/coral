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

function recoveryFixture(liveness: 'alive' | 'absent' | 'unknown') {
  const runtime = new SimulationRuntime();
  const db = openTestStoreDb(runtime, ':memory:');
  const kill = vi.fn(() => true);
  const readProcessIncarnation = vi.fn(() => testIncarnation('observed'));
  runtime.process.observeLiveness = vi.fn(() => liveness);
  runtime.process.readProcessIncarnation = readProcessIncarnation;
  runtime.process.kill = kill;
  const recoveryRegistry = new RecoveryRegistry(runtime.process);
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
      expect(disposition.detail).toContain('could not be observed');
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
            version: 1,
            jobId: JOB_ID,
            pid: recordedPid,
            incarnation: testIncarnation('recorded'),
          });
        }
        fixture.readProcessIncarnation.mockReturnValue(observedIncarnation);

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

  it('passes the recorded incarnation when requesting cleanup for the matching live process', async () => {
    const fixture = recoveryFixture('alive');
    try {
      const incarnation = testIncarnation('matching');
      writeDurableCliProcessRuntimeMeta(fixture.db, { version: 1, jobId: JOB_ID, pid: PID, incarnation });
      fixture.readProcessIncarnation.mockReturnValue(incarnation);

      const disposition = await fixture.run();

      expect(disposition.kind).toBe('quarantine');
      expect(fixture.kill).toHaveBeenCalledWith(PID, 'SIGTERM');
      expect(fixture.settleFault).not.toHaveBeenCalled();
      expect(fixture.recoveryRegistry.has(JOB_ID)).toBe(true);
    } finally {
      fixture.db.close();
    }
  });

  it('settles only after exact process absence and releases the registry through boundary cleanup', async () => {
    const fixture = recoveryFixture('absent');
    try {
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
