import { backendLog } from '#src/infra/backend-log.js';
import { createCoordinatorJobSettlementRefusalRecorder } from '#src/coordinator/services/recovery/index.js';
import { coordinatorJobRecoverySource } from '#src/coordinator/services/recovery/coordinator-job-source.js';
import type { SettlementRefusalRecorder } from '#src/jobs/contracts/admission.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { RecoveryContainment } from '#src/recovery/containment.js';
import { COORDINATOR_JOB_RECOVERY_BOUNDARY } from '#src/recovery/source-registry.js';
import { formatWaitTerminal } from '#src/cli/format/wait.js';
import { formatJobDetail } from '#src/cli/format/jobs.js';
import { ConversationReadError } from '#src/jobs/conversation/contracts.js';
import { expect, it, vi } from 'vitest';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { appendProviderTerminalInCommit } from '#src/coordinator/services/terminal-materializer.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { JobStore } from '#src/jobs/store.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { executionHarness, EXECUTION_JOB_ID as jobId } from '#tests/helpers/job-executions.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

it.each([false, true])(
  'waits for finishing and run-task release (delayed permit observation: %s), then fences late #1 cleanup',
  async (delayedPermit) => {
    const h = executionHarness();
    const runtime = new SimulationRuntime();
    const eventBus = new TypedEventBus();
    const store = new JobStore('tests', runtime, h.ctx.bodyCodec, {
      db: h.db,
      providers: h.ctx.providers,
      reducers: h.ctx.reducers,
      eventBus,
    });
    const conversations = new ConversationManager(
      '/project',
      runtime,
      (cb) => store.commit(cb),
      h.db,
    ).forExecutionOwner();
    const first = conversations.prepare({
      jobId,
      binding: TEST_CODEX_BINDING,
      name: 'local',
      cwd: fixtureCanonicalWorkDir('/project'),
      projectRoot: '/project',
      backendNamespace: 'tests',
    });
    const admission = new LaunchCoordinator({ runtime });
    const registry = new AbortRegistry();
    const ended = [createDeferred<void>(), createDeferred<void>()];
    eventBus.on('job:completed', (event) => ended[event.execution - 1].resolve());
    const released = [createDeferred<void>(), createDeferred<void>()];
    const release = admission.releaseLaunch.bind(admission);
    let releaseCount = 0;
    const firstReleaseStarted = createDeferred<void>();
    const reservationFor = admission.reservationFor.bind(admission);
    let heldReservation: ReturnType<LaunchCoordinator['reservationFor']> = null;
    admission.reservationFor = (id) => heldReservation ?? reservationFor(id);
    admission.releaseLaunch = (permit) => {
      const index = releaseCount++;
      const reservation = reservationFor(permit.jobId);
      const result = release(permit);
      if (index === 0 && delayedPermit) {
        heldReservation = reservation;
        firstReleaseStarted.resolve();
      } else released[index]?.resolve();
      return result;
    };
    const firstFinishing = createDeferred<void>();
    const settleFirst = createDeferred<void>();
    let waits = 0;
    vi.spyOn(runtime.time, 'sleep').mockImplementation(async () => {
      expect(h.events().filter((event) => event.type === 'job.execution.requested')).toHaveLength(1);
      settleFirst.resolve();
      if (delayedPermit && waits++ === 0) {
        await firstReleaseStarted.promise;
        return;
      }
      if (heldReservation !== null) {
        heldReservation = null;
        released[0].resolve();
      }
      await released[0].promise;
    });
    const secondStarted = createDeferred<void>();
    const secondTerminal = createDeferred<void>();
    let turns = 0;
    const provider = {
      name: 'codex',
      envelope: TEST_CODEX_BINDING,
      appServer: {},
      artifacts: { kind: 'none', reason: 'fixture' },
      compareIdentity: () => ({ ok: true }),
      decodeContinuity: () => ({ ok: true, value: undefined }),
      readiness: async () => ({ ok: true }),
      prepareExecution: () => ({
        kind: 'app-server',
        hostSpec: {},
        execute: async function* () {
          turns++;
          if (turns === 2) {
            secondStarted.resolve();
            await secondTerminal.promise;
          }
          yield {
            kind: 'terminal',
            terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
            diagnostics: {},
          };
        },
      }),
    } as unknown as BoundProvider;
    const finisher = new ExecutionFinisher({
      time: { sleep: async () => {} },
      commit: (cb) => store.commit(cb),
      read: (address) => readExecutionFinishingState(h.db, address, store),
      quiesce: async (address) => {
        if (address.execution === 1) {
          firstFinishing.resolve();
          await settleFirst.promise;
        }
        return true;
      },
      retentionAction: async () => ({ attempt: 0, handles: [] }),
      settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
    });
    const orchestrator = new LaunchOrchestrator({
      runtime,
      progressStore: store,
      conversationManager: conversations,
      abortRegistry: registry,
      launchAdmission: admission,
      providerOperationBinding: admission,
      durableSpawner: admission,
      providerRegistry: {} as never,
      backendNamespace: 'tests',
      bundleHash: 'tests',
      coordinatorCommit: (cb) => store.commit(cb),
      settlementRefusalRecorder: { record: () => true },
      terminalMaterializer: { appendProviderTerminalInCommit },
      executionFinisher: finisher,
    });
    try {
      expect(
        await orchestrator.launchExecution(
          provider,
          first,
          {
            action: 'exec',
            jobId,
            prompt: 'first',
            cwd: fixtureCanonicalWorkDir('/project'),
            coralEnv: {},
            bypassPermissions: false,
          },
          {
            owner: { kind: 'workflow', id: 'workflow-owner' },
            parentWorkflowJobId: 'workflow-owner',
            workflowSlotId: 'slot',
            mintProtectedEnv: () => ({}),
          },
        ),
      ).toMatchObject({ status: 'running', jobId });
      await firstFinishing.promise;
      const predecessor = conversations.readById(jobId)!;
      expect(predecessor.finishing).toBe(true);
      expect(
        await orchestrator.launchExecution(
          provider,
          predecessor,
          {
            action: 'resume',
            jobId,
            prompt: 'second',
            cwd: fixtureCanonicalWorkDir('/project'),
            coralEnv: {},
            bypassPermissions: false,
          },
          {
            owner: { kind: 'workflow', id: 'workflow-owner' },
            parentWorkflowJobId: 'workflow-owner',
            workflowSlotId: 'slot',
            mintProtectedEnv: () => ({}),
          },
        ),
      ).toMatchObject({ status: 'running', jobId });
      await secondStarted.promise;
      const signal = registry.getSignal(jobId, 2);
      expect(orchestrator.holdsLocalAppServerExecution(jobId, 2)).toBe(true);
      orchestrator.releaseProviderOperationLocalState({ kind: 'job-local', jobId, execution: 1, pool: 'default' });
      expect(orchestrator.holdsLocalAppServerExecution(jobId, 2)).toBe(true);
      expect(registry.getSignal(jobId, 2)).toBe(signal);
      expect(registry.abort([jobId])).toMatchObject({ aborted: [jobId] });
      expect(signal?.aborted).toBe(true);
      secondTerminal.resolve();
      await Promise.all([ended[1].promise, released[1].promise]);
    } finally {
      secondTerminal.resolve();
      heldReservation = null;
      await finisher.dispose();
      h.db.close();
    }
  },
);

