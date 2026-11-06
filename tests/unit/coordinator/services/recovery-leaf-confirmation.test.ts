import { expect, it, vi } from 'vitest';
import type * as ProcessContainment from '#src/infra/process-containment.js';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';

const reap = vi.hoisted(() => vi.fn());
vi.mock('#src/infra/process-containment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessContainment>()),
  reapRecordedContainment: reap,
}));

import { applyRecoveryAction, COORDINATOR_NOT_APPLICABLE_FACTS } from '#src/coordinator/services/recovery/actions.js';
import { writeDurableCliProvisionalProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { recordDurableCliExecution } from '#src/jobs/durable-cli-execution.js';
import type { ProviderJobLaunch, JobStatus } from '#src/jobs/records.js';
import { RecoveryRegistry } from '#src/jobs/reconcile/registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

it.each(['populated', 'missing', 'unknown'] as const)(
  'retains pre-ready recovery when the leaf becomes %s after the reaper last observed it',
  async (transition) => {
    const runtime = new SimulationRuntime();
    const db = openTestStoreDb(runtime, ':memory:');
    const jobId = '00000000-0000-4000-8000-000000000001';
    const identity = { pid: 4242, incarnation: testIncarnation('receipt') };
    const launch: ProviderJobLaunch = {
      jobId,
      owner: { kind: 'provider-session', id: 'session' },
      execution: 1,
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
    const status: JobStatus = {
      jobId,
      execution: 1,
      owner: launch.owner,
      sessionId: null,
      provider: 'codex',
      projectRoot: '/project',
      workDir: null,
      backendNamespace: 'namespace',
      jobKind: 'provider',
      phase: 'launching',
      updatedAt: launch.createdAt,
    };
    try {
      writeDurableCliProvisionalProcessRuntimeMeta(db, { jobId, ...identity, processGroupId: identity.pid });
      recordDurableCliExecution(db, { jobId, execution: 1, ...identity });
      Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test' } });
      let observation: FailureDomainObservation = { kind: 'missing' };
      vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
        observe: () => observation,
        kill: () => ({ kind: 'refused', errno: 'EACCES' }),
      });
      let finish!: () => void;
      const paused = new Promise<void>((resolve) => {
        finish = resolve;
      });
      reap.mockImplementationOnce(async (_subject, _roots, _deadline, environment) => {
        observation = { kind: 'absent' };
        environment.failureDomain.observe();
        await paused;
        return { kind: 'containment-absent' };
      });
      const registry = new RecoveryRegistry();
      const settleFault = vi.fn(() => COORDINATOR_NOT_APPLICABLE_FACTS);
      const result = applyRecoveryAction(
        { type: 'resolvePreReadyLaunch', jobId, launchRecord: launch, status },
        {
          progressStore: { getDb: () => db } as never,
          recoveryRegistry: registry,
          queuedRecoverable: [],
          runningRecoverable: [],
          log: vi.fn(),
          runtime,
          createInvocationContext: () => ({}) as never,
          getRecoveryService: () => ({}) as never,
          signal: new AbortController().signal,
          settleFault,
          setProcessLocalCleanup: vi.fn(),
          clearProcessLocalCleanup: vi.fn(),
        },
      );
      expect(reap).toHaveBeenCalled();
      observation = transition === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: transition };
      finish();
      await expect(result).resolves.toMatchObject({ kind: 'quarantine' });
      expect(settleFault).not.toHaveBeenCalled();
      expect(registry.has(jobId)).toBe(true);
    } finally {
      db.close();
      reap.mockReset();
    }
  },
);

it('refreshes pending abort acceptance at the registry ownership release boundary', async () => {
  const registry = new RecoveryRegistry();
  let finish!: (value: { kind: 'accepted' }) => void;
  const settlement = new Promise<{ kind: 'accepted' }>((resolve) => {
    finish = resolve;
  });
  const confirmAcceptance = vi.fn(() => false);
  registry.register('job', {} as ProviderJobLaunch, undefined, () => ({
    kind: 'held',
    reason: 'containment absence is not confirmed',
    nextStep: 'retry',
    settlement,
    confirmAcceptance,
  }));
  registry.abort(['job']);
  finish({ kind: 'accepted' });
  await settlement;
  expect(confirmAcceptance).toHaveBeenCalledOnce();
  expect(registry.has('job')).toBe(true);
  expect(registry.getAbortDisposition('job')).toMatchObject({ kind: 'held' });
});

it('retains registry ownership when its delayed acceptance confirmation cannot persist the hold', async () => {
  const registry = new RecoveryRegistry();
  let finish!: (value: { kind: 'accepted' }) => void;
  const settlement = new Promise<{ kind: 'accepted' }>((resolve) => {
    finish = resolve;
  });
  registry.register('job', {} as ProviderJobLaunch, undefined, () => ({
    kind: 'held',
    reason: 'awaiting containment',
    nextStep: 'retry',
    settlement,
    confirmAcceptance: () => {
      throw new Error('hold write failed');
    },
  }));
  registry.abort(['job']);
  finish({ kind: 'accepted' });
  await settlement;
  expect(registry.has('job')).toBe(true);
  expect(registry.getAbortDisposition('job')).toMatchObject({ kind: 'refused', reason: 'hold write failed' });
});
