import { expect } from 'vitest';

import { ExecutionService } from '#src/coordinator/execution-service.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { JobStore } from '#src/jobs/store.js';
import type { ProviderEventBody, ProviderRequest } from '#src/providers/contract.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { CommitEventsFn } from '#src/store/append.js';
import { decodeStoredBody } from '#src/store/body-codec.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { executionHarness } from '#tests/helpers/job-executions.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { toProviderDefinition, type StandaloneTestProvider } from '#tests/helpers/scripted-provider.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

export function conversationIdentityFixture(options: { stall?: boolean } = {}) {
  const runtime = new SimulationRuntime();
  const projectRoot = fixtureCanonicalWorkDir('/workspace');
  runtime.storage.mkdirSync(projectRoot, { recursive: true });
  const journal = executionHarness(discussRegistry, workflowRegistry);
  const eventBus = new TypedEventBus();
  const store = new JobStore('identity-test', runtime, createEventBodyCodec(), {
    db: journal.db,
    reducers: journal.ctx.reducers,
    providers: permissiveProviderLookupPort,
    eventBus,
  });
  const admission = new LaunchCoordinator({ runtime });
  const journalDeps = createTestJobJournalDeps(store, runtime);
  const commit: CommitEventsFn = (write) => {
    const appended = journalDeps.coordinatorCommit(write);
    finisher.observeCommitted(appended);
    return appended;
  };
  const finisher = new ExecutionFinisher({
    time: runtime.time,
    commit,
    read: (address) => readExecutionFinishingState(journal.db, address, journal.readCtx),
    quiesce: async ({ jobId }) => admission.reservationFor(jobId) === null,
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'provider_declares_none' }),
  });
  const requests: ProviderRequest[] = [];
  const providers = new ProviderRegistry();
  for (const name of ['codex', 'claude']) {
    const provider: StandaloneTestProvider = {
      name,
      execute: async function* (request, providerRuntime): AsyncIterable<ProviderEventBody> {
        requests.push({ ...request, coralEnv: { ...request.coralEnv } });
        yield {
          kind: 'continuity',
          conversationRef: request.conversationRef ?? `thread-${request.jobId}`,
          resumable: true,
          providerContinuity: null,
        };
        await providerRuntime.runCli({ command: 'identity-fixture', args: [] });
        if (options.stall) {
          await new Promise<void>((resolve) => {
            if (providerRuntime.signal.aborted) resolve();
            else providerRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        yield {
          kind: 'terminal',
          terminal: {
            content: request.prompt,
            durationMs: 1,
            outcome: providerRuntime.signal.aborted
              ? { kind: 'aborted', reason: 'signal_abort' }
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
  const service = new ExecutionService(ctx, {
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
      journal.db.close();
    }
  }

  return {
    ...journal,
    runtime,
    store,
    service,
    providers,
    ctx,
    commit,
    requests,
    drive,
    events,
    assertIdentity,
    dispose,
  };
}
