import { expect, it } from 'vitest';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { recordProviderTerminal } from '#src/coordinator/services/terminal-materializer.js';
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

it('keeps #2 local execution and handoff state when #1 cleanup is delivered late', async () => {
  const h = executionHarness();
  const runtime = new SimulationRuntime();
  const eventBus = new TypedEventBus();
  const store = new JobStore('tests', runtime, h.ctx.bodyCodec,
    { db: h.db, providers: h.ctx.providers, reducers: h.ctx.reducers, eventBus });
  const conversations = new ConversationManager('/project', runtime, cb => store.commit(cb), h.db);
  const first = conversations.prepare({ jobId, binding: TEST_CODEX_BINDING, name: 'local',
    cwd: fixtureCanonicalWorkDir('/project'), projectRoot: '/project', backendNamespace: 'tests' });
  const admission = new LaunchCoordinator({ runtime });
  const registry = new AbortRegistry();
  const ended = [createDeferred<void>(), createDeferred<void>()];
  eventBus.on('job:completed', event => ended[event.execution - 1].resolve());
  const released = [createDeferred<void>(), createDeferred<void>()];
  const release = admission.releaseLaunch.bind(admission);
  let releaseCount = 0;
  admission.releaseLaunch = permit => {
    const result = release(permit);
    released[releaseCount++]?.resolve();
    return result;
  };
  const secondStarted = createDeferred<void>();
  const secondTerminal = createDeferred<void>();
  let turns = 0;
  const provider = {
    name: 'codex', envelope: TEST_CODEX_BINDING, appServer: {}, artifacts: { kind: 'none', reason: 'fixture' },
    compareIdentity: () => ({ ok: true }), decodeContinuity: () => ({ ok: true, value: undefined }),
    readiness: async () => ({ ok: true }),
    prepareExecution: () => ({ kind: 'app-server', hostSpec: {}, execute: async function* () {
      turns++;
      if (turns === 2) { secondStarted.resolve(); await secondTerminal.promise; }
      yield { kind: 'terminal', terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 }, diagnostics: {} };
    } }),
  } as unknown as BoundProvider;
  const finisher = new ExecutionFinisher({ time: { sleep: async () => {} }, commit: cb => store.commit(cb),
    read: address => readExecutionFinishingState(h.db, address, store), quiesce: async () => true,
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }) });
  const orchestrator = new LaunchOrchestrator({ runtime, progressStore: store, conversationManager: conversations,
    abortRegistry: registry, launchAdmission: admission, providerOperationBinding: admission, durableSpawner: admission,
    providerRegistry: {} as never, backendNamespace: 'tests', bundleHash: 'tests', coordinatorCommit: cb => store.commit(cb),
    settlementRefusalRecorder: { record: () => true }, terminalMaterializer: { recordProviderTerminal }, executionFinisher: finisher });
  try {
    expect(await orchestrator.launchExecution(provider, first, { action: 'exec', jobId, prompt: 'first', cwd: '/project',
      coralEnv: {}, bypassPermissions: false }, { owner: { kind: 'workflow', id: 'workflow-owner' }, parentWorkflowJobId: 'workflow-owner',
        workflowSlotId: 'slot', mintProtectedEnv: () => ({}) }))
      .toMatchObject({ status: 'running', jobId });
    await Promise.all([ended[0].promise, released[0].promise]);
    const predecessor = conversations.readById(jobId)!;
    expect(await orchestrator.launchExecution(provider, predecessor, { action: 'resume', jobId, prompt: 'second', cwd: '/project',
      coralEnv: {}, bypassPermissions: false }, { owner: { kind: 'workflow', id: 'workflow-owner' }, parentWorkflowJobId: 'workflow-owner',
        workflowSlotId: 'slot', mintProtectedEnv: () => ({}) }))
      .toMatchObject({ status: 'running', jobId });
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
    h.db.close();
  }
});
