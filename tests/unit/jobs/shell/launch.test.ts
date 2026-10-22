import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordProviderTerminal } from '#src/coordinator/services/terminal-materializer.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import type { AppServerProxyRoute } from '#src/jobs/contracts/app-server-proxy-route.js';
import { readDurableCliContainmentStatus } from '#src/jobs/runtime-meta-store.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import type { BoundProvider, BoundProviderStandaloneExecutionRuntime } from '#src/providers/bound-provider-contract.js';
import type { ProviderDurableSpawner } from '#src/providers/cli-runner.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { requestedExecution } from '#tests/helpers/job-executions.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const databases: Array<ReturnType<typeof newRawDatabase>> = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

function fixture(options: { route?: AppServerProxyRoute; durableSpawner?: ProviderDurableSpawner } = {}) {
  const runtime = new SimulationRuntime();
  const db = newRawDatabase(':memory:');
  databases.push(db);
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const store = new JobStore('test', runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry),
  });
  const sessions = new ConversationManager('/project', runtime, (cb) => store.commit(cb), db);
  const session = sessions.prepare({
    jobId: JOB_ID,
    binding: TEST_CODEX_BINDING,
    name: 'test',
    cwd: fixtureCanonicalWorkDir('/project'),
    projectRoot: '/project',
    backendNamespace: 'test',
  });
  const admission = new LaunchCoordinator({ runtime });
  const registry = new AbortRegistry();
  const completed = createDeferred<void>();
  const release = admission.releaseLaunch.bind(admission);
  admission.releaseLaunch = (permit) => {
    const result = release(permit);
    completed.resolve();
    return result;
  };
  const execute = vi.fn(async function* () {});
  const provider = {
    name: 'codex',
    envelope: TEST_CODEX_BINDING,
    appServer: {},
    artifacts: { kind: 'none', reason: 'fixture' },
    compareIdentity: () => ({ ok: true }),
    decodeContinuity: () => ({ ok: true, value: undefined }),
    readiness: async () => ({ ok: true }),
    prepareExecution: () => ({ kind: 'app-server', hostSpec: {}, execute }),
  } as unknown as BoundProvider;
  const executionFinisher = new ExecutionFinisher({
    time: { sleep: async () => {} },
    commit: (cb) => store.commit(cb),
    read: (address) => readExecutionFinishingState(db, address, store),
    quiesce: async () => true,
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  const orchestrator = new LaunchOrchestrator({
    executionFinisher,
    runtime,
    progressStore: store,
    conversationManager: sessions,
    abortRegistry: registry,
    launchAdmission: admission,
    providerOperationBinding: admission,
    durableSpawner: options.durableSpawner ?? admission,
    providerRegistry: {} as never,
    backendNamespace: 'test',
    bundleHash: 'test',
    coordinatorCommit: (cb) => store.commit(cb),
    settlementRefusalRecorder: { record: () => true },
    appServerProxyRoute: options.route,
    terminalMaterializer: { recordProviderTerminal },
  });
  return {
    runtime,
    db,
    store,
    sessions,
    session,
    executionFinisher,
    admission,
    registry,
    provider,
    orchestrator,
    execute,
    completed: completed.promise,
    launch: () =>
      orchestrator.launchExecution(
        provider,
        session,
        {
          action: 'exec',
          jobId: session.jobId,
          prompt: 'run',
          cwd: fixtureCanonicalWorkDir('/project'),
          coralEnv: {},
          bypassPermissions: false,
        },
        {
          owner: { kind: 'provider-session', id: session.jobId },
          mintProtectedEnv: () => ({ env: {}, childAuthorization: {} as never }),
        },
      ),
  };
}

describe('LaunchOrchestrator', () => {
  it('keeps a late producer on its committed execution while the successor is current', async () => {
    const f = fixture();
    f.store.initJob({
      jobId: JOB_ID,
      conversation: {
        provider: 'codex',
        binding: TEST_CODEX_BINDING,
        name: 'test',
        cwd: fixtureCanonicalWorkDir('/project'),
        bypassPermissions: false,
        retention: 'retain',
      },
      projectRoot: '/project',
      backendNamespace: 'test',
    });
    commitJobTerminal(f.store, JOB_ID, 1, {
      content: 'original result',
      durationMs: 1,
      outcome: { kind: 'completed' },
    });
    f.store.commit(
      (c) => {
        c.append({ ...requestedExecution(2), stream: { kind: 'job', id: JOB_ID } });
        return undefined;
      },
      { admittingJobs: [JOB_ID] },
    );
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM events').get();

    await f.orchestrator.writeJobTerminal(
      JOB_ID,
      1,
      {
        content: 'late result',
        durationMs: 1,
        outcome: { kind: 'completed' },
      },
      'completed',
    );

    expect(f.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(before);
    expect(f.store.readStatus(JOB_ID)).toMatchObject({ execution: 2, phase: 'launching', finishing: false });
    expect(readExecutionFinishingState(f.db, { jobId: JOB_ID, execution: 1 }, f.store)).toMatchObject({
      kind: 'ended',
      accepted: { terminal: { content: 'original result' } },
    });
  });

  it('refuses a running predecessor with the busy code and a runnable wait', async () => {
    const f = fixture();
    f.store.initJob({
      jobId: JOB_ID,
      conversation: {
        provider: 'codex',
        binding: TEST_CODEX_BINDING,
        name: 'test',
        cwd: fixtureCanonicalWorkDir('/project'),
        bypassPermissions: false,
        retention: 'retain',
      },
      projectRoot: '/project',
      backendNamespace: 'test',
    });
    const current = f.sessions.readById(JOB_ID)!;
    const decision = await f.orchestrator.launchExecution(
      f.provider,
      current,
      {
        action: 'resume',
        jobId: JOB_ID,
        prompt: 'continue',
        cwd: fixtureCanonicalWorkDir('/project'),
        coralEnv: {},
        bypassPermissions: false,
      },
      { owner: { kind: 'provider-session', id: JOB_ID }, mintProtectedEnv: () => ({}) },
    );
    expect(decision).toMatchObject({
      status: 'refused',
      code: 'session_busy',
      message: expect.stringContaining(`coral-cli jobs wait ${JOB_ID}`),
    });
    await f.executionFinisher.dispose();
  });

  it('returns a finishing decision when disposal interrupts continuation admission', async () => {
    const f = fixture();
    f.store.initJob({
      jobId: JOB_ID,
      conversation: {
        provider: 'codex',
        binding: TEST_CODEX_BINDING,
        name: 'test',
        cwd: fixtureCanonicalWorkDir('/project'),
        bypassPermissions: false,
        retention: 'retain',
      },
      projectRoot: '/project',
      backendNamespace: 'test',
    });
    await f.executionFinisher.accept({ jobId: JOB_ID, execution: 1 }, (c) => {
      appendJobExecutionOutcomeAccepted(c, {
        jobId: JOB_ID,
        execution: 1,
        terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
      });
      return undefined;
    });
    await f.executionFinisher.finish({ jobId: JOB_ID, execution: 1 });
    const current = f.sessions.readById(JOB_ID)!;
    vi.spyOn(f.admission, 'reservationFor').mockReturnValue({} as never);
    const sleeping = createDeferred<void>();
    vi.spyOn(f.runtime.time, 'sleep').mockImplementation(() => {
      sleeping.resolve();
      return new Promise<never>(() => {});
    });
    const decision = f.orchestrator.launchExecution(
      f.provider,
      current,
      {
        action: 'resume',
        jobId: JOB_ID,
        prompt: 'continue',
        cwd: fixtureCanonicalWorkDir('/project'),
        coralEnv: {},
        bypassPermissions: false,
      },
      { owner: { kind: 'provider-session', id: JOB_ID }, mintProtectedEnv: () => ({}) },
    );
    await sleeping.promise;
    await f.executionFinisher.dispose();
    await expect(decision).resolves.toMatchObject({
      status: 'refused',
      code: 'execution_finishing',
      message: expect.stringContaining(`coral-cli jobs wait ${JOB_ID}`),
    });
  });

  it('terminalizes and releases a committed launch when synchronous setup fails', async () => {
    const f = fixture();
    const mkdir = f.runtime.storage.mkdirSync.bind(f.runtime.storage);
    vi.spyOn(f.runtime.storage, 'mkdirSync').mockImplementation((path, options) => {
      if (String(path) === f.store.jobDir(JOB_ID) && f.store.readStatus(JOB_ID) !== null)
        throw new Error('setup failed');
      return mkdir(path, options);
    });
    await expect(f.launch()).resolves.toMatchObject({
      kind: 'provider-session',
      jobId: JOB_ID,
      requestedSeq: expect.any(Number),
    });
    await f.completed;
    expect(f.store.readStatus(JOB_ID)).toMatchObject({ phase: 'error', result: { outcome: { kind: 'job_fault' } } });
    expect(f.sessions.get('codex', f.session.jobId)?.open).toBe(false);
    expect(f.admission.reservationFor(JOB_ID)).toBeNull();
    expect(f.registry.has(JOB_ID)).toBe(false);
  });

  it('rolls back the provider job when the launch commit fails', async () => {
    const f = fixture();
    f.db.exec(`CREATE TRIGGER reject_launch BEFORE INSERT ON events
      WHEN NEW.type = 'job.execution.requested' BEGIN SELECT RAISE(ABORT, 'launch unavailable'); END`);
    await expect(f.launch()).rejects.toThrow('launch unavailable');
    expect(f.store.readStatus(JOB_ID)).toBeNull();
    expect(f.sessions.get('codex', f.session.jobId)).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    expect(f.admission.reservationFor(JOB_ID)).toBeNull();
    expect(f.registry.has(JOB_ID)).toBe(false);
  });

  it('does not write a second terminal for terminalized proxy placement', async () => {
    const f = fixture({
      route: {
        hostRoot: () => '/test/plugin',
        activate: async () => {
          commitJobTerminal(f.store, JOB_ID, 1, {
            content: 'done',
            durationMs: 0,
            outcome: { kind: 'completed' },
          });
          return { kind: 'terminalized' };
        },
      } as AppServerProxyRoute,
    });
    await f.launch();
    await f.completed;
    expect(f.store.readJobEvents(JOB_ID).filter((event) => event.type === 'terminal')).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.sessions.get('codex', f.session.jobId)?.open).toBe(false);
  });

  it('preserves durable abandonment when its progress diagnostic fails', async () => {
    const published = createDeferred<void>();
    const durableSpawner: ProviderDurableSpawner = {
      spawnDurableJob: async (options) => {
        const disposition = options.onDurableProcessIdentity!(
          {
            pid: 42,
            incarnation: testIncarnation('wrapper'),
            processGroupId: 42,
            childRoot: { pid: 43, incarnation: testIncarnation('child') },
          },
          { kind: 'operator-abandoned', processAbsenceProven: false },
        );
        expect(disposition).toEqual({ kind: 'published' });
        published.resolve();
        return new Promise(() => {});
      },
    };
    const f = fixture({ durableSpawner });
    Object.assign(f.provider, {
      appServer: undefined,
      prepareExecution: () => ({
        kind: 'standalone',
        prepareCliRequest: (request: unknown) => request,
        execute: async function* (providerRuntime: BoundProviderStandaloneExecutionRuntime) {
          await providerRuntime.runCli({ command: 'fixture', args: [] });
        },
      }),
    });
    vi.spyOn(f.store, 'appendProgress').mockImplementation(() => {
      throw new Error('diagnostic unavailable');
    });
    await f.launch();
    await published.promise;
    expect(readDurableCliContainmentStatus(f.db, JOB_ID)).toMatchObject({
      kind: 'valid',
      status: { disposition: { kind: 'operator-abandoned', processAbsenceProven: false } },
    });
  });

  it('avoids local execution when the proxy already owns the operation', async () => {
    const placed = createDeferred<void>();
    const f = fixture({
      route: {
        hostRoot: () => '/test/plugin',
        activate: async () => {
          placed.resolve();
          return { kind: 'remote-executing', operationId: 'operation-1' };
        },
      } as AppServerProxyRoute,
    });
    await f.launch();
    await placed.promise;
    await f.orchestrator.quiesceAppServerJobsForHandoff();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.store.readJobEvents(JOB_ID).filter((event) => event.type === 'terminal')).toEqual([]);
    expect(f.sessions.get('codex', f.session.jobId)?.open).toBe(true);
  });
});
