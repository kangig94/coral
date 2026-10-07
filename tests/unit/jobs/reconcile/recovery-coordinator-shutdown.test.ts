import { afterEach, describe, expect, it, vi } from 'vitest';

import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import type { JobLaunch } from '#src/jobs/records.js';
import type { ProviderRecoveryAuthority, RecoveryCapableService } from '#src/jobs/reconcile/contracts.js';
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { SessionManager } from '#src/sessions/shell.js';
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
    reducers: composeReducers(jobsRegistry, sessionsRegistry),
  });
  const sessions = new SessionManager('/project', runtime, undefined, undefined, db, permissiveProviderLookupPort);
  const launch: JobLaunch = {
    jobId: '00000000-0000-4000-8000-000000000001',
    owner: { kind: 'provider-session', id: 'session-1' },
    sessionId: 'session-1',
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
    sessionId: 'session-1',
    provider: 'codex',
    projectRoot: '/project',
    backendNamespace: 'test',
    activeJobId: '00000000-0000-4000-8000-000000000001',
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
  const signal = new AbortController();
  const finalized = createDeferred<void>();
  const service = {
    interruptAppServerJob: vi.fn(async () => {
      throw new Error('unexpected app-server interruption');
    }),
    captureProviderRecoveryAuthority: vi.fn<RecoveryCapableService['captureProviderRecoveryAuthority']>(async () => ({
      ok: true,
      authority: {
        launchRecord: launch,
        session: sessions.get('codex', 'session-1'),
        boundProvider: { name: 'codex' },
      } as unknown as ProviderRecoveryAuthority,
    })),
    finalizeInterruptedAppServerJob: vi.fn<RecoveryCapableService['finalizeInterruptedAppServerJob']>(async () => {}),
    finalizeInterruptedDurableJob: vi.fn<RecoveryCapableService['finalizeInterruptedDurableJob']>(
      async (_authority, _record, observation, fence) => {
        fence.onCommitStart();
        commitJobTerminal(store, '00000000-0000-4000-8000-000000000001', 'session-1', {
          content: '',
          durationMs: 0,
          outcome: observation.cancelled ? { kind: 'aborted', reason: 'user_abort' } : { kind: 'completed' },
        });
        sessions.releaseJob('session-1', '00000000-0000-4000-8000-000000000001');
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
    signal,
    run: () =>
      recovery.runStartupRecovery({
        runtime,
        progressStore: store,
        getRecoveryService,
        createInvocationContext,
        signal: signal.signal,
        log,
        coordinatorCommit: (cb) => store.commit(cb),
      }),
    quarantine: () =>
      db
        .prepare("SELECT stage FROM recovery_quarantine WHERE subject_key = '00000000-0000-4000-8000-000000000001'")
        .get(),
  };
}

describe('RecoveryCoordinator shutdown', () => {
  it('bars a late binding-failure commit after shutdown', async () => {
    const f = fixture();
    const captured = createDeferred<void>();
    const release = createDeferred<void>();
    f.service.captureProviderRecoveryAuthority.mockImplementation(async () => {
      captured.resolve();
      await release.promise;
      return { ok: false, failure: { reason: 'subject-mismatch', provider: 'codex' } } as never;
    });
    const startup = f.run().catch((error: unknown) => error);
    await captured.promise;
    f.signal.abort();
    await f.recovery.teardown();
    release.resolve();
    expect(await startup).toMatchObject({ name: 'AbortError' });
    expect(f.store.readStatus('00000000-0000-4000-8000-000000000001')?.phase).toBe('running');
    expect(
      f.store.readJobEvents('00000000-0000-4000-8000-000000000001').filter((event) => event.type === 'terminal'),
    ).toEqual([]);
    expect(f.sessions.get('codex', 'session-1')?.activeJobId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('waits for in-flight durable finalization before releasing recovery authority', async () => {
    const f = fixture('durable-cli');
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const finalize = f.service.finalizeInterruptedDurableJob.getMockImplementation()!;
    f.service.finalizeInterruptedDurableJob.mockImplementation(async (...args) => {
      args[3].onCommitStart();
      started.resolve();
      await release.promise;
      await finalize(...args);
    });
    await f.run();
    f.markAbsent();
    f.runtime.time.tick(500);
    await started.promise;
    let stopped = false;
    const shutdown = f.recovery.teardown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(f.sessions.get('codex', 'session-1')?.activeJobId).toBe('00000000-0000-4000-8000-000000000001');
    release.resolve();
    await shutdown;
    expect(f.store.readStatus('00000000-0000-4000-8000-000000000001')?.phase).toBe('completed');
    expect(f.sessions.get('codex', 'session-1')?.activeJobId).toBeUndefined();
  });
});
