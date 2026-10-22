import { createTestExecutionFinisher } from '#tests/helpers/execution-finisher.js';
import { requestedExecution } from '#tests/helpers/job-executions.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import { ProcessContainmentError } from '#src/infra/process-containment.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { ProviderRecoveryAuthority, RecoveryCapableService } from '#src/jobs/reconcile/contracts.js';
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(transport: 'app-server' | 'durable-cli' = 'app-server') {
  const runtime = new SimulationRuntime();
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const eventBus = new TypedEventBus();
  const store = new JobStore('test', runtime, createEventBodyCodec(), {
    db,
    eventBus,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry),
  });
  const sessions = new ConversationManager('/project', runtime, (cb) => store.commit(cb), db);
  const launch: JobLaunch = {
    jobId: '00000000-0000-4000-8000-000000000001',
    owner: { kind: 'provider-session', id: '00000000-0000-4000-8000-000000000001' },
    execution: 1,
    provider: 'codex',
    projectRoot: '/project',
    backendNamespace: 'test',
    jobKind: 'provider',
    providerAction: 'exec',
    pool: 'default',
    enqueueSequence: 1,
    request: { prompt: 'run', cwd: '/project', bypassPermissions: false, coralEnv: {} },
    createdAt: new Date(runtime.time.now()).toISOString(),
  };
  seedTestSessionProjection(db, {
    jobId: '00000000-0000-4000-8000-000000000001',
    provider: 'codex',
    projectRoot: '/project',
    backendNamespace: 'test',
  });
  store.appendLaunchRequested('00000000-0000-4000-8000-000000000001', launch);
  const incarnation = testIncarnation('wrapper');
  const childIncarnation = testIncarnation('child');
  let alive = true;
  runtime.process.observeLiveness = () => (alive ? 'alive' : 'absent');
  runtime.process.readProcessIncarnation = (pid) => (alive ? (pid === 42 ? incarnation : childIncarnation) : null);
  runtime.process.observeProcessIdentities = async (owners) =>
    owners.map((owner) => ({
      owner,
      evidence: alive
        ? { kind: 'incarnation', incarnation: owner.pid === 42 ? incarnation : childIncarnation }
        : { kind: 'pid-absent' },
    }));
  runtime.process.kill = () => {
    alive = false;
    return true;
  };
  if (transport === 'app-server') {
    store.appendRuntimeStarted('00000000-0000-4000-8000-000000000001', {
      transport,
      startTime: launch.createdAt,
      providerMeta: { provider: 'codex', leaseState: 'waiting' },
    });
  } else {
    store.appendRuntimeStarted('00000000-0000-4000-8000-000000000001', {
      transport,
      pid: 42,
      stdoutPath: '/stdout',
      stderrPath: '/stderr',
      startTime: launch.createdAt,
    });
    writeDurableCliProcessRuntimeMeta(db, {
      jobId: '00000000-0000-4000-8000-000000000001',
      pid: 42,
      incarnation,
      processGroupId: 42,
      childRoot: { pid: 43, incarnation: childIncarnation },
    });
  }
  const finalized = createDeferred<void>();
  const service = {
    interruptAppServerJob: vi.fn(async () => {
      throw new Error('unexpected app-server interruption');
    }),
    captureProviderRecoveryAuthority: vi.fn<RecoveryCapableService['captureProviderRecoveryAuthority']>(async () => ({
      ok: true,
      authority: {
        launchRecord: launch,
        session: sessions.get('codex', '00000000-0000-4000-8000-000000000001'),
        boundProvider: { name: 'codex' },
      } as unknown as ProviderRecoveryAuthority,
    })),
    finalizeInterruptedAppServerJob: vi.fn<RecoveryCapableService['finalizeInterruptedAppServerJob']>(async () => {}),
    finalizeInterruptedDurableJob: vi.fn<RecoveryCapableService['finalizeInterruptedDurableJob']>(
      async (_authority, _record, observation, fence) => {
        fence.onCommitStart();
        commitJobTerminal(store, '00000000-0000-4000-8000-000000000001', 1, {
          content: '',
          durationMs: 0,
          outcome: observation.cancelled ? { kind: 'aborted', reason: 'user_abort' } : { kind: 'completed' },
        });
        finalized.resolve();
      },
    ),
    adoptRunningJob: vi.fn<RecoveryCapableService['adoptRunningJob']>(async () => ({
      adopted: true,
      cleanup: () => {},
    })),
    recoverQueuedJob: vi.fn<RecoveryCapableService['recoverQueuedJob']>(
      async () => '00000000-0000-4000-8000-000000000001',
    ),
  } satisfies RecoveryCapableService;
  const getRecoveryService = () => service;
  const createInvocationContext = () =>
    ({ projectRoot: fixtureCanonicalWorkDir('/project'), pluginRoot: '/plugin', coralEnv: {} }) as never;
  const log = vi.fn();
  const admission = new LaunchCoordinator({ runtime });
  const recovery = createRecoveryCoordinator(
    {
      progressStore: store,
      runtime,
      eventBus,
      runtimeState: { setLaunchFenceActive: () => {} },
      getRecoveryService,
      createInvocationContext,
      log,
      startupOwnership: admission,
    },
    null,
  );
  cleanups.push(async () => {
    await recovery.teardown();
    db.close();
  });
  return {
    runtime,
    db,
    store,
    sessions,
    recovery,
    service,
    log,
    finalized: finalized.promise,
    markAbsent: () => {
      alive = false;
    },
    run: () =>
      recovery.runStartupRecovery({
        runtime,
        progressStore: store,
        getRecoveryService,
        createInvocationContext,
        signal: new AbortController().signal,
        log,
        coordinatorCommit: (cb) => store.commit(cb),
      }),
    quarantine: () =>
      db
        .prepare("SELECT stage FROM recovery_quarantine WHERE subject_key = '00000000-0000-4000-8000-000000000001'")
        .get(),
  };
}

