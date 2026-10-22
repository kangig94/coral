import { vi } from 'vitest';

import { discussRegistry, toJournalInput } from '#src/discuss/event-registry.js';
import { makeEvent, type DiscussEventKind, type DiscussPayloadByKind } from '#src/discuss/events.js';
import { decideSessionCreate } from '#src/discuss/state-machine.js';
import { createDiscussContextRegistry } from '#src/discuss/shell/live-registry.js';
import { createDiscussRuntime } from '#src/discuss/shell/runtime-services.js';
import type { DiscussService } from '#src/discuss/shell/types.js';
import { readSessionEvents } from '#src/discuss/shell/persistence.js';
import type { DiscussionRunDescriptor } from '#src/jobs/discussion-run.js';
import { jobExecutionRequestedBodySchema } from '#src/jobs/launch.js';
import { decodeBody, type StoreReadContext } from '#src/store/body-codec.js';
import type { Database } from '#src/store/db.js';
import { JobStore } from '#src/jobs/store.js';
import { appendJobExecutionEnded, appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { registerBuiltInProviders } from '#src/providers/bootstrap.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { executionHarness, EXECUTION_NOW, openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function readLatestExecutionRequest(
  db: Database,
  jobId: string,
  ctx: StoreReadContext,
): { jobId: string; requestedSeq: number; request: ReturnType<typeof jobExecutionRequestedBodySchema.parse> } | null {
  const row = db
    .prepare<
      [string],
      { seq: number; type: string; stream_kind: 'job'; body: Uint8Array }
    >("SELECT seq, type, stream_kind, body FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' ORDER BY seq DESC LIMIT 1")
    .get(jobId);
  return row === undefined
    ? null
    : { jobId, requestedSeq: row.seq, request: decodeBody(row, jobExecutionRequestedBodySchema, ctx) };
}

export const DISCUSSION_ID = 'turn-executions';
export const PARTICIPANT_JOBS = {
  alpha: '10000000-0000-4000-8000-000000000001',
  beta: '10000000-0000-4000-8000-000000000002',
} as const;

