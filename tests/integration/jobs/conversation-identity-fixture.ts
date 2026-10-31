import { expect } from 'vitest';
import { dirname, join } from 'node:path';

import { ExecutionService } from '#src/coordinator/execution-service.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createRecoveryCoordinator } from '#src/coordinator/services/recovery/index.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { JobStore } from '#src/jobs/store.js';
import { LifecycleReactor } from '#src/jobs/conversation/lifecycle-reactor.js';
import { managed } from '#src/providers/capability.js';
import type { ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { runPostCommitConsumers, type CommitEventsFn } from '#src/store/append.js';
import { decodeStoredBody } from '#src/store/body-codec.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { executionHarness } from '#tests/helpers/job-executions.js';
import { createTestJobJournalDeps, observeTestTerminalExports } from '#tests/helpers/job-journal-deps.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_CLAUDE_ACCESS, TEST_CODEX_ACCESS, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { toProviderDefinition, type StandaloneTestProvider } from '#tests/helpers/scripted-provider.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

export function conversationIdentityFixture(
  options: {
    stall?: boolean;
    managedArtifacts?: boolean;
    failOnResume?: boolean | ((request: ProviderRequest) => boolean);
  } = {},
) {
  const runtime = new SimulationRuntime();
  const epochDir = join(runtime.paths.coral.store.dbDir, 'epoch-1');
  runtime.storage.mkdirSync(epochDir, { recursive: true });
  runtime.storage.writeFileSync(join(epochDir, 'store.db'), 'fixture');
  runtime.storage.writeFileSync(join(epochDir, '.lock'), '');
  runtime.storage.writeFileSync(
    join(epochDir, 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'absent' },
      publishedAt: '2026-10-22T00:00:00.000Z',
      build: {
        version: '0.10.22',
        buildSetId: '10000000-0000-4000-8000-000000000099',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        storeFormatFingerprint: 'sha256:' + 'a'.repeat(64),
      },
    }),
  );
  const projectRoot = fixtureCanonicalWorkDir('/workspace');
  runtime.storage.mkdirSync(projectRoot, { recursive: true });
  const journal = executionHarness(discussRegistry, workflowRegistry);
  const eventBus = new TypedEventBus();
  let acceptanceBlocked = false;
  const exportTerminalResults = observeTestTerminalExports(() => store);
  const store: JobStore = new JobStore('identity-test', runtime, createEventBodyCodec(), {
    db: journal.db,
    reducers: journal.ctx.reducers,
    providers: permissiveProviderLookupPort,
    eventBus,
    observer: (appended) =>
      runPostCommitConsumers(appended, [
        exportTerminalResults,
        (events) => reactor.observe(events),
        (events) => finisher.observeCommitted(events),
      ]),
    readAdmissionStatus: (jobId) => finisher.admissionStatus(jobId),
    beforeAppend: (event) => {
      if (acceptanceBlocked && event.type === 'job.execution.outcome.accepted')
        throw new Error('Outcome acceptance storage unavailable');
    },
  });
  let admission = new LaunchCoordinator({ runtime });
  const journalDeps = createTestJobJournalDeps(store, runtime);
  const providers = new ProviderRegistry();
  const retentionAbort = new AbortController();
  const reactor = new LifecycleReactor({
    db: () => journal.db,
    readCtx: journal.readCtx,
    providers,
    runtime,
    time: runtime.time,
    commitEvents: (write) => commit(write),
    signal: retentionAbort.signal,
  });
  let loseRequestAcknowledgement = false;
  let failCommit = false;
  const commit: CommitEventsFn = (write) => {
    if (failCommit) {
      failCommit = false;
      throw new Error('Request commit failed before persistence');
    }
    const appended = journalDeps.coordinatorCommit(write);
    if (loseRequestAcknowledgement && appended.some((event) => event.type === 'job.execution.requested')) {
      loseRequestAcknowledgement = false;
      throw new Error('Committed request acknowledgement lost');
    }
    return appended;
  };
  const createFinisher = () =>
    new ExecutionFinisher({
      recovery: { db: () => journal.db, readCtx: journal.readCtx, time: runtime.time },
      time: runtime.time,
      commit,
      read: (address) => readExecutionFinishingState(journal.db, address, journal.readCtx),
      quiesce: async ({ jobId }) => admission.reservationFor(jobId) === null,
      retentionAction: (address) => reactor.retentionAction(address),
      settleRetention: (address, action) => reactor.settleRetention(address, action),
    });
  let finisher = createFinisher();
  const requests: ProviderRequest[] = [];
  const nativePath = (jobId: string, provider = 'codex') =>
    provider === 'claude'
      ? `${TEST_CLAUDE_ACCESS.projectsRoot}/workspace/thread-${jobId}.jsonl`
      : `${TEST_CODEX_ACCESS.home}/sessions/rollout-thread-${jobId}.jsonl`;
  const restored: string[] = [];
  const discarded: string[][] = [];
  const completions = new Map<string, () => void>();
  const finishRequested = new Set<string>();
  for (const name of ['codex', 'claude']) {
    const provider: StandaloneTestProvider = {
      name,
      ...(options.managedArtifacts
        ? {
            artifactCapability: managed({
              discardArtifacts: async ({ handles }) => {
                discarded.push([...handles]);
                for (const handle of handles) runtime.storage.unlinkSync(handle);
                return { kind: 'discarded' };
              },
              locateArtifact: ({ conversationRef }) => nativePath(conversationRef.slice('thread-'.length), name),
            }),
          }
        : {}),
      execute: async function* (request, providerRuntime): AsyncIterable<ProviderEventBody> {
        requests.push({ ...request, coralEnv: { ...request.coralEnv } });
        yield {
          kind: 'continuity',
          conversationRef: request.conversationRef ?? `thread-${request.jobId}`,
          resumable: true,
          providerContinuity: null,
        };
        if (options.managedArtifacts) {
          const path = nativePath(request.jobId, name);
          const previous = request.action === 'resume' ? runtime.storage.readFileSync(path, 'utf-8') : '';
          if (request.action === 'resume') restored.push(previous);
          runtime.storage.mkdirSync(dirname(path), { recursive: true });
          runtime.storage.writeFileSync(path, `${previous}${request.prompt}\n`);
          yield {
            kind: 'artifact_handle',
            handle: path,
            identity: { kind: 'fixture-conversation', jobId: request.jobId },
          };
        }
        await providerRuntime.runCli({ command: 'identity-fixture', args: [] });
        if (options.stall) {
          await new Promise<void>((resolve) => {
            completions.set(request.jobId, resolve);
            if (providerRuntime.signal.aborted || finishRequested.delete(request.jobId)) resolve();
            else providerRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          completions.delete(request.jobId);
        }
        const failOnResume =
          request.action === 'resume' &&
          (typeof options.failOnResume === 'function' ? options.failOnResume(request) : options.failOnResume === true);
        yield {
          kind: 'terminal',
          terminal: {
            content: request.prompt,
            durationMs: 1,
            ...(options.managedArtifacts ? { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25 } } : {}),
            outcome: providerRuntime.signal.aborted
              ? { kind: 'aborted', reason: 'signal_abort' }
              : failOnResume
                ? { kind: 'provider_exit', code: 7, note: 'replacement failed' }
                : { kind: 'completed' },
          },
          diagnostics: {},
        };
      },
    };
    providers.register(toProviderDefinition(provider)!);
  }
  const ctx: InvocationContext = {
    projectRoot,
    pluginRoot: '/plugin',
    coralEnv: {},
    principal: testProjectPrincipal(projectRoot),
    providerScope: TEST_PROVIDER_SCOPE,
  };
  const createService = (context: InvocationContext = ctx) =>
    new ExecutionService(context, {
      ...journalDeps,
      runtime,
      progressStore: store,
      executionFinisher: finisher,
      coordinatorCommit: commit,
      launchCoordinator: admission,
      runningWorkflowJobs: new Set(),
      backendNamespace: 'identity-test',
      bundleHash: 'identity-test',
      eventBus,
      providerRegistry: providers,
      pluginRegistry: { discoverPluginRoot: () => null },
      childPrincipalRegistry: testChildPrincipalRegistry(runtime.ids, { db: journal.db }),
      settlementRefusalRecorder: { record: () => true },
    });

  let service = createService();

  async function drive<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    const result = work.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    void result.catch(() => undefined);
    for (let turn = 0; turn < 100 && !settled; turn += 1) {
      await flushMicrotasks(100);
      runtime.time.tick(100);
    }
    expect(settled, 'identity scenario must settle within ten seconds of virtual time').toBe(true);
    return result;
  }

  function events(jobId: string) {
    return journal.db
      .prepare<[string], { stream_id: string; stream_kind: 'job'; type: string; body: Uint8Array }>(
        "SELECT stream_id, stream_kind, type, body FROM events WHERE stream_kind = 'job' AND stream_id = ? ORDER BY seq",
      )
      .all(jobId)
      .map((row) => ({ ...row, body: decodeStoredBody(row, journal.readCtx) }));
  }

  function assertIdentity(jobId: string, ordinals: number[]) {
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const history = events(jobId);
    expect(history.filter((event) => event.type === 'job.opened')).toHaveLength(1);
    for (const type of ['job.execution.requested', 'job.execution.ended']) {
      expect(history.filter((event) => event.type === type).map((event) => event.body)).toEqual(
        ordinals.map((execution) => expect.objectContaining({ execution })),
      );
    }
    for (const event of history) {
      expect(event.stream_id).toBe(jobId);
      expect(event.body).not.toHaveProperty('executionId');
      expect(event.body).not.toHaveProperty('id');
    }
    const launches = requests.filter((request) => request.jobId === jobId);
    expect(launches).toHaveLength(ordinals.length);
    expect(launches.map((request) => request.action)).toEqual(ordinals.map((n) => (n === 1 ? 'exec' : 'resume')));
    for (const request of launches) {
      expect(request.coralEnv.CORAL_JOB_ID).toBe(jobId);
      expect(request).not.toHaveProperty('executionId');
      expect(request).not.toHaveProperty('sessionId');
      if (request.action === 'resume') expect(request.conversationRef).toBe(`thread-${jobId}`);
    }
    expect(store.readStatus(jobId)).toMatchObject({ jobId, execution: ordinals.at(-1) });
  }

  async function dispose() {
    const jobIds = store.listJobIds();
    service.abort(jobIds);
    try {
      await drive(Promise.all(jobIds.map((jobId) => service.waitForJobTerminal(jobId, 10_000))));
    } finally {
      retentionAbort.abort();
      await finisher.dispose();
      journal.db.close();
    }
  }

  return {
    ...journal,
    runtime,
    store,
    get admission() {
      return admission;
    },
    get finisher() {
      return finisher;
    },
    service,
    serviceForContext: createService,
    restartCoordinator: () => {
      service = createService();
      return service;
    },
    restartProcess: async () => {
      await finisher.dispose();
      admission = new LaunchCoordinator({ runtime });
      finisher = createFinisher();
      service = createService();
      const log = () => undefined;
      const recovery = createRecoveryCoordinator(
        {
          progressStore: store,
          runtime,
          runtimeState: { setLaunchFenceActive: () => undefined },
          eventBus,
          getRecoveryService: () => service,
          createInvocationContext: () => ctx,
          log,
          startupOwnership: admission,
        },
        null,
      );
      try {
        const result = await drive(
          recovery.runStartupRecovery({
            runtime,
            progressStore: store,
            getRecoveryService: () => service,
            createInvocationContext: () => ctx,
            signal: new AbortController().signal,
            log,
            coordinatorCommit: commit,
          }),
        );
        expect(result.kind).toBe('complete');
      } finally {
        await recovery.teardown();
      }
      return service;
    },
    failNextCommit: () => {
      failCommit = true;
    },
    blockAcceptance: (blocked: boolean) => {
      acceptanceBlocked = blocked;
    },
    loseNextRequestCommitAcknowledgement: () => {
      loseRequestAcknowledgement = true;
    },
    providers,
    ctx,
    commit,
    requests,
    nativePath,
    restored,
    discarded,
    finish: (jobId: string) => {
      const complete = completions.get(jobId);
      if (complete === undefined) finishRequested.add(jobId);
      else complete();
    },
    drive,
    events,
    assertIdentity,
    dispose,
  };
}