describe('recovery lifecycle', () => {
  it('quarantines a reap that cannot confirm carrier absence', async () => {
    const f = fixture();
    f.service.finalizeInterruptedAppServerJob.mockRejectedValue(
      new ProcessContainmentError(
        'process_containment_reap_failed',
        'Recorded containment absence could not be confirmed.',
      ),
    );
    await f.run();
    expect(f.store.readStatus('00000000-0000-4000-8000-000000000001')?.phase).toBe('running');
    expect(
      f.store.readJobEvents('00000000-0000-4000-8000-000000000001').filter((event) => event.type === 'terminal'),
    ).toEqual([]);
    expect(f.quarantine()).toEqual({ stage: 'settle' });
    expect(f.sessions.get('codex', '00000000-0000-4000-8000-000000000001')?.open).toBe(true);
  });

  it('14c3 ends an unresolvable app-server execution so the same job can continue', async () => {
    const f = fixture();
    f.service.finalizeInterruptedAppServerJob.mockRejectedValue(new Error('replacement host could not be opened'));
    await f.run();
    const finisher = createTestExecutionFinisher(f.store, f.runtime);
    await finisher.finish({ jobId: '00000000-0000-4000-8000-000000000001', execution: 1 });
    expect(f.store.readStatus('00000000-0000-4000-8000-000000000001')?.phase).toBe('error');
    expect(
      f.store.readJobEvents('00000000-0000-4000-8000-000000000001').filter((event) => event.type === 'terminal'),
    ).toHaveLength(1);
    expect(f.sessions.get('codex', '00000000-0000-4000-8000-000000000001')?.open).toBe(false);
    f.store.commit((c) => {
      c.append({ ...requestedExecution(2), stream: { kind: 'job', id: '00000000-0000-4000-8000-000000000001' } });
      return undefined;
    });
    expect(f.sessions.get('codex', '00000000-0000-4000-8000-000000000001')).toMatchObject({ open: true, execution: 2 });
  });

  it('rolls back outcome acceptance and execution closure together when recovery settlement fails', async () => {
    const f = fixture();
    f.service.captureProviderRecoveryAuthority.mockRejectedValue(new Error('capture failed'));
    f.db.exec(`CREATE TRIGGER reject_release BEFORE INSERT ON events
      WHEN NEW.type = 'job.execution.outcome.accepted' BEGIN SELECT RAISE(ABORT, 'claim release unavailable'); END`);
    await f.run();
    expect(f.store.readStatus('00000000-0000-4000-8000-000000000001')?.phase).toBe('running');
    expect(
      f.store.readJobEvents('00000000-0000-4000-8000-000000000001').filter((event) => event.type === 'terminal'),
    ).toEqual([]);
    expect(f.sessions.get('codex', '00000000-0000-4000-8000-000000000001')?.open).toBe(true);
    expect(f.quarantine()).toEqual({ stage: 'settle' });
  });

  it('completes an adopted child as aborted once the child is absent', async () => {
    const f = fixture('durable-cli');
    await f.run();
    expect(f.service.adoptRunningJob).toHaveBeenCalledTimes(1);
    vi.spyOn(f.runtime.time, 'sleep').mockImplementation(async (ms) => {
      f.runtime.time.tick(ms);
    });
    const registry = f.recovery.getRecoveryRegistry()!;
    expect(registry.abort(['00000000-0000-4000-8000-000000000001']).held).toHaveLength(1);
    await registry.getAbortDisposition('00000000-0000-4000-8000-000000000001')?.settlement;
    f.runtime.time.tick(500);
    await f.finalized;
    expect(f.store.readStatus('00000000-0000-4000-8000-000000000001')).toMatchObject({
      phase: 'aborted',
      result: { outcome: { kind: 'aborted', reason: 'user_abort' } },
    });
    expect(f.service.finalizeInterruptedDurableJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cancelled: true }),
      expect.anything(),
    );
    expect(f.sessions.get('codex', '00000000-0000-4000-8000-000000000001')?.open).toBe(false);
  });
});