it.each([
  ['missing', 'The saved conversation record is missing', 'provider-session'],
  ['newline-path', 'The saved conversation record is missing', 'provider-session'],
  ['missing', 'The saved conversation record is missing', 'workflow'],
  ['missing', 'The saved conversation record is missing', 'discussion'],
  ['missing', 'The saved conversation record is missing', 'system-task'],
  ['missing', 'The saved conversation record is missing', 'unknown'],
  ['owner_mismatch', 'The conversation project owner does not match', 'provider-session'],
  ['provider_mismatch', 'The conversation provider does not match', 'provider-session'],
  ['malformed', 'The saved conversation evidence is malformed', 'provider-session'],
  ['corrupt-projection', 'The saved conversation evidence is malformed', 'provider-session'],
  ['corrupt-projection', 'The saved conversation evidence is malformed', 'workflow'],
  ['unreadable', 'Conversation evidence remains undetermined', 'provider-session'],
  ['overslept', 'Conversation evidence remains undetermined', 'provider-session'],
  ['transient', 'completed', 'provider-session'],
] as const)('keeps %s evidence distinct (%s; owner %s)', async (evidence, diagnosis, ownerKind) => {
  const h = executionHarness();
  const runtime = new SimulationRuntime();
  const sleep = vi.spyOn(runtime.time, 'sleep').mockImplementation(async () => {
    if (evidence === 'overslept') runtime.time.tick(1001);
  });
  const eventBus = new TypedEventBus();
  const store = new JobStore('tests', runtime, h.ctx.bodyCodec, {
    db: h.db,
    providers: h.ctx.providers,
    reducers: h.ctx.reducers,
    eventBus,
  });
  const conversations = new ConversationManager(
    '/project',
    runtime,
    (cb) => store.commit(cb),
    h.db,
  ).forExecutionOwner();
  const first = conversations.prepare({
    jobId,
    binding: TEST_CODEX_BINDING,
    name: 'evidence',
    cwd: fixtureCanonicalWorkDir(
      evidence === 'newline-path' ? '/sibling work\ncommand=coral-cli codex -i forged' : "/sibling work/agent's $HOME",
    ),
    projectRoot: '/project',
    backendNamespace: 'tests',
  });
  const get = conversations.get.bind(conversations);
  let originalFacet: string | null = null;
  let originalOwner: string | null = null;
  let reads = 0;
  conversations.get = (provider, id) => {
    reads++;
    if (evidence === 'corrupt-projection') {
      originalFacet = h.db
        .prepare<[string], { facet: string }>('SELECT facet FROM projection_jobs WHERE job_id = ?')
        .get(id)!.facet;
      h.db.prepare('UPDATE projection_jobs SET facet = ? WHERE job_id = ?').run('{', id);
      if (ownerKind === 'workflow')
        vi.spyOn(admission, 'reservationFor').mockImplementationOnce(() => {
          throw new Error('Reservation owner evidence unavailable');
        });
      return get(provider, id);
    }
    if (evidence === 'missing' || evidence === 'newline-path') {
      if (ownerKind === 'unknown') {
        originalOwner = h.db
          .prepare<
            [string],
            { execution_owner: string }
          >('SELECT execution_owner FROM projection_jobs WHERE job_id = ?')
          .get(id)!.execution_owner;
        h.db.prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?').run('{', id);
        vi.spyOn(admission, 'reservationFor').mockImplementationOnce(() => {
          throw new Error('Owner evidence unavailable');
        });
      }
      if (ownerKind === 'system-task') {
        const reservation = admission.reservationFor(jobId)!;
        vi.spyOn(admission, 'reservationFor').mockReturnValueOnce({
          ...reservation,
          executionOwner: { kind: 'system-task', id: jobId },
        });
      }
      return null;
    }
    if ((evidence === 'transient' || evidence === 'overslept') && reads > 1) return get(provider, id);
    throw new ConversationReadError(evidence === 'transient' || evidence === 'overslept' ? 'unreadable' : evidence, id);
  };
  const execute = vi.fn(async function* () {
    yield {
      kind: 'terminal',
      terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
      diagnostics: {},
    };
  });
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
  const finished = createDeferred<void>();
  const finisher = new ExecutionFinisher({
    time: { sleep: async () => {} },
    commit: (cb) => store.commit(cb),
    read: (address) => readExecutionFinishingState(h.db, address, store),
    quiesce: async () => true,
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  const accept = finisher.accept.bind(finisher);
  vi.spyOn(finisher, 'accept').mockImplementation((...args) => {
    if (originalFacet !== null)
      h.db.prepare('UPDATE projection_jobs SET facet = ? WHERE job_id = ?').run(originalFacet, jobId);
    if (originalOwner !== null)
      h.db.prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?').run(originalOwner, jobId);
    return accept(...args);
  });
  const admission = new LaunchCoordinator({ runtime });
  const release = admission.releaseLaunch.bind(admission);
  admission.releaseLaunch = (permit) => {
    const result = release(permit);
    finished.resolve();
    return result;
  };
  const orchestrator = new LaunchOrchestrator({
    runtime,
    progressStore: store,
    conversationManager: conversations,
    abortRegistry: new AbortRegistry(),
    launchAdmission: admission,
    providerOperationBinding: admission,
    durableSpawner: admission,
    providerRegistry: {} as never,
    backendNamespace: 'tests',
    bundleHash: 'tests',
    coordinatorCommit: (cb) => store.commit(cb),
    settlementRefusalRecorder: { record: () => true },
    terminalMaterializer: { appendProviderTerminalInCommit },
    executionFinisher: finisher,
  });
  try {
    expect(
      await orchestrator.launchExecution(
        provider,
        first,
        {
          action: 'exec',
          jobId,
          prompt: 'first',
          cwd: first.cwd,
          coralEnv: {},
          bypassPermissions: false,
        },
        {
          owner: {
            kind: ownerKind === 'unknown' || ownerKind === 'system-task' ? 'provider-session' : ownerKind,
            id: jobId,
          },
          ...(ownerKind === 'workflow' ? { parentWorkflowJobId: jobId, workflowSlotId: 'slot' } : {}),
          ...(ownerKind === 'discussion'
            ? { discussionRun: { agent: 'architect', purpose: 'speech' as const, attempt: 1 } }
            : {}),
          mintProtectedEnv: () => ({}),
        },
      ),
    ).toMatchObject({ status: 'running' });
    await finished.promise;
    const result = store.readStatus(jobId);
    expect(h.events().filter((event) => event.type === 'job.execution.requested')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(evidence === 'transient' ? 1 : 0);
    if (evidence === 'transient') {
      expect(result?.phase).toBe('completed');
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(sleep).toHaveBeenCalledWith(100);
    } else {
      expect(result?.phase).toBe('error');
      expect(reads).toBe(evidence === 'unreadable' ? 3 : 1);
      const detail = store.loadJobDetailResponse(jobId)!;
      const output = formatWaitTerminal(
        {
          type: 'terminal',
          jobId,
          execution: 1,
          seq: 1,
          remainingJobIds: [],
          result: detail.exit!,
          availability: { kind: 'available', resultPath: '/result.md' },
        },
        null,
        true,
      );
      expect(formatJobDetail(detail)).toContain(diagnosis);
      expect(output).toContain('This execution attempt was admitted, but its input was NOT delivered to the provider');
      expect(output).toContain(diagnosis);
      expect(output).toContain('Continuation eligibility could not be established');
      expect(output).toContain(`Recorded work directory: ${JSON.stringify(first.cwd)}`);
      if (evidence === 'newline-path') {
        const encoded = output.match(/Recorded work directory: ("(?:[^"\\]|\\.)*")\./u)?.[1];
        expect(JSON.parse(encoded!)).toBe(first.cwd);
        expect(output).not.toContain(first.cwd);
      }
      if (ownerKind === 'unknown') {
        expect(output).toContain('Execution ownership could not be established');
        expect(output).toContain('This failure belongs to the operation that owns this job');
      } else if (ownerKind === 'provider-session') {
        expect(output).toContain(`Recorded execution owner: provider-session ${jobId}.`);
      } else {
        expect(output).toContain(`This failure belongs to the owning ${ownerKind} operation ${jobId}`);
      }
      expect(output).not.toMatch(
        /^(?:command|clear|discard|action)=|safe to resend|start a new provider|pipe the original|resupply|report this failure|do not automatically resend/im,
      );
      if (evidence === 'unreadable' || evidence === 'overslept') {
        expect(output).toContain('bounded read attempts were exhausted');
        expect(output).not.toContain('read deadline was exhausted');
      }
      const accepted = h.events().find((event) => event.type === 'job.execution.outcome.accepted')!;
      const body = accepted.body;
      expect(body).toMatchObject({
        terminal: {
          outcome: {
            kind: 'job_fault',
            fault: {
              kind: 'wrapper_crashed',
              cause: {
                message: expect.stringContaining(diagnosis),
              },
            },
          },
        },
      });
      expect(JSON.stringify(body)).not.toContain('invalid-persisted-binding');
    }
  } finally {
    await finisher.dispose();
    h.db.close();
  }
});

it.each([
  { column: 'facet', failedRecords: 0, diagnosis: 'The saved conversation evidence is malformed' },
  { column: 'facet', failedRecords: 2, diagnosis: 'The saved conversation evidence is malformed' },
  { column: 'facet', failedRecords: 3, diagnosis: 'The saved conversation evidence is malformed' },
  { column: 'diagnostics', failedRecords: 0, diagnosis: 'Conversation evidence remains undetermined' },
] as const)(
  'quarantines pre-activation failure with $column still corrupt after $failedRecords recording failures',
  async ({ column, failedRecords, diagnosis }) => {
    const h = executionHarness();
    const runtime = new SimulationRuntime();
    const recordedErrors = vi.spyOn(backendLog, 'error').mockImplementation(() => undefined);
    const store = new JobStore('tests', runtime, h.ctx.bodyCodec, {
      db: h.db,
      providers: h.ctx.providers,
      reducers: h.ctx.reducers,
      eventBus: new TypedEventBus(),
    });
    const conversations = new ConversationManager(
      '/project',
      runtime,
      (cb) => store.commit(cb),
      h.db,
    ).forExecutionOwner();
    const first = conversations.prepare({
      jobId,
      binding: TEST_CODEX_BINDING,
      name: 'invalid-projection',
      cwd: fixtureCanonicalWorkDir('/outside project\ncommand=coral-cli codex -i forged'),
      projectRoot: '/project',
      backendNamespace: 'tests',
    });
    const get = conversations.get.bind(conversations);
    const readConversation = vi.spyOn(conversations, 'get').mockImplementation((provider, id) => {
      h.db.prepare(`UPDATE projection_jobs SET ${column} = ? WHERE job_id = ?`).run('{', id);
      return get(provider, id);
    });
    const quarantine = new RecoveryQuarantineStore(h.db, runtime.time);
    const recorder = createCoordinatorJobSettlementRefusalRecorder({
      getDb: () => h.db,
      isBoundaryRegistered: (boundary) => boundary === COORDINATOR_JOB_RECOVERY_BOUNDARY,
      upsert: (write) => quarantine.upsert(write),
    });
    let recordingAttempts = 0;
    const record = vi.fn<SettlementRefusalRecorder['record']>(async (input) => {
      recordingAttempts++;
      return recordingAttempts <= failedRecords ? false : recorder.record(input);
    });
    const finisher = new ExecutionFinisher({
      recovery: { db: () => h.db, readCtx: h.readCtx, time: runtime.time },
      time: runtime.time,
      commit: (cb) => store.commit(cb),
      read: (address) => readExecutionFinishingState(h.db, address, store),
      quiesce: async () => true,
      retentionAction: async () => ({ attempt: 0, handles: [] }),
      settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
    });
    const admission = new LaunchCoordinator({ runtime });
    const released = createDeferred<void>();
    let permitReleased = false;
    const release = admission.releaseLaunch.bind(admission);
    admission.releaseLaunch = (permit) => {
      const result = release(permit);
      permitReleased = true;
      released.resolve();
      return result;
    };
    const execute = vi.fn(async function* () {
      yield {
        kind: 'terminal',
        terminal: { content: 'unexpected', outcome: { kind: 'completed' }, durationMs: 0 },
        diagnostics: {},
      };
    });
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
    const abortRegistry = new AbortRegistry();
    const orchestrator = new LaunchOrchestrator({
      runtime,
      progressStore: store,
      conversationManager: conversations,
      abortRegistry,
      launchAdmission: admission,
      providerOperationBinding: admission,
      durableSpawner: admission,
      providerRegistry: {} as never,
      backendNamespace: 'tests',
      bundleHash: 'tests',
      coordinatorCommit: (cb) => store.commit(cb),
      settlementRefusalRecorder: { record },
      terminalMaterializer: { appendProviderTerminalInCommit },
      executionFinisher: finisher,
    });
    const finalizeFailure = vi.spyOn(
      orchestrator as unknown as { handleProviderJobError(...args: unknown[]): Promise<unknown> },
      'handleProviderJobError',
    );
    const before = runtime.time.now();
    try {
      expect(
        await orchestrator.launchExecution(
          provider,
          first,
          {
            action: 'exec',
            jobId,
            prompt: 'first',
            cwd: first.cwd,
            coralEnv: {},
            bypassPermissions: false,
          },
          { owner: { kind: 'provider-session', id: jobId }, mintProtectedEnv: () => ({}) },
        ),
      ).toMatchObject({ status: 'running' });
      for (let turn = 0; turn <= 10 && !permitReleased; turn++) {
        await flushMicrotasks(100);
        if (!permitReleased) runtime.time.tick(100);
      }
      expect(permitReleased, 'the corrupt projection must not keep the launch permit beyond bounded quarantine').toBe(
        true,
      );
      await released.promise;
      expect(h.db.prepare(`SELECT ${column} AS value FROM projection_jobs WHERE job_id = ?`).get(jobId)).toEqual({
        value: '{',
      });
      expect(() => store.readStatus(jobId)).toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(readConversation).toHaveBeenCalledTimes(column === 'facet' ? 1 : 3);
      expect(record).toHaveBeenCalledTimes(Math.min(failedRecords + 1, 3));
      expect(recordedErrors).toHaveBeenCalledTimes(failedRecords);
      expect(await finalizeFailure.mock.results[0].value).toMatchObject({
        kind: 'settlement-refused',
        cause: 'terminal-persist-failed',
        quarantine: failedRecords === 3 ? 'recording-failed' : 'recorded',
      });
      const entry = quarantine.readEntry(COORDINATOR_JOB_RECOVERY_BOUNDARY, jobId);
      if (failedRecords === 3) {
        expect(entry).toBeNull();
        const hydrate = vi.fn((raw) => raw);
        const recovery = await RecoveryContainment.each(coordinatorJobRecoverySource(h.db), {
          signal: new AbortController().signal,
          quarantine,
          processLocalCleanup: { kind: 'not-required' },
          hydrate,
          requiredObligations: () => [],
          settle: () => ({
            kind: 'deferred',
            authoritativeSource: { kind: 'unchanged-and-still-enumerable' },
            detail: 'The original request remains available for recovery.',
          }),
          onFault: (fault) => ({ kind: 'fatal', error: fault.error }),
        });
        expect(recovery.deferred).toBe(1);
        expect(hydrate).toHaveBeenCalledWith(
          expect.objectContaining({
            projection: expect.objectContaining({ [column]: '{' }),
            statusEvents: expect.arrayContaining([expect.objectContaining({ type: 'job.execution.requested' })]),
          }),
        );
      } else {
        expect(entry).toMatchObject({
          state: 'active',
          stage: 'settle',
          subject: { key: jobId, revision: { kind: 'fingerprint' } },
          remedy: { kind: 'external-repair' },
        });
        expect(entry!.errorMessage).toContain(diagnosis);
        expect(entry!.errorMessage).toContain('This execution attempt was admitted, but its input was NOT delivered');
        expect(entry!.errorMessage).toContain(`Recorded work directory: ${JSON.stringify(first.cwd)}`);
        expect(entry!.errorMessage).not.toMatch(/^(?:command|clear|discard|action)=/m);
      }
      expect(h.events().filter((event) => event.type === 'job.execution.requested')).toHaveLength(1);
      expect(
        h
          .events()
          .filter((event) => event.type === 'job.execution.outcome.accepted' || event.type === 'job.execution.ended'),
      ).toEqual([]);
      expect(readExecutionFinishingState(h.db, { jobId, execution: 1 }, store).kind).toBe('unaccepted');
      expect(admission.reservationFor(jobId)).toBeNull();
      expect(orchestrator.holdsLocalAppServerExecution(jobId, 1)).toBe(false);
      expect(abortRegistry.getSignal(jobId, 1)).toBeNull();
      expect(finisher.owns({ jobId, execution: 1 })).toBe(false);
      expect(finisher.status({ jobId, execution: 1 })).toBeNull();
      expect(runtime.time.now() - before).toBeLessThanOrEqual(1_000);
    } finally {
      await finisher.dispose();
      vi.restoreAllMocks();
      h.db.close();
    }
  },
);