export function discussionExecutionFixture() {
  const journal = executionHarness(discussRegistry);
  const runtime = new SimulationRuntime({ epochMs: Date.parse(EXECUTION_NOW) });
  const projectRoot = fixtureCanonicalWorkDir('/workspace');
  const pluginRoot = '/plugin';
  runtime.storage.mkdirSync(projectRoot, { recursive: true });
  const providers = new ProviderRegistry();
  registerBuiltInProviders(providers);
  const store = new JobStore('tests', runtime, journal.ctx.bodyCodec, {
    db: journal.db,
    reducers: journal.ctx.reducers,
    providers: journal.ctx.providers,
  });
  const invocation: InvocationContext = {
    projectRoot,
    pluginRoot,
    coralEnv: {},
    providerScope: TEST_PROVIDER_SCOPE,
    principal: testProjectPrincipal(projectRoot),
  };
  const created = decideSessionCreate(
    {
      topic: 'Discussion turns',
      min_bid_delay_ms: 0,
      agents: Object.keys(PARTICIPANT_JOBS).map((name) => ({ name, persona: name, participation: 'required' })),
    },
    { sessionId: DISCUSSION_ID, projectRoot, topic: 'Discussion turns' },
    1,
    EXECUTION_NOW,
    {
      providerScope: TEST_PROVIDER_SCOPE,
      agentExecution: {
        alpha: { manual: false, provider: 'codex', model: 'gpt-5' },
        beta: { manual: false, provider: 'codex', model: 'gpt-5' },
      },
    },
  );
  if (!created.ok) throw new Error(created.error);
  journal.append(...created.value.map((event) => toJournalInput(event)));

  function request(jobId: string, discussionRun: DiscussionRunDescriptor, input = 'turn'): number {
    const previous = readLatestExecutionRequest(journal.db, jobId, journal.readCtx);
    const execution = (previous?.request.execution ?? 0) + 1;
    const opened = openedJob({
      owner: { kind: 'discussion', id: DISCUSSION_ID },
      conversation: {
        provider: 'codex',
        binding: TEST_CODEX_BINDING,
        cwd: projectRoot,
        name: discussionRun.agent,
        model: 'gpt-5',
        bypassPermissions: true,
        retention: 'retain',
      },
    });
    const requested = requestedExecution(execution, {
      discussionRun,
      input,
      pool: 'discuss',
      originatingClientMessageId: undefined,
    });
    const inputs = previous === null ? [opened, requested] : [requested];
    journal.append(...inputs.map((event) => ({ ...event, stream: { kind: 'job' as const, id: jobId } })));
    return execution;
  }

  function complete(jobId: string, execution: number): void {
    journal.commit((c) => {
      const accepted = appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution,
        terminal: { content: `result #${execution}`, outcome: { kind: 'completed' }, durationMs: 1 },
      });
      appendJobExecutionEnded(c, { jobId, execution, causeRef: accepted });
      return undefined;
    });
  }

  function activate(jobId: string, execution: number): void {
    journal.append({
      type: 'job.execution.started',
      stream: { kind: 'job', id: jobId },
      body: {
        execution,
        transport: 'app-server',
        startedAt: EXECUTION_NOW,
        providerMeta: { provider: 'codex', leaseState: 'waiting' },
      },
    });
  }

  const service: DiscussService = {
    start: vi.fn<DiscussService['start']>(async (_provider, input) => {
      const descriptor = input.discussionRun!;
      const jobId = PARTICIPANT_JOBS[descriptor.agent as keyof typeof PARTICIPANT_JOBS];
      activate(jobId, request(jobId, descriptor, input.prompt));
      return {
        kind: 'provider-session',
        status: 'running',
        jobId,
        requestedSeq: readLatestExecutionRequest(journal.db, jobId, journal.readCtx)!.requestedSeq,
        epochKey: 'test-epoch',
      };
    }),
    resume: vi.fn<DiscussService['resume']>(async (_provider, input) => {
      activate(input.jobId, request(input.jobId, input.discussionRun!, input.prompt));
      return {
        kind: 'provider-session',
        status: 'running',
        jobId: input.jobId,
        requestedSeq: readLatestExecutionRequest(journal.db, input.jobId, journal.readCtx)!.requestedSeq,
        epochKey: 'test-epoch',
      };
    }),
    waitStreamOnce: vi.fn<DiscussService['waitStreamOnce']>(async (jobId) => {
      const execution = readLatestExecutionRequest(journal.db, jobId, journal.readCtx)!.request.execution;
      complete(jobId, execution);
      return { content: `result #${execution}`, continuity: null };
    }),
  };
  const registry = createDiscussContextRegistry();
  function reopen() {
    registry.contexts.clear();
    return createDiscussRuntime({
      world: {
        identity: { pluginRoot },
        discussRegistry: registry,
        resolveProjectSource: (root) => root,
        providerRegistry: providers,
        eventBus: { emit: () => true },
      },
      runtime,
      getProgressStore: () => store,
      getExecutionService: () => service,
    });
  }
  const services = reopen();
  const context = services.getDiscussContext(invocation);
  function append<K extends DiscussEventKind>(kind: K, payload: DiscussPayloadByKind[K]) {
    const snapshot = context.store.load(DISCUSSION_ID)!;
    const event = makeEvent(
      DISCUSSION_ID,
      projectRoot,
      snapshot.state.topic,
      snapshot.lastAppliedSeq + 1,
      kind,
      EXECUTION_NOW,
      payload,
    );
    journal.append({
      type: `discuss.${kind}`,
      stream: { kind: 'discuss', id: DISCUSSION_ID },
      project: projectRoot,
      refs: { discussSessionId: DISCUSSION_ID },
      body: { ...payload, sourceSeq: event.seq },
      tsOverride: event.ts,
    });
    return event;
  }
  return {
    journal,
    runtime,
    store,
    invocation,
    services,
    context,
    service,
    request,
    complete,
    append,
    reopen,
    events: () => readSessionEvents(context, DISCUSSION_ID),
    snapshot: () => context.store.load(DISCUSSION_ID)!,
    close: () => {
      registry.contexts.clear();
      journal.db.close();
    },
  };
}
