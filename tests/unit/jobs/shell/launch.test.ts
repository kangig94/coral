import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendProviderTerminalInCommit } from '#src/coordinator/services/terminal-materializer.js';
import { CliBusyError } from '#src/runtime/cli-busy.js';
import { AbortError } from '#src/runtime/abort.js';
import { ProviderHostUnserviceableError } from '#src/providers/host-admission.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import type { AppServerProxyRoute } from '#src/jobs/contracts/app-server-proxy-route.js';
import { readDurableCliContainmentStatus } from '#src/jobs/runtime-meta-store.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import type { BoundProvider, BoundProviderStandaloneExecutionRuntime } from '#src/providers/bound-provider-contract.js';
import type { ProviderEventBody } from '#src/providers/contract.js';
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
  const execute = vi.fn(async function* (): AsyncGenerator<ProviderEventBody> {});
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
  const finisherTime = { sleep: async () => {} };
  const executionFinisher = new ExecutionFinisher({
    time: finisherTime,
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
    terminalMaterializer: { appendProviderTerminalInCommit },
  });
  return {
    runtime,
    db,
    store,
    sessions,
    session,
    executionFinisher,
    finisherTime,
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
  it.each([
    { outcome: 'provider failure', read: 'readStatus', error: new Error('original provider failure') },
    { outcome: 'failure duration', read: 'readLaunchProjection', error: new Error('original provider failure') },
    {
      outcome: 'busy rejection metadata',
      read: 'readLaunchProjection',
      error: new CliBusyError({ error: 'busy', provider: 'codex', globalActive: 1, globalLimit: 1 }),
    },
    {
      outcome: 'unserviceable host duration',
      read: 'readLaunchProjection',
      error: new ProviderHostUnserviceableError({
        provider: 'codex',
        instanceId: 'fixture-host',
        fingerprint: 'a'.repeat(64),
        leaseMode: 'shared',
      }),
    },
    { outcome: 'abort duration', read: 'readLaunchProjection', error: new AbortError({ stage: 'fixture' }) },
    { outcome: 'provider terminal metadata', read: 'readStatus', error: null },
  ] as const)('retains $outcome through a transient pre-acceptance read failure', async ({ read, error }) => {
    const f = fixture();
    const address = { jobId: JOB_ID, execution: 1 };
    const signal = new AbortController();
    vi.spyOn(f.registry, 'getSignal').mockReturnValue(signal.signal);
    const retry = createDeferred<void>();
    vi.spyOn(f.finisherTime, 'sleep').mockImplementation(() => retry.promise);
    let unavailable = false;
    let observedOwner = false;
    const observeRead = () => {
      if (unavailable) {
        observedOwner = f.executionFinisher.owns(address);
        throw new Error('transient outcome read failure');
      }
    };
    const readStatus = f.store.readStatus.bind(f.store);
    const readLaunch = f.store.readLaunchProjection.bind(f.store);
    const readSpy =
      read === 'readStatus'
        ? vi.spyOn(f.store, 'readStatus').mockImplementation((id) => {
            observeRead();
            return readStatus(id);
          })
        : vi.spyOn(f.store, 'readLaunchProjection').mockImplementation((id) => {
            observeRead();
            return readLaunch(id);
          });
    f.execute.mockImplementation(async function* () {
      unavailable = true;
      if (error !== null) throw error;
      yield {
        kind: 'terminal',
        terminal: { content: 'original provider result', outcome: { kind: 'completed' }, durationMs: 7 },
        diagnostics: {},
      };
    });
    const releaseStates: string[] = [];
    const release = f.admission.releaseLaunch.bind(f.admission);
    vi.spyOn(f.admission, 'releaseLaunch').mockImplementation((permit) => {
      releaseStates.push(f.executionFinisher.state(address).kind);
      return release(permit);
    });
    try {
      await f.launch();
      await vi.waitFor(() => expect(f.executionFinisher.status(address)).toMatchObject({ stage: 'accept' }));
      expect(observedOwner).toBe(true);
      expect(f.executionFinisher.state(address).kind).toBe('unaccepted');
      expect(f.orchestrator.holdsLocalAppServerExecution(JOB_ID, 1)).toBe(true);
      expect(f.admission.reservationFor(JOB_ID)).not.toBeNull();
      expect(f.registry.has(JOB_ID, 1)).toBe(true);
      expect(releaseStates).toEqual([]);

      signal.abort();
      unavailable = false;
      retry.resolve();
      await f.completed;
      await f.executionFinisher.finish(address);
      const state = f.executionFinisher.state(address);
      expect(state.kind).toBe('ended');
      if (state.kind !== 'ended') throw new Error('Expected execution to end.');
      if (error instanceof CliBusyError || error instanceof ProviderHostUnserviceableError) {
        expect(state.accepted.terminal.outcome).toMatchObject({ kind: 'failed' });
        if (state.accepted.terminal.outcome.kind !== 'failed') throw new Error('Expected the original fault citation.');
        const cause = f.db
          .prepare("SELECT json_extract(CAST(body AS TEXT), '$.message') AS message FROM events WHERE seq = ?")
          .get(state.accepted.terminal.outcome.causeRef.seq);
        expect(cause).toEqual({ message: error.message });
      } else if (error instanceof AbortError) {
        expect(state.accepted.terminal.outcome).toEqual({ kind: 'aborted', reason: 'signal_abort' });
      } else if (error !== null) {
        expect(state.accepted.terminal.outcome).toEqual({
          kind: 'job_fault',
          fault: { kind: 'wrapper_crashed', cause: { message: error.message } },
        });
      } else {
        expect(state.accepted.terminal).toEqual({
          content: 'original provider result',
          outcome: { kind: 'completed' },
          durationMs: 7,
        });
      }
      const rows = f.db.prepare('SELECT type FROM events').all() as Array<{ type: string }>;
      expect(rows.filter((row) => row.type === 'job.execution.outcome.accepted')).toHaveLength(1);
      expect(rows.filter((row) => row.type === 'job.execution.ended')).toHaveLength(1);
      expect(releaseStates).toHaveLength(1);
      expect(releaseStates[0]).not.toBe('unaccepted');
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.admission.reservationFor(JOB_ID)).toBeNull();
      expect(f.orchestrator.holdsLocalAppServerExecution(JOB_ID, 1)).toBe(false);
    } finally {
      unavailable = false;
      readSpy.mockRestore();
      retry.resolve();
      await f.executionFinisher.dispose();
    }
  });

  it('retries terminal metadata reads while retaining an explicitly supplied outcome', async () => {
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
    const address = { jobId: JOB_ID, execution: 1 };
    const terminal = { content: 'original result', durationMs: 7, outcome: { kind: 'completed' as const } };
    vi.spyOn(f.store, 'readStatus').mockImplementationOnce(() => {
      expect(f.executionFinisher.owns(address)).toBe(true);
      throw new Error('transient terminal metadata failure');
    });
    const seq = await f.orchestrator.writeJobTerminal(JOB_ID, 1, terminal, 'completed');
    await f.executionFinisher.finish(address);
    expect(f.executionFinisher.state(address)).toMatchObject({
      kind: 'ended',
      causeRef: { seq },
      accepted: { terminal },
    });
    const rows = f.db.prepare('SELECT type FROM events').all() as Array<{ type: string }>;
    expect(rows.filter((row) => row.type === 'job.execution.outcome.accepted')).toHaveLength(1);
    expect(rows.filter((row) => row.type === 'job.execution.ended')).toHaveLength(1);
    await f.executionFinisher.dispose();
  });

  it('preserves a queued shutdown outcome when its duration read fails', async () => {
    const f = fixture();
    const getEnv = f.runtime.env.get.bind(f.runtime.env);
    vi.spyOn(f.runtime.env, 'get').mockImplementation((key) => (key === 'CORAL_MAX_WORKERS' ? '1' : getEnv(key)));
    const blocker = f.admission.requestLaunch(
      'blocker',
      'codex',
      { kind: 'provider-session', id: 'blocker' },
      'default',
    );
    if (blocker === 'queue_full' || blocker.type !== 'immediate') throw new Error('Expected a blocking permit.');
    await expect(f.launch()).resolves.toMatchObject({ status: 'queued' });
    const address = { jobId: JOB_ID, execution: 1 };
    const retry = createDeferred<void>();
    vi.spyOn(f.finisherTime, 'sleep').mockImplementation(() => retry.promise);
    vi.spyOn(f.store, 'readLaunchProjection').mockImplementationOnce(() => {
      throw new Error('transient queue duration failure');
    });
    try {
      f.registry.abort([JOB_ID]);
      await vi.waitFor(() => expect(f.executionFinisher.status(address)).toMatchObject({ stage: 'accept' }));
      expect(f.executionFinisher.owns(address)).toBe(true);
      expect(f.sessions.readById(JOB_ID)?.open).toBe(true);
      retry.resolve();
      await vi.waitFor(() => expect(f.executionFinisher.state(address).kind).toBe('ended'));
      expect(f.executionFinisher.state(address)).toMatchObject({
        accepted: { terminal: { outcome: { kind: 'aborted', reason: 'queue_shutdown' } } },
      });
      const rows = f.db.prepare('SELECT type FROM events').all() as Array<{ type: string }>;
      expect(rows.filter((row) => row.type === 'job.execution.outcome.accepted')).toHaveLength(1);
      expect(rows.filter((row) => row.type === 'job.execution.ended')).toHaveLength(1);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.orchestrator.holdsLocalAppServerExecution(JOB_ID, 1)).toBe(false);
    } finally {
      retry.resolve();
      await f.executionFinisher.dispose();
      f.admission.releaseLaunch(blocker.permit);
    }
  });

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

  it('refuses a running predecessor with the busy code and no embedded command', async () => {
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
      message: expect.not.stringContaining('coral-cli'),
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
      message: expect.not.stringContaining('coral-cli'),
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
